import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TrajectaStore } from "../../../src/store.ts";
import { buildLocalResumeEnvelope, deriveLocalResumeReceiptReferences, envelopePayload } from "../src/envelope.ts";
import type { LocalResumeEnvelopeV1, LocalResumeReceiptV1 } from "../src/contracts.ts";
import { canonicalJson } from "../src/canonical.ts";
import { TargetRegistry } from "../src/target-registry.ts";
import { OperationJournal } from "../src/operation-journal.ts";
import { ReceiptStore } from "../src/receipt-store.ts";
import { observeWorkspace, sha256 } from "../src/workspace.ts";
import { createLocalKernelPort, toKernelResumeInput, TrajectaKernelPort, type KernelResumeResult } from "../src/kernel-port.ts";
import { LocalResumeService, type LocalResumeServiceOptions } from "../src/resume-service.ts";
import { withWriterLock } from "../src/writer-lock.ts";
import { errorCode, finalizePacketBudget } from "./helpers.ts";

const instant = "2026-09-05T00:00:00.000Z";
const operationId = "operation:resume";
const surface = { kind: "cloud" as const, name: "Planner", session: "cloud:planner" };
const points = ["after-target-reserve", "after-kernel-resume", "after-receipt-commit", "after-target-consume"] as const;
function tree(root: string): unknown {
  return fs.existsSync(root) ? fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    return [name, fs.statSync(file).isDirectory() ? tree(file) : sha256(fs.readFileSync(file).toString())];
  }) : null;
}
function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-sdk-recovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo"), stateRoot = path.join(root, "sdk"), kernelRoot = path.join(stateRoot, "kernel");
  fs.mkdirSync(cwd); execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.invalid/team/repo.git"]);
  let now = new Date(instant);
  const clock = () => now;
  const store = new TrajectaStore(kernelRoot, clock);
  const opened = store.open({ operationId: "operation:open", topic: "Recovery", goal: "Resume exactly once", surface,
    initialBranch: { label: "sdk", purpose: "Recover", cues: ["resume"], returnPoint: "Check receipt" } });
  store.capture({ operationId: "operation:plan", workId: opened.work.id, expectedRevision: 1, surface, kind: "handoff", summary: "Plan ready", nextAction: "Continue exact work", provenance: ["artifact:plan"], targetSurface: "local" });
  const registry = new TargetRegistry({ stateRoot, clock });
  const target = registry.issue(observeWorkspace(cwd, stateRoot));
  const envelope = buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: "envelope:resume", operationId,
    createdAt: instant, expiresAt: target.expiresAt, target, packet: store.transfer(opened.work.id, "resume", "local") });
  const file = path.join(root, "handoff.json"); fs.writeFileSync(file, JSON.stringify(envelope));
  const journal = new OperationJournal({ stateRoot, clock }), receipts = new ReceiptStore({ stateRoot });
  const options = { stateRoot, cwd, registry, journal, receipts, clock, kernel: createLocalKernelPort(stateRoot, clock) };
  const service = (extra: Partial<LocalResumeServiceOptions> = {}) => new LocalResumeService({ ...options, kernel: createLocalKernelPort(stateRoot, clock), ...extra });
  const targetFile = path.join(stateRoot, "targets", `${sha256(target.targetId)}.journal`);
  const targetRecord = () => JSON.parse(fs.readFileSync(targetFile, "utf8").trim().split("\n").at(-1)!);
  const deltas = () => new TrajectaStore(kernelRoot, clock).history(opened.work.id).filter(d => d.operationId === `${operationId}.kernel`);
  return { root, cwd, stateRoot, kernelRoot, store, target, envelope, file, registry, journal, receipts, options, service, targetFile, targetRecord, deltas,
    workId: opened.work.id, clock, setNow: (value: string) => { now = new Date(value); }, expire: () => { now = new Date("2026-09-06T00:00:00.000Z"); } };
}

