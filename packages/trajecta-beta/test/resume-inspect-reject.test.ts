import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TrajectaStore } from "../../../src/store.ts";
import type { TransferPacket } from "../../../src/types.ts";
import { buildLocalResumeEnvelope, envelopePayload } from "../src/envelope.ts";
import type { LocalResumeEnvelopeV1 } from "../src/contracts.ts";
import { TargetRegistry } from "../src/target-registry.ts";
import { OperationJournal } from "../src/operation-journal.ts";
import { ReceiptStore } from "../src/receipt-store.ts";
import { observeWorkspace } from "../src/workspace.ts";
import { toKernelResumeInput, TrajectaKernelPort } from "../src/kernel-port.ts";
import { LocalResumeService } from "../src/resume-service.ts";
import { errorCode, finalizePacketBudget, validEnvelopeInput } from "./helpers.ts";

const createdAt = "2026-09-05T00:00:00.000Z";
const cloud = { kind: "cloud" as const, name: "ChatGPT fixture", session: "cloud:service" };

// Includes absent directories and every durable file's bytes, including locks.
function tree(directory: string): unknown {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).sort().map((name) => {
    const file = path.join(directory, name);
    return [name, fs.statSync(file).isDirectory() ? tree(file) : createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  });
}

function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-resume-service-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo"), stateRoot = path.join(root, "sdk"), kernelRoot = path.join(root, "kernel");
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.invalid/team/repo.git"]);
  let now = new Date(createdAt);
  const clock = () => now;
  const store = new TrajectaStore(kernelRoot, clock);
  const opened = store.open({ operationId: "operation:open", topic: "Local resume", goal: "Verify authorized resume", surface: cloud,
    initialBranch: { label: "adapter", purpose: "Prove rejection", cues: ["resume"], returnPoint: "Review receipt" } });
  store.capture({ operationId: "operation:handoff", workId: opened.work.id, expectedRevision: 1, surface: cloud,
    kind: "handoff", summary: "First plan", provenance: ["artifact:handoff"], nextAction: "Implement first plan", targetSurface: "local" });
  const stalePacket = store.transfer(opened.work.id, "resume", "local");
  const registry = new TargetRegistry({ stateRoot, clock });
  const target = registry.issue(observeWorkspace(cwd, stateRoot));
  store.capture({ operationId: "operation:advance", workId: opened.work.id, expectedRevision: 2, surface: cloud,
    kind: "decision", summary: "Current plan", provenance: ["artifact:current"], nextAction: "Implement current plan" });
  const currentPacket = store.transfer(opened.work.id, "resume", "local");
  const journal = new OperationJournal({ stateRoot, clock });
  const receipts = new ReceiptStore({ stateRoot });
  const kernel = new TrajectaKernelPort(store);
  const options = { stateRoot, cwd, kernel, registry, journal, receipts, clock };
  const service = new LocalResumeService(options);
  function save(packet: TransferPacket, operationId: string) {
    const envelope = buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: `envelope:${operationId.split(":")[1]}`,
      operationId, createdAt, expiresAt: target.expiresAt, target, packet });
    const file = path.join(root, `${operationId.split(":")[1]}.json`);
    fs.writeFileSync(file, JSON.stringify(envelope));
    return { file, envelope };
  }
  const stale = save(stalePacket, "operation:stale"), current = save(currentPacket, "operation:current");
  return { root, cwd, stateRoot, kernelRoot, store, registry, journal, receipts, kernel, options, service, target, stale, current,
    workId: opened.work.id, branchId: opened.work.activeBranchId!, clock, setNow: (value: string) => { now = new Date(value); } };
}

function rewrite(file: string, envelope: LocalResumeEnvelopeV1, change: (payload: Omit<LocalResumeEnvelopeV1, "integrity">) => void) {
  const payload = structuredClone(envelopePayload(envelope)); change(payload);
  const altered = buildLocalResumeEnvelope(payload);
  fs.writeFileSync(file, JSON.stringify(altered));
  return altered;
}

test("kernel projection uses only the fixed SDK WAL inputs", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  const expected = { operationId: "operation:fixture.kernel", workId: "work:fixture", expectedRevision: 7,
    surface: { kind: "local", name: "Trajecta Verified Resume SDK Beta", session: `local:${createHash("sha256").update(JSON.stringify("target:fixture")).digest("hex").slice(0, 32)}` },
    instruction: "Verify the exact local target." };
  assert.deepEqual(toKernelResumeInput(envelope), expected);
  envelope.target.capability = "capability:changed";
  envelope.target.workspace.repository = "/private/path";
  envelope.packet.cue = "Untrusted prompt";
  assert.deepEqual(toKernelResumeInput(envelope), expected);
  envelope.packet.work.nextAction = null;
  assert.equal(toKernelResumeInput(envelope).instruction, undefined);
});

