import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TrajectaStore, TargetRegistry, OperationJournal, ReceiptStore, LocalResumeService, createLocalKernelPort, observeWorkspace,
  buildLocalResumeEnvelope, envelopePayload } from "../packages/trajecta-beta/src/index.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
function entries(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().flatMap(name => { const file = path.join(directory, name); return fs.lstatSync(file).isDirectory() ? entries(file) : [file]; });
}
function hashes(directory: string) { return entries(directory).map(file => [path.relative(directory, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]); }

test("parent gate includes beta proof but exposes no release packaging entrypoint", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.scripts["beta:test"], "node --experimental-strip-types --test packages/trajecta-beta/test/*.test.ts test/beta-parent-contract.test.ts test/store-recovery.test.ts");
  assert.equal(pkg.scripts["beta:demo"], "packages/trajecta-beta/bin/trajecta-beta demo");
  assert.equal(pkg.scripts["beta:check"], "npm run beta:test && npm run beta:demo");
  assert.equal(pkg.scripts.check, "npm test && npm run demo && npm run proof && npm run beta:check");
  assert.equal(fs.existsSync(path.join(repo, "packages/trajecta-beta/package.json")), false);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(name, /pack|publish|archive|payhip|payment|campaign/i);
    assert.doesNotMatch(String(command), /(?:\bpack\b|\bpublish\b|archive|payhip|payment|campaign)/i);
  }
  const productFiles = fs.readdirSync(repo).filter(name => ![".git", ".superpowers", ".worktrees", "node_modules"].includes(name))
    .flatMap(name => { const file = path.join(repo, name); return fs.lstatSync(file).isDirectory() ? entries(file) : [file]; });
  assert.deepEqual(productFiles.filter(file => /\.(?:zip|tgz|tar|gz)$/i.test(file)), []);
});

test("Apache kernel dependency direction and one executable development import remain bounded", () => {
  const beta = path.join(repo, "packages/trajecta-beta/src");
  for (const file of entries(path.join(repo, "src"))) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /packages\/trajecta-beta/);
  const rootImports: [string, string][] = [];
  for (const file of entries(beta)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /ChatGPT-to-Codex|codex pair|payhip|payment|campaign|telemetry|daemon|\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|["'](?:node:)?(?:https?|net|tls|http2|dgram|curl|wget)["']|\b(?:axios|undici)\b/i);
    for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      if (match[1]!.startsWith(".") && !path.resolve(path.dirname(file), match[1]!).startsWith(beta + path.sep)) rootImports.push([path.relative(beta, file), match[1]!]);
    }
  }
  assert.deepEqual(rootImports, [["kernel-port.ts", "../../../src/index.ts"]]);
  const bin = path.join(repo, "packages/trajecta-beta/bin/trajecta-beta");
  assert.equal(fs.statSync(bin).mode & 0o111, 0o111);
  assert.equal(fs.readFileSync(bin, "utf8"), '#!/usr/bin/env -S node --experimental-strip-types\nimport "../src/cli.ts";\n');
  const result = spawnSync(bin, ["version"], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "Trajecta Verified Resume SDK Beta 0.1.0\n");
});