function boundedOversizedCurrent(f: ReturnType<typeof fixture>, operationId: string, variant: "full-work" | "near-receipt" | "historic-inactive-shape") {
  let current = f.store.getWork(f.workId);
  const branches = variant === "near-receipt" ? 8 : variant === "full-work" ? 12 : 0;
  for (let index = 0; index < branches; index++) {
    current = f.store.capture({ operationId: `operation:${operationId.split(":")[1]}-branch${index}`, workId: f.workId, expectedRevision: current.revision, surface,
      kind: "branch_open", summary: "Another branch", nextAction: "Continue exact work",
      branch: { label: `branch${index}`, purpose: "p".repeat(500), cues: ["c".repeat(500)], returnPoint: "r".repeat(500) } }).work;
  }
  if (variant === "historic-inactive-shape") {
    current = f.store.capture({ operationId: `operation:${operationId.split(":")[1]}-hidden`, workId: f.workId, expectedRevision: current.revision, surface,
      kind: "branch_open", summary: "Open a hidden historic branch", nextAction: "Park the historic branch",
      branch: { label: "historic", purpose: "small", cues: Array.from({ length: 21 }, () => "old"), returnPoint: "Return" } }).work;
    current = f.store.capture({ operationId: `operation:${operationId.split(":")[1]}-park`, workId: f.workId, expectedRevision: current.revision, surface,
      kind: "branch_park", summary: "Park historic branch", nextAction: "Open the small current branch", branchId: current.activeBranchId! }).work;
    current = f.store.capture({ operationId: `operation:${operationId.split(":")[1]}-current`, workId: f.workId, expectedRevision: current.revision, surface,
      kind: "branch_open", summary: "Current branch", nextAction: "Continue exact work",
      branch: { label: "current", purpose: "small", cues: ["current"], returnPoint: "Return" } }).work;
  }
  const packet = f.store.transfer(f.workId, "resume", "local");
  assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= 6_000);
  const envelope = buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: `envelope:${operationId.split(":")[1]}`,
    operationId, createdAt: instant, expiresAt: f.target.expiresAt, target: f.target, packet });
  const file = path.join(f.root, `${operationId.split(":")[1]}.json`); fs.writeFileSync(file, JSON.stringify(envelope));
  return { current, envelope, file };
}

