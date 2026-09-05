import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAcceptance } from "../src/acceptance.ts";
import { runAcceptanceProof } from "../src/acceptance-proof.ts";
import { assembleBundle, BUNDLE_ROOT, DOCUMENT_PATHS } from "../../../tools/release-integrity/src/assemble.ts";
import { packPackage } from "../../../tools/release-integrity/src/pack-package.ts";
import { stagePackage } from "../../../tools/release-integrity/src/stage-package.ts";
import { readZip } from "../../../tools/release-integrity/src/deterministic-zip.ts";
import type { SourceSnapshot } from "../../../tools/release-integrity/src/preflight-source.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const releaseInstant = "2026-09-05T00:00:00Z";

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function sourceSnapshot(): SourceSnapshot {
  const policy = JSON.parse(fs.readFileSync(path.join(repository, "release/payload-policy.json"), "utf8"));
  const stagedBeta = policy.stagedPaths
    .filter((member: string) => member.startsWith("package/beta/src/") && member.endsWith(".js"))
    .map((member: string) => `packages/trajecta-beta/src/${member.slice("package/beta/src/".length, -3)}.ts`);
  const stagedCore = policy.stagedPaths
    .filter((member: string) => member.startsWith("package/core/src/") && member.endsWith(".js"))
    .map((member: string) => `src/${member.slice("package/core/src/".length, -3)}.ts`);
  const files = [
    "release/payload-policy.json", "release/trajecta-beta.package.json", "release/license-map.json",
    "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt", "LICENSE", "NOTICE",
    "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md", "packages/trajecta-beta/bin/trajecta-beta",
    ...stagedBeta, ...stagedCore,
  ].sort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-acceptance-snapshot-"));
  const entries = files.map(relative => {
    const bytes = fs.readFileSync(path.join(repository, relative));
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { mode: 0o400 });
    return Object.freeze({ path: relative, bytes: bytes.length, mode: "0644", sha256: hash(bytes) });
  });
  return Object.freeze({ root, buildCommit: "a".repeat(40), entries: Object.freeze(entries) });
}

function writeRegular(file: string, bytes: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
}

function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-acceptance-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = sourceSnapshot();
  t.after(() => fs.rmSync(snapshot.root, { recursive: true, force: true }));
  const staged = stagePackage({ snapshot, stageDirectory: path.join(root, "stage") });
  const packed = packPackage({ packageRoot: staged.packageRoot, members: staged.members, releaseInstant });
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const documents = new Map<string, Buffer>();
  for (const member of DOCUMENT_PATHS) {
    if (!member.startsWith("LICENSES/") && member !== "THIRD-PARTY-NOTICES.txt") documents.set(member, fs.readFileSync(path.join(repository, "release/evaluation/payload", member)));
  }
  const modificationNotice = fs.readFileSync(path.join(staged.packageRoot, "LICENSES/CORE-MODIFICATIONS.txt"));
  documents.set("LICENSES/CORE-APACHE-2.0.txt", fs.readFileSync(path.join(repository, "LICENSE")));
  documents.set("LICENSES/CORE-NOTICE.txt", Buffer.concat([fs.readFileSync(path.join(repository, "NOTICE")), Buffer.from("\n"), modificationNotice]));
  documents.set("LICENSES/BETA-COMMERCIAL-TERMS.txt", fs.readFileSync(path.join(repository, "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt")));
  documents.set("THIRD-PARTY-NOTICES.txt", fs.readFileSync(path.join(repository, "release/evaluation/THIRD-PARTY-NOTICES.txt")));
  const bundle = assembleBundle({ tgz: packed.tgz, memberLedger: packed.memberLedger, documents, buildCommit: "a".repeat(40), releaseInstant, verificationInstant: releaseInstant, publicKeyPem, privateKeyPem });
  const archivePath = path.join(root, "delivery.zip"); fs.writeFileSync(archivePath, bundle.zip, { mode: 0o600 });
  const unpacked = path.join(root, "unpacked");
  for (const member of readZip(bundle.zip, releaseInstant)) writeRegular(path.join(unpacked, ...member.path.split("/")), member.bytes, Number.parseInt(member.mode, 8));
  const bundleRoot = path.join(unpacked, BUNDLE_ROOT);
  const installedPackageRoot = path.join(root, "caller", "node_modules", "@patternstatic", "trajecta-beta");
  fs.cpSync(staged.packageRoot, installedPackageRoot, { recursive: true, preserveTimestamps: true });
  for (const member of staged.members) fs.chmodSync(path.join(installedPackageRoot, member.path), Number.parseInt(member.mode, 8));
  const publicKeyPath = path.join(root, "seller-public.pem"); fs.writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o600 });
  const bin = path.join(installedPackageRoot, "bin", "trajecta-beta");
  assert.match(execFileSync(bin, ["version"], { encoding: "utf8" }), /0\.1\.0/);
  return { root, bin, input: { archivePath, pinnedZipSha256: bundle.archiveSha256, bundleRoot, publicKeyPath, installedPackageRoot, bin } };
}