test("stale inspection reports authorized revisions without changing any durable tree", (t) => {
  const f = fixture(t), before = [tree(f.kernelRoot), tree(f.stateRoot)];
  const inspection = f.service.inspectFile(f.stale.file);
  assert.deepEqual(inspection, { schema: "trajecta.local-resume-inspection/v1", envelopeId: "envelope:stale", operationId: "operation:stale",
    targetId: f.target.targetId, repository: "example.invalid/team/repo", workId: f.workId, branchId: f.branchId,
    expectedRevision: 2, currentRevision: 3, nextAction: "Implement first plan", provenance: ["artifact:handoff"] });
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], before);
  assert.equal(fs.existsSync(path.join(f.stateRoot, "locks")), false);
  assert.equal(fs.existsSync(path.join(f.stateRoot, "operations")), false);
  assert.equal(fs.existsSync(path.join(f.stateRoot, "receipts")), false);
  assert.ok(!JSON.stringify(inspection).includes(f.target.capability));
  assert.ok(!JSON.stringify(inspection).includes(f.root));
});

test("wrong capability fails before work lookup and discloses no live revision", async (t) => {
  const f = fixture(t);
  rewrite(f.stale.file, f.stale.envelope, (e) => { e.target.capability = "capability:wrong"; });
  let calls = 0;
  const kernel = { ...f.kernel, getWork: () => { calls++; throw new Error("work lookup must not happen"); }, history: f.kernel.history.bind(f.kernel), resume: f.kernel.resume.bind(f.kernel) };
  const service = new LocalResumeService({ ...f.options, kernel });
  const before = tree(f.kernelRoot);
  assert.throws(() => service.inspectFile(f.stale.file), errorCode("TARGET_MISMATCH"));
  await assert.rejects(service.resumeFile(f.stale.file, { accepted: true }), (error: any) => {
    assert.deepEqual(Object.keys(error).sort(), ["code", "name", "nextAction"]);
    return errorCode("TARGET_MISMATCH")(error);
  });
  assert.equal(calls, 0);
  assert.deepEqual(tree(f.kernelRoot), before);
  assert.equal(f.journal.lookup("operation:stale"), null);
  assert.equal(f.receipts.readBytes("operation:stale"), null);
});

for (const mismatch of ["expiry", "repository", "state-root", "git-branch"] as const) {
  test(`${mismatch} failure precedes kernel lookup and never reserves the target`, async (t) => {
    const f = fixture(t), before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
    let reads = 0;
    const kernel = { getWork: () => { reads++; throw new Error("unauthorized lookup"); }, history: f.kernel.history.bind(f.kernel), resume: f.kernel.resume.bind(f.kernel) };
    if (mismatch === "expiry") f.setNow(f.target.expiresAt);
    if (mismatch === "repository") execFileSync("git", ["-C", f.cwd, "remote", "set-url", "origin", "https://example.invalid/other/repo.git"]);
    if (mismatch === "git-branch") execFileSync("git", ["-C", f.cwd, "symbolic-ref", "HEAD", "refs/heads/other"]);
    const observe = mismatch === "state-root" ? (cwd: string, root: string) => ({ ...observeWorkspace(cwd, root), stateRootFingerprint: "a".repeat(64) }) : undefined;
    const service = new LocalResumeService({ ...f.options, kernel, observe });
    const code = mismatch === "expiry" ? "TARGET_EXPIRED" : mismatch === "git-branch" ? "BRANCH_MISMATCH" : "WORKSPACE_MISMATCH";
    assert.throws(() => service.inspectFile(f.stale.file), errorCode(code));
    await assert.rejects(service.resumeFile(f.stale.file, { accepted: true }), errorCode(code));
    assert.equal(reads, 0);
    assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
    assert.equal(f.journal.lookup("operation:stale"), null);
    assert.equal(f.receipts.readBytes("operation:stale"), null);
  });
}