function projectedKernelResult(f: ReturnType<typeof fixture>, envelope: LocalResumeEnvelopeV1): KernelResumeResult {
  const root = path.join(f.root, `projection-${envelope.operationId.split(":")[1]}`);
  fs.cpSync(f.kernelRoot, root, { recursive: true });
  try { return new TrajectaStore(root, f.clock).resume(toKernelResumeInput(envelope)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function acceptedReceipt(envelope: LocalResumeEnvelopeV1, createdAt: string): LocalResumeReceiptV1 {
  const attemptDigest = envelope.integrity.canonicalPayloadDigest;
  return {
    schema: "trajecta.local-resume-receipt/v1",
    receiptId: `receipt:${sha256(`${envelope.operationId}:${attemptDigest}:accepted:RESUMED`).slice(0, 32)}`,
    envelopeId: envelope.envelopeId,
    operationId: envelope.operationId,
    attemptDigest,
    outcome: "accepted",
    code: "RESUMED",
    targetId: envelope.target.targetId,
    repositoryFingerprint: envelope.target.workspace.repositoryFingerprint,
    stateRootFingerprint: envelope.target.workspace.stateRootFingerprint,
    workId: envelope.packet.work.id,
    branchId: envelope.packet.activeBranch!.id,
    packetId: envelope.packet.packetId,
    expectedRevision: envelope.packet.resume.expectedRevision,
    observedRevisionBefore: envelope.packet.resume.expectedRevision,
    observedRevisionAfter: envelope.packet.resume.expectedRevision + 1,
    ...deriveLocalResumeReceiptReferences(envelope.packet),
    createdAt,
  };
}

async function assertKernelSnapshotFitsButReceiptOverflows(f: ReturnType<typeof fixture>, envelope: LocalResumeEnvelopeV1): Promise<void> {
  const stateRoot = path.join(f.root, "admission-probe"), operationId = envelope.operationId;
  const journal = new OperationJournal({ stateRoot, clock: f.clock });
  const result = projectedKernelResult(f, envelope), receipt = acceptedReceipt(envelope, f.clock().toISOString());
  await withWriterLock({ stateRoot, operationId, clock: f.clock }, writer => {
    journal.open({ operationId, attemptDigest: envelope.integrity.canonicalPayloadDigest, envelopeId: envelope.envelopeId, targetId: envelope.target.targetId }, writer);
    journal.transition(operationId, "inspected", {}, writer);
    const beforeReceipt = journal.assertTransitionChainPersistable(operationId, [
      { state: "reserved", update: { acceptance: { source: "runtime-flag", observedAt: f.clock().toISOString() } } },
      { state: "kernel-resumed", update: { kernelResult: result } },
    ], writer);
    assert.ok(beforeReceipt.at(-1)! <= 16 * 1024, "kernel-resumed snapshot must fit before adding the receipt");
    assert.throws(() => journal.assertTransitionChainPersistable(operationId, [
      { state: "reserved", update: { acceptance: { source: "runtime-flag", observedAt: f.clock().toISOString() } } },
      { state: "kernel-resumed", update: { kernelResult: result } },
      { state: "receipt-committed", update: { receipt } },
      { state: "target-consumed", update: {} },
    ], writer), errorCode("OPERATION_CONFLICT"));
  });
}

for (const variant of ["full-work", "near-receipt", "historic-inactive-shape"] as const) test(`bounded ${variant} journal admission rejects before reserving or resuming work`, async t => {
  const f = fixture(t), operationId = `operation:journal-${variant}`;
  const candidate = boundedOversizedCurrent(f, operationId, variant);
  const packetBytes = Buffer.byteLength(JSON.stringify(candidate.envelope.packet), "utf8");
  assert.ok(packetBytes <= 6_000, "the transfer packet remains within the public 6 KiB envelope budget");
  if (variant === "full-work") assert.ok(Buffer.byteLength(JSON.stringify(candidate.current), "utf8") > 16 * 1024, "the complete live WorkItem exceeds the journal's 16 KiB durable JSON bound");
  if (variant === "near-receipt") await assertKernelSnapshotFitsButReceiptOverflows(f, candidate.envelope);
  if (variant === "historic-inactive-shape") {
    assert.ok(Buffer.byteLength(JSON.stringify(candidate.current), "utf8") <= 16 * 1024, "the inactive-branch incompatibility is structural, not a size overflow");
    assert.equal(candidate.current.branches.find(branch => branch.label === "historic")!.cues.length, 21);
    assert.ok(candidate.envelope.packet.activeBranch!.cues.length <= 20, "the transmitted active branch is valid while the hidden historic branch is not");
  }
  const kernelBefore = tree(f.kernelRoot), targetBefore = tree(path.join(f.stateRoot, "targets"));
  await assert.rejects(f.service().resumeFile(candidate.file, { accepted: true }), errorCode("OPERATION_CONFLICT"));
  assert.equal(f.store.getWork(f.workId).revision, candidate.current.revision);
  assert.equal(f.deltas().filter(delta => delta.operationId === `${operationId}.kernel`).length, 0);
  assert.equal(f.targetRecord().state, "issued"); assert.equal(f.receipts.readBytes(operationId), null);
  assert.deepEqual(tree(f.kernelRoot), kernelBefore); assert.deepEqual(tree(path.join(f.stateRoot, "targets")), targetBefore);
  const afterFirst = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets")), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))];
  await assert.rejects(f.service().resumeFile(candidate.file, { accepted: true }), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets")), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))], afterFirst);
});

test("a preexisting reserved oversized operation stays byte-identical before admission rejects", async t => {
  const f = fixture(t), operationId = "operation:journal-existing-reserved";
  const candidate = boundedOversizedCurrent(f, operationId, "full-work");
  const digest = candidate.envelope.integrity.canonicalPayloadDigest;
  await withWriterLock({ stateRoot: f.stateRoot, operationId, clock: f.clock }, writer => {
    f.journal.open({ operationId, attemptDigest: digest, envelopeId: candidate.envelope.envelopeId, targetId: candidate.envelope.target.targetId }, writer);
    f.journal.transition(operationId, "inspected", {}, writer);
    f.registry.reserve(candidate.envelope.target, operationId, digest, f.clock, candidate.envelope.expiresAt);
    f.journal.transition(operationId, "reserved", { acceptance: { source: "runtime-flag", observedAt: f.clock().toISOString() } }, writer);
  });
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets")), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))];
  await assert.rejects(f.service().resumeFile(candidate.file, { accepted: false }), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets")), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))], before);
  await assert.rejects(f.service().resumeFile(candidate.file, { accepted: false }), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets")), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts"))], before);
});

for (const deadline of ["target", "envelope"] as const) test(`final reservation rejects ${deadline} expiry reached while acquiring target lock`, async t => {
  const f = fixture(t);
  const payload = envelopePayload(f.envelope);
  if (deadline === "envelope") payload.expiresAt = "2026-09-05T00:01:00.000Z";
  const envelope = buildLocalResumeEnvelope(payload); fs.writeFileSync(f.file, JSON.stringify(envelope));
  const registry = new TargetRegistry({ stateRoot: f.stateRoot, clock: f.clock, onTargetLockAcquired: transition => {
    if (transition === "reserve") f.setNow(envelope.expiresAt);
  } });
  await assert.rejects(f.service({ registry }).resumeFile(f.file, { accepted: true }), errorCode("TARGET_EXPIRED"));
  assert.equal(f.targetRecord().state, "issued"); assert.equal(f.deltas().length, 0);
  assert.equal(f.store.getWork(f.workId).revision, 2); assert.equal(f.receipts.readBytes(operationId), null);
  assert.equal(f.journal.lookup(operationId)?.acceptance, null);
});

for (const deadline of ["target", "envelope"] as const) test(`early reserved target rechecks ${deadline} expiry under lock before persisting new acceptance`, async t => {
  const f = fixture(t);
  const payload = envelopePayload(f.envelope);
  if (deadline === "envelope") payload.expiresAt = "2026-09-05T00:01:00.000Z";
  const envelope = buildLocalResumeEnvelope(payload); fs.writeFileSync(f.file, JSON.stringify(envelope));
  const interruptedRegistry = new TargetRegistry({ stateRoot: f.stateRoot, clock: f.clock, onAfterJournalAppend: () => { throw new Error("target boundary"); } });
  await assert.rejects(f.service({ registry: interruptedRegistry }).resumeFile(f.file, { accepted: true }), /target boundary/);
  assert.equal(f.journal.lookup(operationId)?.state, "inspected"); assert.equal(f.journal.lookup(operationId)?.acceptance, null);
  const targetBefore = tree(path.join(f.stateRoot, "targets"));
  const registry = new TargetRegistry({ stateRoot: f.stateRoot, clock: f.clock, onTargetLockAcquired: transition => {
    if (transition === "reserve") f.setNow(envelope.expiresAt);
  } });
  await assert.rejects(f.service({ registry }).resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required"); assert.equal(f.journal.lookup(operationId)?.acceptance, null);
  assert.equal(f.deltas().length, 0); assert.equal(f.receipts.readBytes(operationId), null);
  assert.deepEqual(tree(path.join(f.stateRoot, "targets")), targetBefore);
});

test("exact orphan reservation is quarantined once without inferring missing acceptance", async t => {
  const f = fixture(t);
  await assert.rejects(f.service({ fault: p => { if (p === "after-target-reserve") throw new Error("fault"); } }).resumeFile(f.file, { accepted: true }), /fault/);
  fs.unlinkSync(path.join(f.stateRoot, "operations", `${sha256(operationId)}.json`)); f.expire();
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  const record = f.journal.lookup(operationId)!;
  assert.deepEqual(record.transitions.map(t => t.state), ["created", "inspection-required"]);
  assert.equal(record.acceptance, null); assert.equal(record.kernelResult, null); assert.equal(record.receipt, null);
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
  const quarantined = [tree(f.kernelRoot), tree(f.stateRoot)];
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], quarantined);
});

test("orphan reservation with the same operation but altered digest remains a conflict", async t => {
  const f = fixture(t);
  f.registry.reserve(f.target, operationId, f.envelope.integrity.canonicalPayloadDigest);
  const payload = envelopePayload(f.envelope); payload.packet.cue = "Changed"; finalizePacketBudget(payload.packet);
  fs.writeFileSync(f.file, JSON.stringify(buildLocalResumeEnvelope(payload))); f.expire();
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_CONFLICT"));
  assert.equal(f.journal.lookup(operationId), null); assert.equal(f.receipts.readBytes(operationId), null);
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
});

test("reservation belonging to another operation is ordinary occupied target without quarantine", async t => {
  const f = fixture(t); f.registry.reserve(f.target, "operation:another", "a".repeat(64));
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("TARGET_CONSUMED"));
  assert.equal(f.journal.lookup(operationId), null); assert.equal(f.receipts.readBytes(operationId), null); assert.equal(f.deltas().length, 0);
});