test("parent real-service contract preserves inspect, stale, exact acceptance, expired retry and altered reuse", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-parent-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), stateRoot = path.join(root, "state"); fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.invalid/patternstatic/trajecta-memory.git"]);
  let now = new Date("2026-09-05T00:00:00.000Z"); const clock = () => now;
  const store = new TrajectaStore(path.join(stateRoot, "kernel"), clock);
  const surface = { kind: "cloud" as const, name: "External planner", session: "cloud:parent" };
  const opened = store.open({ operationId: "operation:parent-open", topic: "Bounded local handoff", goal: "Continue once", surface,
    initialBranch: { label: "main", purpose: "Verify resume", cues: ["resume"], returnPoint: "Inspect receipt" } });
  store.capture({ operationId: "operation:parent-handoff", workId: opened.work.id, expectedRevision: 1, surface, kind: "handoff", summary: "Ready", targetSurface: "local", provenance: ["artifact:parent"], nextAction: "Review verified result" });
  const registry = new TargetRegistry({ stateRoot, clock }), target = registry.issue(observeWorkspace(cwd, stateRoot));
  const save = (operationId: string) => {
    const envelope = buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: `envelope:${operationId.slice(10)}`, operationId,
      createdAt: target.createdAt, expiresAt: target.expiresAt, target, packet: store.transfer(opened.work.id, "resume", "local") });
    const file = path.join(cwd, `${operationId.slice(10)}.json`); fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 }); return { file, envelope };
  };
  const stale = save("operation:parent-stale");
  store.capture({ operationId: "operation:parent-advance", workId: opened.work.id, expectedRevision: 2, surface, kind: "decision", summary: "Revised plan" });
  const current = save("operation:parent-current");
  const service = new LocalResumeService({ stateRoot, cwd, clock, kernel: createLocalKernelPort(stateRoot, clock), registry,
    journal: new OperationJournal({ stateRoot, clock }), receipts: new ReceiptStore({ stateRoot }) });
  let before = hashes(stateRoot); const inspection = service.inspectFile(stale.file);
  assert.equal(inspection.expectedRevision, 2); assert.equal(inspection.currentRevision, 3); assert.deepEqual(hashes(stateRoot), before);
  const kernelBefore = hashes(path.join(stateRoot, "kernel"));
  const rejectedBytes = await service.resumeFile(stale.file, { accepted: false }), rejected = JSON.parse(rejectedBytes.toString());
  assert.equal(rejected.outcome, "rejected"); assert.equal(rejected.code, "REVISION_CONFLICT");
  assert.equal(rejected.observedRevisionBefore, 3); assert.equal(rejected.observedRevisionAfter, 3);
  assert.deepEqual(hashes(path.join(stateRoot, "kernel")), kernelBefore); registry.assertIssued(target);
  before = hashes(stateRoot); service.inspectFile(current.file); assert.deepEqual(hashes(stateRoot), before);
  await assert.rejects(service.resumeFile(current.file, { accepted: false }), (error: any) => error.code === "USER_ACCEPTANCE_REQUIRED");
  assert.equal(fs.readdirSync(path.join(stateRoot, "operations")).length, 1);
  const acceptedBytes = await service.resumeFile(current.file, { accepted: true }), accepted = JSON.parse(acceptedBytes.toString());
  assert.equal(accepted.outcome, "accepted"); assert.equal(accepted.code, "RESUMED");
  assert.equal(accepted.observedRevisionBefore, 3); assert.equal(accepted.observedRevisionAfter, 4);
  registry.assertConsumed(target, current.envelope.operationId, current.envelope.integrity.canonicalPayloadDigest, accepted.receiptId);
  assert.equal(store.history(opened.work.id).filter(delta => delta.kind === "resume").length, 1);
  now = new Date("2026-09-05T01:00:00.000Z");
  const stable = [hashes(path.join(stateRoot, "kernel")), hashes(path.join(stateRoot, "operations")), hashes(path.join(stateRoot, "receipts")), hashes(path.join(stateRoot, "targets"))];
  assert.deepEqual(await service.resumeFile(current.file, { accepted: false }), acceptedBytes);
  assert.deepEqual(await service.resumeFile(stale.file, { accepted: false }), rejectedBytes);
  assert.deepEqual(service.receiptBytes(current.envelope.operationId), acceptedBytes); assert.equal(store.getWork(opened.work.id).revision, 4);
  assert.deepEqual([hashes(path.join(stateRoot, "kernel")), hashes(path.join(stateRoot, "operations")), hashes(path.join(stateRoot, "receipts")), hashes(path.join(stateRoot, "targets"))], stable);
  const altered = envelopePayload(current.envelope); altered.envelopeId = "envelope:altered"; fs.writeFileSync(current.file, JSON.stringify(buildLocalResumeEnvelope(altered)));
  await assert.rejects(service.resumeFile(current.file, { accepted: true }), (error: any) => error.code === "OPERATION_CONFLICT");
  assert.equal(fs.readdirSync(path.join(stateRoot, "receipts")).length, 2); assert.equal(store.getWork(opened.work.id).revision, 4);
  assert.deepEqual(hashes(path.join(stateRoot, "kernel")), stable[0]);
});