test("stale resume commits one deterministic rejection before runtime acceptance", async (t) => {
  const f = fixture(t), before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
  const bytes = await f.service.resumeFile(f.stale.file, { accepted: false });
  const receipt = JSON.parse(bytes.toString());
  assert.equal(receipt.outcome, "rejected"); assert.equal(receipt.code, "REVISION_CONFLICT");
  assert.equal(receipt.expectedRevision, 2); assert.equal(receipt.observedRevisionBefore, 3); assert.equal(receipt.observedRevisionAfter, 3);
  const digest = f.stale.envelope.integrity.canonicalPayloadDigest;
  assert.equal(receipt.attemptDigest, digest);
  assert.equal(receipt.receiptId, `receipt:${createHash("sha256").update(`operation:stale:${digest}:rejected:REVISION_CONFLICT`).digest("hex").slice(0, 32)}`);
  const record = f.journal.lookup("operation:stale")!;
  assert.deepEqual(record.transitions.map((entry) => entry.state), ["created", "inspected", "receipt-committed"]);
  assert.equal(receipt.createdAt, record.transitions[1].observedAt);
  assert.equal(record.acceptance, null); assert.equal(record.kernelResult, null);
  assert.deepEqual(receipt.provenance, ["artifact:handoff"]);
  assert.deepEqual(receipt.evidence, f.stale.envelope.packet.recentDeltas.map((delta) => delta.id).sort());
  assert.deepEqual(f.service.receiptBytes("operation:stale"), bytes);
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
  f.registry.lookup(f.target);
});

test("active work branch mismatch commits equal observed revisions without consuming target", async (t) => {
  const f = fixture(t);
  f.store.capture({ operationId: "operation:new-branch", workId: f.workId, expectedRevision: 3, surface: cloud, kind: "branch_open", summary: "Another branch",
    branch: { label: "other", purpose: "Other work", cues: ["other"], returnPoint: "Review" } });
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
  assert.throws(() => f.service.inspectFile(f.current.file), errorCode("BRANCH_MISMATCH"));
  const receipt = JSON.parse((await f.service.resumeFile(f.current.file, { accepted: true })).toString());
  assert.equal(receipt.code, "BRANCH_MISMATCH");
  assert.equal(receipt.branchId, f.branchId);
  assert.equal(receipt.observedRevisionBefore, 4); assert.equal(receipt.observedRevisionAfter, 4);
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
  f.registry.lookup(f.target);
});

for (const accepted of [false]) {
  test(`current resume with accepted=${accepted} creates no operation or receipt`, async (t) => {
    const f = fixture(t), before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
    await assert.rejects(f.service.resumeFile(f.current.file, { accepted }), errorCode(accepted ? "CAPABILITY_UNAVAILABLE" : "USER_ACCEPTANCE_REQUIRED"));
    assert.equal(f.journal.lookup("operation:current"), null); assert.equal(f.receipts.readBytes("operation:current"), null);
    assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
  });
}

test("committed rejection replay returns exact bytes before expiry or revision checks", async (t) => {
  const f = fixture(t), original = await f.service.resumeFile(f.stale.file, { accepted: true });
  f.setNow("2026-09-06T00:00:00.000Z");
  fs.writeFileSync(f.stale.file, JSON.stringify(f.stale.envelope, null, 2));
  const kernel = { getWork: () => { throw new Error("replay cannot read work"); }, history: f.kernel.history.bind(f.kernel), resume: f.kernel.resume.bind(f.kernel) };
  const service = new LocalResumeService({ ...f.options, kernel, observe: () => { throw new Error("replay cannot observe workspace"); } });
  assert.deepEqual(await service.resumeFile(f.stale.file, { accepted: false }), original);
  assert.equal(fs.readdirSync(path.join(f.stateRoot, "receipts")).length, 1);
});

test("altered valid stale attempt conflicts before expiry and never creates a second receipt", async (t) => {
  const f = fixture(t); await f.service.resumeFile(f.stale.file, { accepted: true });
  const before = [tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))];
  rewrite(f.stale.file, f.stale.envelope, (e) => { e.packet.cue = "Changed attempt"; finalizePacketBudget(e.packet); });
  f.setNow("2026-09-06T00:00:00.000Z");
  await assert.rejects(f.service.resumeFile(f.stale.file, { accepted: true }), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))], before);
});