test("orphan reservation classifier exposes only exact ownership and performs zero writes", t => {
  const f = fixture(t), digest = f.envelope.integrity.canonicalPayloadDigest;
  const issued = tree(f.stateRoot); assert.equal(f.registry.hasReservation(f.target, operationId, digest), false); assert.deepEqual(tree(f.stateRoot), issued);
  f.registry.reserve(f.target, operationId, digest); f.expire();
  const reserved = tree(f.stateRoot);
  assert.equal(f.registry.hasReservation(f.target, operationId, digest), true);
  assert.equal(f.registry.hasReservation(f.target, "operation:another", digest), false);
  assert.throws(() => f.registry.hasReservation(f.target, operationId, "b".repeat(64)), errorCode("OPERATION_CONFLICT"));
  assert.throws(() => f.registry.hasReservation({ ...f.target, capability: "capability:wrong" }, operationId, digest), errorCode("TARGET_MISMATCH"));
  assert.deepEqual(tree(f.stateRoot), reserved);
  f.registry.consume(f.target, operationId, "receipt:one"); const consumed = tree(f.stateRoot);
  assert.equal(f.registry.hasReservation(f.target, operationId, digest), false); assert.deepEqual(tree(f.stateRoot), consumed);
});

test("reservation rejects invalid authorization deadlines before changing an issued target", t => {
  const f = fixture(t), before = tree(f.stateRoot);
  for (const deadline of ["bad", "2026-09-05", "2026-09-05T00:15:00+00:00"]) {
    assert.throws(() => f.registry.reserve(f.target, operationId, f.envelope.integrity.canonicalPayloadDigest, f.clock, deadline), errorCode("OPERATION_CONFLICT"));
  }
  assert.deepEqual(tree(f.stateRoot), before);
});

test("registry samples its default clock under lock and exact reservation retry never samples again", t => {
  const f = fixture(t), digest = f.envelope.integrity.canonicalPayloadDigest;
  const registry = new TargetRegistry({ stateRoot: f.stateRoot, clock: f.clock, onTargetLockAcquired: transition => { if (transition === "reserve") f.expire(); } });
  assert.throws(() => registry.reserve(f.target, operationId, digest), errorCode("TARGET_EXPIRED"));
  assert.equal(f.targetRecord().state, "issued");
  // Explicit historical Date remains a supported deterministic injection.
  f.registry.reserve(f.target, operationId, digest, new Date(instant));
  const before = tree(f.stateRoot);
  f.registry.reserve(f.target, operationId, digest, () => assert.fail("exact reserved replay cannot resample time"), instant);
  assert.deepEqual(tree(f.stateRoot), before);
});