test("production proof runs installed CLI scenarios twice with exact durable receipts", async (t) => {
  const f = fixture(t);
  const poisonedHome = path.join(f.root, "poisoned-home"), hooks = path.join(f.root, "external-hooks"), marker = path.join(f.root, "hook-executed");
  fs.mkdirSync(poisonedHome); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\necho unsafe > "${marker}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(poisonedHome, ".gitconfig"), `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${hooks}\n`);
  const originalHome = process.env.HOME;
  process.env.HOME = poisonedHome;
  let first: Awaited<ReturnType<typeof runAcceptanceProof>>, second: Awaited<ReturnType<typeof runAcceptanceProof>>;
  try {
    first = await runAcceptanceProof({ root: path.join(f.root, "proof-a"), bin: f.bin });
    second = await runAcceptanceProof({ root: path.join(f.root, "proof-b"), bin: f.bin });
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  }
  assert.equal(fs.existsSync(marker), false);
  assert.equal(first.finalRevision, 4);
  assert.ok(Object.keys(first.checks).length >= 12);
  assert.ok(Object.values(first.checks).every(Boolean), JSON.stringify(first.checks));
  assert.equal(first.receipts.accepted, first.receipts.retry);
  assert.equal(first.receipts.accepted, first.receipts.lookup);
  assert.notEqual(first.receipts.stale, first.receipts.accepted);
  assert.deepEqual(first.semanticTrace, second.semanticTrace);
  for (const pair of Object.values(first.evidence.beforeAfterDigests)) {
    assert.match(pair.before, /^[a-f0-9]{64}$/); assert.equal(pair.before, pair.after);
  }
  assert.deepEqual(first.evidence.targetStatus, { afterStale: "issued", afterAccepted: "consumed", expiryCheck: "clock-controlled" });
  assert.equal(first.checks.conflictReceiptPreserved, true);
  assert.ok(first.commands.some(command => command.argv[1] === "demo"));
  assert.ok(first.commands.some(command => command.argv[1] === "host"));
  assert.ok(first.commands.some(command => command.argv[1] === "inspect"));
  assert.ok(first.commands.some(command => command.argv[1] === "resume"));
  assert.ok(first.commands.some(command => command.argv[1] === "receipt"));
  assert.ok(first.stateInventory.length > 0);
});