test("resume validates retained captured bytes when the file is replaced during writer acquisition", async (t) => {
  const f = fixture(t);
  const service = new LocalResumeService({ ...f.options, clock: () => {
    fs.writeFileSync(f.stale.file, JSON.stringify(f.current.envelope));
    return f.clock();
  } });
  const receipt = JSON.parse((await service.resumeFile(f.stale.file, { accepted: true })).toString());
  assert.equal(receipt.operationId, "operation:stale"); assert.equal(receipt.expectedRevision, 2);
  assert.equal(receipt.attemptDigest, f.stale.envelope.integrity.canonicalPayloadDigest);
});

test("nonlocal packets fail schema validation before expiry, lookup, or writer lock creation", async (t) => {
  const f = fixture(t);
  rewrite(f.stale.file, f.stale.envelope, (e) => { e.packet.intendedFor = "cloud"; finalizePacketBudget(e.packet); });
  f.setNow("2026-09-06T00:00:00.000Z");
  const before = [tree(f.kernelRoot), tree(f.stateRoot)];
  assert.throws(() => f.service.inspectFile(f.stale.file), errorCode("TARGET_MISMATCH"));
  await assert.rejects(f.service.resumeFile(f.stale.file, { accepted: true }), errorCode("TARGET_MISMATCH"));
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], before);
});

test("packet schema and intended destination are validated before integrity", async (t) => {
  const f = fixture(t);
  const altered = rewrite(f.stale.file, f.stale.envelope, (e) => { e.packet.intendedFor = "cloud"; finalizePacketBudget(e.packet); });
  altered.integrity.canonicalPayloadDigest = "0".repeat(64);
  fs.writeFileSync(f.stale.file, JSON.stringify(altered));
  assert.throws(() => f.service.inspectFile(f.stale.file), errorCode("TARGET_MISMATCH"));
  await assert.rejects(f.service.resumeFile(f.stale.file, { accepted: true }), errorCode("TARGET_MISMATCH"));
  assert.equal(fs.existsSync(path.join(f.stateRoot, "locks")), false);
});

test("schema-valid integrity failure precedes expiry and every live authorization check", async (t) => {
  const f = fixture(t), altered = structuredClone(f.stale.envelope);
  altered.packet.work.goal = `X${altered.packet.work.goal.slice(1)}`;
  fs.writeFileSync(f.stale.file, JSON.stringify(altered));
  f.setNow("2026-09-06T00:00:00.000Z");
  const before = [tree(f.kernelRoot), tree(f.stateRoot)];
  const service = new LocalResumeService({ ...f.options,
    clock: () => { throw new Error("Integrity must precede the clock and writer acquisition"); },
    observe: () => { throw new Error("Integrity must precede observation"); } });
  assert.throws(() => service.inspectFile(f.stale.file), errorCode("INTEGRITY_MISMATCH"));
  await assert.rejects(service.resumeFile(f.stale.file, { accepted: true }), errorCode("INTEGRITY_MISMATCH"));
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], before);
});

test("rejection creation time is the persisted inspected transition even with distinct clocks", async (t) => {
  const f = fixture(t);
  let tick = 0;
  const journal = new OperationJournal({ stateRoot: f.stateRoot, clock: () => new Date(Date.parse(createdAt) + tick++ * 1000) });
  const service = new LocalResumeService({ ...f.options, journal });
  const receipt = JSON.parse((await service.resumeFile(f.stale.file, { accepted: true })).toString());
  assert.equal(receipt.createdAt, "2026-09-05T00:00:01.000Z");
  assert.equal(receipt.createdAt, journal.lookup("operation:stale")!.transitions[1].observedAt);
});

test("inspection permits only a matching operation and digest reservation without changing durable bytes", (t) => {
  const f = fixture(t);
  f.registry.reserve(f.target, "operation:stale", f.stale.envelope.integrity.canonicalPayloadDigest);
  const before = [tree(f.kernelRoot), tree(f.stateRoot)];
  assert.equal(f.service.inspectFile(f.stale.file).currentRevision, 3);
  assert.throws(() => f.service.inspectFile(f.current.file), errorCode("TARGET_CONSUMED"));
  rewrite(f.stale.file, f.stale.envelope, (e) => { e.packet.cue = "Changed"; finalizePacketBudget(e.packet); });
  assert.throws(() => f.service.inspectFile(f.stale.file), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], before);
});

test("missing receipt lookup is read-only and fails boundedly", (t) => {
  const f = fixture(t), before = tree(f.stateRoot);
  assert.throws(() => f.service.receiptBytes("operation:absent"), errorCode("OPERATION_IN_DOUBT"));
  assert.deepEqual(tree(f.stateRoot), before);
});