test("fresh-reservation assertion checks exact identity and both deadlines without durable writes", t => {
  const f = fixture(t), digest = f.envelope.integrity.canonicalPayloadDigest;
  f.registry.reserve(f.target, operationId, digest);
  const before = tree(f.stateRoot); let samples = 0;
  f.registry.assertFreshReservation(f.target, operationId, digest, () => { samples++; return f.clock(); }, f.envelope.expiresAt);
  assert.equal(samples, 1);
  assert.throws(() => f.registry.assertFreshReservation(f.target, "operation:other", digest, () => assert.fail("mismatched identity cannot sample"), f.envelope.expiresAt), errorCode("OPERATION_IN_DOUBT"));
  assert.throws(() => f.registry.assertFreshReservation(f.target, operationId, "b".repeat(64), f.clock, f.envelope.expiresAt), errorCode("OPERATION_IN_DOUBT"));
  assert.throws(() => f.registry.assertFreshReservation(f.target, operationId, digest, f.clock, "invalid"), errorCode("OPERATION_CONFLICT"));
  assert.throws(() => f.registry.assertFreshReservation(f.target, operationId, digest, f.clock, instant), errorCode("TARGET_EXPIRED"));
  assert.deepEqual(tree(f.stateRoot), before);
});

test("accepted resume advances once, commits numeric revisions, and consumes one exact target", async t => {
  const f = fixture(t);
  const bytes = await f.service().resumeFile(f.file, { accepted: true });
  const receipt = JSON.parse(bytes.toString());
  assert.equal(receipt.code, "RESUMED"); assert.equal(receipt.outcome, "accepted");
  assert.equal(receipt.observedRevisionBefore, 2); assert.equal(receipt.observedRevisionAfter, 3);
  assert.equal(receipt.receiptId, `receipt:${sha256(`${operationId}:${f.envelope.integrity.canonicalPayloadDigest}:accepted:RESUMED`).slice(0, 32)}`);
  const record = f.journal.lookup(operationId)!;
  assert.equal(record.state, "target-consumed"); assert.equal(record.acceptance?.source, "runtime-flag");
  assert.equal(receipt.createdAt, record.transitions.find(t => t.state === "kernel-resumed")?.observedAt);
  assert.equal(f.targetRecord().receiptId, receipt.receiptId); assert.equal(f.targetRecord().state, "consumed");
  assert.equal(f.deltas().length, 1); assert.equal(f.store.getWork(f.workId).revision, 3);
  assert.equal(fs.readdirSync(path.join(f.stateRoot, "receipts")).length, 1);
  f.expire(); fs.writeFileSync(f.file, JSON.stringify(f.envelope, null, 2));
  assert.deepEqual(await f.service({ observe: () => assert.fail("replay must not observe workspace") }).resumeFile(f.file, { accepted: false }), bytes);
  assert.equal(f.deltas().length, 1); assert.equal(f.store.getWork(f.workId).revision, 3);
});

test("atomic reservation catches expiry after validation without kernel mutation", async t => {
  const f = fixture(t);
  const journal = new OperationJournal({ stateRoot: f.stateRoot, clock: () => { f.expire(); return new Date(instant); } });
  await assert.rejects(f.service({ journal }).resumeFile(f.file, { accepted: true }), errorCode("TARGET_EXPIRED"));
  assert.equal(f.targetRecord().state, "issued"); assert.equal(f.deltas().length, 0);
  assert.equal(f.store.getWork(f.workId).revision, 2); assert.equal(f.receipts.readBytes(operationId), null);
});

for (const point of points) test(`new service reconciles ${point} after expiry without another approval or delta`, async t => {
  const f = fixture(t);
  await assert.rejects(f.service({ fault: p => { if (p === point) throw new Error(`fault:${p}`); } }).resumeFile(f.file, { accepted: true }), new RegExp(`fault:${point}`));
  const before = f.journal.lookup(operationId)!;
  assert.equal(before.state, ({ "after-target-reserve": "reserved", "after-kernel-resume": "kernel-resumed", "after-receipt-commit": "receipt-committed", "after-target-consume": "receipt-committed" })[point]);
  const firstBytes = f.receipts.readBytes(operationId);
  f.expire();
  const bytes = await f.service().resumeFile(f.file, { accepted: false });
  if (firstBytes) assert.deepEqual(bytes, firstBytes);
  assert.equal(f.journal.lookup(operationId)?.state, "target-consumed");
  assert.equal(f.targetRecord().state, "consumed"); assert.equal(f.deltas().length, 1);
  assert.equal(f.store.getWork(f.workId).revision, 3);
  assert.deepEqual(await f.service().resumeFile(f.file, { accepted: false }), bytes);
});