test("acceptance audits, reinstalls offline, exports redacted evidence, and fails closed before writes", async (t) => {
  const f = fixture(t);
  const stateRoot = path.join(f.root, "acceptance-state"), evidenceDir = path.join(f.root, "evidence");
  const result = await runAcceptance({ ...f.input, stateRoot, evidenceDir });
  assert.deepEqual(result, { code: "ACCEPTANCE_PASSED", evidencePath: path.join(evidenceDir, "evidence.json") });
  const evidenceBytes = fs.readFileSync(result.evidencePath, "utf8");
  const evidence = JSON.parse(evidenceBytes);
  assert.equal(evidence.code, "ACCEPTANCE_PASSED");
  assert.equal(evidence.finalRevision, 4);
  assert.equal(evidence.install.exitCode, 0);
  assert.equal(evidence.install.versionCommand.exitCode, 0);
  assert.match(evidence.install.npmVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(evidence.manualIntervention.length, 0);
  assert.equal(evidence.cleanup.complete, true);
  assert.ok(evidence.cleanup.inventory.some((entry: {path: string; type: string}) => entry.path === "workspace/.git" && entry.type === "directory"));
  assert.ok(evidence.cleanup.inventory.some((entry: {path: string; type: string}) => entry.path === "tmp" && entry.type === "directory"));
  assert.ok(evidence.cleanup.inventory.some((entry: {path: string; type: string}) => entry.path === "demo-state" && entry.type === "directory"));
  assert.ok(evidence.stateInventory.some((entry: {path: string}) => entry.path.startsWith("offline-install/")));
  for (const pair of Object.values(evidence.beforeAfterDigests).filter((value): value is {before: string; after: string} => typeof value === "object" && value !== null && "before" in value)) {
    assert.match(pair.before, /^[a-f0-9]{64}$/); assert.equal(pair.before, pair.after);
  }
  assert.equal(fs.existsSync(path.join(stateRoot, "proof-primary")), true);
  assert.equal(fs.existsSync(path.join(stateRoot, "proof-repeat")), false);
  assert.equal(fs.readFileSync(path.join(evidenceDir, "receipts", "accepted.json"), "utf8"), fs.readFileSync(path.join(evidenceDir, "receipts", "retry.json"), "utf8"));
  for (const file of fs.readdirSync(evidenceDir, { recursive: true }).map(String)) {
    const absolute = path.join(evidenceDir, file);
    if (!fs.statSync(absolute).isFile()) continue;
    const serialized = fs.readFileSync(absolute, "utf8");
    for (const secret of [f.root, stateRoot, evidenceDir]) assert.ok(!serialized.includes(secret), file);
    assert.doesNotMatch(serialized, /capability:[A-Za-z0-9._-]+/, file);
  }

  const badState = path.join(f.root, "bad-state"), badEvidence = path.join(f.root, "bad-evidence");
  await assert.rejects(runAcceptance({ ...f.input, pinnedZipSha256: "0".repeat(64), stateRoot: badState, evidenceDir: badEvidence }));
  assert.equal(fs.existsSync(badState), false); assert.equal(fs.existsSync(badEvidence), false);

  for (const [label, nextState, nextEvidence] of [
    ["existing state", path.join(f.root, "existing-state"), path.join(f.root, "new-evidence")],
    ["existing evidence", path.join(f.root, "new-state"), path.join(f.root, "existing-evidence")],
    ["overlap", path.join(f.root, "overlap"), path.join(f.root, "overlap", "evidence")],
  ] as const) {
    if (label === "existing state") fs.mkdirSync(nextState);
    if (label === "existing evidence") fs.mkdirSync(nextEvidence);
    await assert.rejects(runAcceptance({ ...f.input, stateRoot: nextState, evidenceDir: nextEvidence }));
    if (label !== "existing state") assert.equal(fs.existsSync(nextState), false);
    if (label !== "existing evidence") assert.equal(fs.existsSync(nextEvidence), false);
  }

  const realParent = path.join(f.root, "real-parent"); fs.mkdirSync(realParent);
  const linkedParent = path.join(f.root, "linked-parent"); fs.symlinkSync(realParent, linkedParent);
  const linkState = path.join(linkedParent, "state"), linkEvidence = path.join(f.root, "link-evidence");
  await assert.rejects(runAcceptance({ ...f.input, stateRoot: linkState, evidenceDir: linkEvidence }));
  assert.equal(fs.existsSync(path.join(realParent, "state")), false); assert.equal(fs.existsSync(linkEvidence), false);

  const packageOverlap = path.join(f.input.installedPackageRoot, "new-state"), packageEvidence = path.join(f.root, "package-overlap-evidence");
  await assert.rejects(runAcceptance({ ...f.input, stateRoot: packageOverlap, evidenceDir: packageEvidence }));
  assert.equal(fs.existsSync(packageOverlap), false); assert.equal(fs.existsSync(packageEvidence), false);
});