test("altered accepted operation never appends a competing receipt", async t => {
  const f = fixture(t); await f.service().resumeFile(f.file, { accepted: true });
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts")), tree(path.join(f.stateRoot, "targets"))];
  const payload = envelopePayload(f.envelope); payload.packet.cue = "Altered"; finalizePacketBudget(payload.packet);
  fs.writeFileSync(f.file, JSON.stringify(buildLocalResumeEnvelope(payload))); f.expire();
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "operations")), tree(path.join(f.stateRoot, "receipts")), tree(path.join(f.stateRoot, "targets"))], before);
});

for (const state of ["created", "inspected"] as const) test(`${state} recovery requires fresh runtime acceptance`, async t => {
  const f = fixture(t);
  await withWriterLock({ stateRoot: f.stateRoot, operationId }, writer => {
    f.journal.open({ operationId, envelopeId: f.envelope.envelopeId, targetId: f.target.targetId, attemptDigest: f.envelope.integrity.canonicalPayloadDigest }, writer);
    if (state === "inspected") f.journal.transition(operationId, state, {}, writer);
  });
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("USER_ACCEPTANCE_REQUIRED"));
  assert.equal(f.journal.lookup(operationId)?.state, state); assert.equal(f.deltas().length, 0);
  assert.equal(JSON.parse((await f.service().resumeFile(f.file, { accepted: true })).toString()).code, "RESUMED");
  assert.equal(f.deltas().length, 1);
});

for (const mismatch of ["reservation", "kernel-delta", "receipt", "consumption"] as const) test(`${mismatch} mismatch is durably quarantined and repeat does not mutate operation evidence`, async t => {
  const f = fixture(t);
  const point = mismatch === "reservation" ? "after-target-reserve" : mismatch === "kernel-delta" ? "after-kernel-resume" : mismatch === "receipt" ? "after-receipt-commit" : "after-target-consume";
  await assert.rejects(f.service({ fault: p => { if (p === point) throw new Error("fault"); } }).resumeFile(f.file, { accepted: true }), /fault/);
  if (mismatch === "reservation") {
    const rows = fs.readFileSync(f.targetFile, "utf8").trim().split("\n").map(row => JSON.parse(row)); rows[1].attemptDigest = "a".repeat(64);
    fs.writeFileSync(f.targetFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  } else if (mismatch === "kernel-delta") {
    const file = path.join(f.kernelRoot, "deltas.jsonl");
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(row => JSON.parse(row)); rows.at(-1).summary = "Different delta";
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  } else if (mismatch === "receipt") {
    const file = path.join(f.stateRoot, "receipts", `${sha256(operationId)}.json`), receipt = JSON.parse(fs.readFileSync(file, "utf8")); receipt.receiptId = "receipt:different";
    fs.writeFileSync(file, canonicalJson(receipt) + "\n");
  } else {
    const rows = fs.readFileSync(f.targetFile, "utf8").trim().split("\n").map(row => JSON.parse(row)); rows[2].receiptId = "receipt:different";
    fs.writeFileSync(f.targetFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("OPERATION_IN_DOUBT"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required");
  const before = [tree(f.kernelRoot), tree(f.stateRoot)];
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], before);
});

for (const point of ["after-reserve", "after-delta", "after-state"] as const) test(`SDK recovers a real kernel ${point} interruption exactly once`, async t => {
  const f = fixture(t);
  const kernel = new TrajectaKernelPort(new TrajectaStore(f.kernelRoot, f.clock, p => { if (p === point) throw new Error(`kernel:${p}`); }));
  await assert.rejects(f.service({ kernel }).resumeFile(f.file, { accepted: true }), new RegExp(`kernel:${point}`));
  assert.equal(f.journal.lookup(operationId)?.state, "reserved");
  f.expire();
  const bytes = await f.service().resumeFile(f.file, { accepted: false });
  assert.equal(JSON.parse(bytes.toString()).observedRevisionAfter, 3);
  assert.equal(f.deltas().length, 1);
  assert.deepEqual(await f.service().resumeFile(f.file, { accepted: false }), bytes);
});

test("kernel WAL ambiguity quarantines a reserved operation instead of retrying another mutation", async t => {
  const f = fixture(t);
  const kernel = new TrajectaKernelPort(new TrajectaStore(f.kernelRoot, f.clock, p => { if (p === "after-reserve") throw new Error("kernel fault"); }));
  await assert.rejects(f.service({ kernel }).resumeFile(f.file, { accepted: true }), /kernel fault/);
  const stateFile = path.join(f.kernelRoot, "state.json"), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.work[0].revision = 19; fs.writeFileSync(stateFile, JSON.stringify(state));
  const before = tree(f.kernelRoot);
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("OPERATION_IN_DOUBT"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required"); assert.deepEqual(tree(f.kernelRoot), before);
});

test("receipt store reporting uncertain commit preserves evidence and quarantines", async t => {
  const f = fixture(t);
  const receipts = new ReceiptStore({ stateRoot: f.stateRoot });
  const commit = receipts.commit.bind(receipts);
  receipts.commit = (receipt, writer) => { commit(receipt, writer); throw new Error("receipt boundary"); };
  await assert.rejects(f.service({ receipts }).resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  // A throwing store reports uncertain durability; the service must preserve evidence.
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required");
  assert.equal(f.deltas().length, 1); assert.ok(f.receipts.readBytes(operationId));
});

test("completed operation detects a changed consumption receipt and quarantines all terminal evidence", async t => {
  const f = fixture(t); await f.service().resumeFile(f.file, { accepted: true });
  const rows = fs.readFileSync(f.targetFile, "utf8").trim().split("\n").map(row => JSON.parse(row)); rows[2].receiptId = "receipt:wrong";
  fs.writeFileSync(f.targetFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("OPERATION_IN_DOUBT"));
  const record = f.journal.lookup(operationId)!;
  assert.equal(record.state, "inspection-required"); assert.equal(record.transitions.length, 7);
  const before = [tree(f.kernelRoot), tree(f.stateRoot)];
  const payload = envelopePayload(f.envelope); payload.envelopeId = "envelope:other";
  fs.writeFileSync(f.file, JSON.stringify(buildLocalResumeEnvelope(payload)));
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_CONFLICT"));
  assert.deepEqual([tree(f.kernelRoot), tree(f.stateRoot)], before);
});

test("fresh exact reservation without persisted acceptance requires approval again before finishing", async t => {
  const f = fixture(t);
  const registry = new TargetRegistry({ stateRoot: f.stateRoot, clock: f.clock, onAfterJournalAppend: () => { throw new Error("target boundary"); } });
  await assert.rejects(f.service({ registry }).resumeFile(f.file, { accepted: true }), /target boundary/);
  assert.equal(f.journal.lookup(operationId)?.state, "inspected");
  assert.equal(f.journal.lookup(operationId)?.acceptance, null);
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("USER_ACCEPTANCE_REQUIRED"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspected"); assert.equal(f.deltas().length, 0);
  assert.equal(JSON.parse((await f.service().resumeFile(f.file, { accepted: true })).toString()).code, "RESUMED");
  assert.equal(f.deltas().length, 1);
});

test("receipt without operation snapshot records only observed inconsistency and never mutates kernel", async t => {
  const f = fixture(t); await f.service().resumeFile(f.file, { accepted: true });
  fs.unlinkSync(path.join(f.stateRoot, "operations", `${sha256(operationId)}.json`));
  const rows = fs.readFileSync(f.targetFile, "utf8").trim().split("\n"); fs.writeFileSync(f.targetFile, rows[0] + "\n");
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "receipts")), tree(path.join(f.stateRoot, "targets"))];
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  const record = f.journal.lookup(operationId)!;
  assert.equal(record.state, "inspection-required");
  assert.deepEqual(record.transitions.map(t => t.state), ["created", "inspection-required"]);
  assert.equal(record.acceptance, null); assert.equal(record.kernelResult, null); assert.equal(record.receipt, null);
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "receipts")), tree(path.join(f.stateRoot, "targets"))], before);
});

test("expired target reserved before acceptance snapshot is quarantined without a kernel delta", async t => {
  const f = fixture(t);
  const registry = new TargetRegistry({ stateRoot: f.stateRoot, clock: f.clock, onAfterJournalAppend: () => { throw new Error("target boundary"); } });
  await assert.rejects(f.service({ registry }).resumeFile(f.file, { accepted: true }), /target boundary/);
  f.expire();
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("OPERATION_IN_DOUBT"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required"); assert.equal(f.deltas().length, 0);
});

test("receipt bytes durable before journal commit reconstruct exactly from stored kernel transition time", async t => {
  const f = fixture(t), journal = new OperationJournal({ stateRoot: f.stateRoot, clock: f.clock });
  const transition = journal.transition.bind(journal);
  journal.transition = (id, state, update, writer) => { if (state === "receipt-committed") throw new Error("journal boundary"); return transition(id, state, update, writer); };
  await assert.rejects(f.service({ journal }).resumeFile(f.file, { accepted: true }), /journal boundary/);
  const bytes = f.receipts.readBytes(operationId)!; assert.ok(bytes);
  assert.equal(f.journal.lookup(operationId)?.state, "kernel-resumed"); f.expire();
  assert.deepEqual(await f.service().resumeFile(f.file, { accepted: false }), bytes);
  assert.equal(f.deltas().length, 1);
});

test("rejection bytes durable before journal commit reconcile without acceptance or consuming target", async t => {
  const f = fixture(t), journal = new OperationJournal({ stateRoot: f.stateRoot, clock: f.clock });
  f.store.capture({ operationId: "operation:advance", workId: f.workId, expectedRevision: 2, surface, kind: "progress", summary: "New revision" });
  const transition = journal.transition.bind(journal);
  journal.transition = (id, state, update, writer) => { if (state === "receipt-committed") throw new Error("journal boundary"); return transition(id, state, update, writer); };
  await assert.rejects(f.service({ journal }).resumeFile(f.file, { accepted: false }), /journal boundary/);
  const bytes = f.receipts.readBytes(operationId)!;
  assert.equal(f.journal.lookup(operationId)?.state, "inspected");
  assert.deepEqual(await f.service().resumeFile(f.file, { accepted: false }), bytes);
  assert.equal(f.targetRecord().state, "issued"); assert.equal(f.deltas().length, 0);
});

test("committed rejection receipt mismatch quarantines without changing target or kernel", async t => {
  const f = fixture(t);
  f.store.capture({ operationId: "operation:advance", workId: f.workId, expectedRevision: 2, surface, kind: "progress", summary: "New revision" });
  await f.service().resumeFile(f.file, { accepted: false });
  const file = path.join(f.stateRoot, "receipts", `${sha256(operationId)}.json`), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.receiptId = "receipt:changed"; fs.writeFileSync(file, canonicalJson(receipt) + "\n");
  const before = [tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))];
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("OPERATION_IN_DOUBT"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required");
  assert.equal(f.journal.lookup(operationId)?.acceptance, null);
  assert.deepEqual([tree(f.kernelRoot), tree(path.join(f.stateRoot, "targets"))], before);
});

test("ordinary expired issued early operation retains TARGET_EXPIRED and no execution evidence", async t => {
  const f = fixture(t);
  await withWriterLock({ stateRoot: f.stateRoot, operationId }, writer => {
    f.journal.open({ operationId, envelopeId: f.envelope.envelopeId, targetId: f.target.targetId, attemptDigest: f.envelope.integrity.canonicalPayloadDigest }, writer);
  });
  f.expire();
  await assert.rejects(f.service().resumeFile(f.file, { accepted: true }), errorCode("TARGET_EXPIRED"));
  assert.equal(f.journal.lookup(operationId)?.state, "created"); assert.equal(f.deltas().length, 0);
});

test("stored kernel instruction effect inconsistent with packet is quarantined before receipt creation", async t => {
  const f = fixture(t);
  await assert.rejects(f.service({ fault: p => { if (p === "after-kernel-resume") throw new Error("fault"); } }).resumeFile(f.file, { accepted: true }), /fault/);
  const file = path.join(f.stateRoot, "operations", `${sha256(operationId)}.json`), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.kernelResult.work.instruction = "Another instruction"; fs.writeFileSync(file, canonicalJson(record) + "\n");
  await assert.rejects(f.service().resumeFile(f.file, { accepted: false }), errorCode("OPERATION_IN_DOUBT"));
  assert.equal(f.journal.lookup(operationId)?.state, "inspection-required"); assert.equal(f.receipts.readBytes(operationId), null);
});

test("reservation and consumption assertions are exact read-only checks even after expiry", async t => {
  const f = fixture(t), digest = f.envelope.integrity.canonicalPayloadDigest;
  const issued = tree(f.stateRoot); f.registry.assertIssued(f.target); assert.deepEqual(tree(f.stateRoot), issued);
  assert.throws(() => f.registry.assertReservation(f.target, operationId, digest), errorCode("OPERATION_IN_DOUBT"));
  f.registry.reserve(f.target, operationId, digest); f.expire();
  const before = tree(f.stateRoot);
  assert.throws(() => f.registry.assertIssued(f.target), errorCode("OPERATION_IN_DOUBT"));
  f.registry.assertReservation(f.target, operationId, digest);
  for (const [id, hash] of [["operation:other", digest], [operationId, "b".repeat(64)]]) assert.throws(() => f.registry.assertReservation(f.target, id, hash), errorCode("OPERATION_IN_DOUBT"));
  assert.throws(() => f.registry.assertReservation({ ...f.target, capability: "capability:wrong" }, operationId, digest), errorCode("TARGET_MISMATCH"));
  assert.deepEqual(tree(f.stateRoot), before);
  f.registry.consume(f.target, operationId, "receipt:one"); const consumed = tree(f.stateRoot);
  f.registry.assertConsumed(f.target, operationId, digest, "receipt:one");
  assert.throws(() => f.registry.assertIssued(f.target), errorCode("OPERATION_IN_DOUBT"));
  assert.throws(() => f.registry.assertConsumed(f.target, operationId, digest, "receipt:other"), errorCode("OPERATION_IN_DOUBT"));
  assert.throws(() => f.registry.assertConsumed(f.target, operationId, "b".repeat(64), "receipt:one"), errorCode("OPERATION_IN_DOUBT"));
  assert.throws(() => f.registry.assertReservation(f.target, operationId, digest), errorCode("OPERATION_IN_DOUBT"));
  assert.deepEqual(tree(f.stateRoot), consumed);
});
