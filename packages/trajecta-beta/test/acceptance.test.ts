import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
const npmCli = path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function sourceSnapshot(): SourceSnapshot {
  const policy = JSON.parse(fs.readFileSync(path.join(repository, "release/payload-policy.json"), "utf8"));
  const stagedBeta = policy.stagedPaths
    .filter((member: string) => member.startsWith("package/beta/src/") && member.endsWith(".js"))
    .map((member: string) => `packages/trajecta-beta/src/${member.slice("package/beta/src/".length, -3)}.ts`);
  const stagedCore = policy.stagedPaths
    .filter((member: string) => member.startsWith("package/core/src/") && member.endsWith(".js"))
    .map((member: string) => `src/${member.slice("package/core/src/".length, -3)}.ts`);
  const files = [...new Set([
    "release/payload-policy.json", "release/trajecta-beta.package.json", "release/license-map.json",
    "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt", "LICENSE", "NOTICE",
    "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md", "packages/trajecta-beta/bin/trajecta-beta",
    "packages/trajecta-beta/src/acceptance.ts", "packages/trajecta-beta/src/acceptance-proof.ts",
    ...stagedBeta, ...stagedCore,
  ])].sort();
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
  const caller = path.join(root, "caller"); fs.mkdirSync(caller);
  fs.writeFileSync(path.join(caller, "package.json"), "{\"name\":\"acceptance-caller\",\"private\":true}\n", { mode: 0o600 });
  const tgz = path.join(root, "trajecta-beta-0.1.0.tgz"); fs.writeFileSync(tgz, packed.tgz, { mode: 0o600 });
  const npmUserConfig = path.join(root, "caller-user.npmrc"), npmGlobalConfig = path.join(root, "caller-global.npmrc");
  const npmConfig = "offline=true\nignore-scripts=true\npackage-lock=false\naudit=false\nfund=false\nupdate-notifier=false\n";
  fs.writeFileSync(npmUserConfig, npmConfig, { mode: 0o600 });
  fs.writeFileSync(npmGlobalConfig, npmConfig, { mode: 0o600 });
  const installEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:npm_config_|auth|proxy|registry)/i.test(key)));
  execFileSync(process.execPath, [npmCli, "install", "--offline", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", tgz], {
    cwd: caller,
    env: { ...installEnvironment, NPM_CONFIG_USERCONFIG: npmUserConfig, NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig },
    stdio: "ignore",
  });
  const installedPackageRoot = path.join(caller, "node_modules", "@patternstatic", "trajecta-beta");
  const publicKeyPath = path.join(root, "seller-public.pem"); fs.writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o600 });
  const bin = path.join(installedPackageRoot, "bin", "trajecta-beta");
  assert.match(execFileSync(bin, ["version"], { encoding: "utf8" }), /0\.1\.0/);
  const outside = path.join(root, "outside-source-checkout"); fs.mkdirSync(outside);
  const independentlyPinnedZipSha256 = hash(fs.readFileSync(archivePath));
  assert.equal(independentlyPinnedZipSha256, bundle.archiveSha256);
  return { root, outside, bin, tgz, installEnvironment: { ...installEnvironment, NPM_CONFIG_USERCONFIG: npmUserConfig, NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig }, input: { archivePath, pinnedZipSha256: independentlyPinnedZipSha256, bundleRoot, publicKeyPath, installedPackageRoot, bin } };
}

function acceptanceArgs(input: ReturnType<typeof fixture>["input"], stateRoot: string, evidenceDir: string): string[] {
  return [
    "verify-acceptance",
    "--archive", input.archivePath,
    "--pinned-zip-sha256", input.pinnedZipSha256,
    "--bundle-root", input.bundleRoot,
    "--public-key", input.publicKeyPath,
    "--state-root", stateRoot,
    "--evidence-dir", evidenceDir,
  ];
}

function runInstalled(bin: string, cwd: string, args: string[]) {
  return spawnSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function guideInstallCommand(name: "START-HERE.md" | "START-HERE.html"): string {
  const guide = fs.readFileSync(path.join(repository, "release", "evaluation", "payload", name), "utf8");
  const command = guide.match(/npm install [^\n<]+/)?.[0];
  assert.ok(command, `${name}: install command`);
  return command;
}

function directoryInventory(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .map(entry => `${entry.isDirectory() ? "d" : "f"}:${path.relative(root, path.join(entry.parentPath, entry.name))}`)
    .sort();
}

test("documented install remains inside an empty child of an existing npm project", (t) => {
  const f = fixture(t);
  const ancestor = path.join(f.root, "existing-ancestor"), child = path.join(ancestor, "empty-test-folder");
  const ancestorManifest = Buffer.from('{"name":"existing-ancestor","private":true}\n');
  fs.mkdirSync(path.join(ancestor, "node_modules", "existing-package"), { recursive: true });
  fs.writeFileSync(path.join(ancestor, "package.json"), ancestorManifest);
  fs.writeFileSync(path.join(ancestor, "node_modules", "existing-package", "package.json"), '{"name":"existing-package"}\n');
  fs.mkdirSync(child);
  const beforeInventory = directoryInventory(path.join(ancestor, "node_modules"));
  const markdownCommand = guideInstallCommand("START-HERE.md");
  assert.equal(guideInstallCommand("START-HERE.html"), markdownCommand);
  const command = markdownCommand.replace('"/absolute/path/to/bundle/packages/trajecta-beta-0.1.0.tgz"', JSON.stringify(f.tgz));
  assert.notEqual(command, markdownCommand);
  const result = spawnSync("/bin/sh", ["-c", command], { cwd: child, encoding: "utf8", env: f.installEnvironment });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(ancestor, "package.json")), ancestorManifest);
  assert.deepEqual(directoryInventory(path.join(ancestor, "node_modules")), beforeInventory);
  const localBin = path.join(child, "node_modules", ".bin", "trajecta-beta");
  assert.match(execFileSync(localBin, ["version"], { encoding: "utf8" }), /0\.1\.0/);
});

test("evaluation guides show the six-flag installed command and the exact stale revision distinction", () => {
  for (const name of ["START-HERE.md", "START-HERE.html"]) {
    const guide = fs.readFileSync(path.join(repository, "release", "evaluation", "payload", name), "utf8");
    assert.match(guide, /trajecta-beta verify-acceptance/);
    const commandStart = guide.indexOf("trajecta-beta verify-acceptance");
    const commandEnd = guide.indexOf(name.endsWith(".md") ? "```" : "</code>", commandStart);
    const command = guide.slice(commandStart, commandEnd);
    for (const flag of ["--archive", "--pinned-zip-sha256", "--bundle-root", "--public-key", "--state-root", "--evidence-dir"]) {
      assert.equal(command.split(flag).length - 1, 1, `${name}: ${flag}`);
    }
    assert.match(guide, /independent/i);
    assert.match(guide, /new[^\n<]*(?:state|evidence)/i);
    assert.match(guide, /not[^\n<]*(?:commercial approval|sale)/i);
  }
  const stale = fs.readFileSync(path.join(repository, "release", "evaluation", "payload", "recipes", "02-stale-rejection.md"), "utf8");
  assert.match(stale, /expected revision is `?2`?[^\n]*current revision is `?3`?/i);
  assert.match(stale, /observed misunderstanding/i);
  assert.doesNotMatch(stale, /original (?:text|guide|instructions) said (?:revision )?3/i);
});

test("installed verify-acceptance rejects malformed flags before writes and runs the authenticated package outside source", (t) => {
  const f = fixture(t);
  for (const [label, mutate] of [
    ["missing", (args: string[]) => args.slice(0, -2)],
    ["duplicate", (args: string[]) => [...args, "--archive", f.input.archivePath]],
    ["unknown", (args: string[]) => [...args, "--unknown", "value"]],
  ] as const) {
    const stateRoot = path.join(f.root, `${label}-state`), evidenceDir = path.join(f.root, `${label}-evidence`);
    const result = runInstalled(f.bin, f.outside, mutate(acceptanceArgs(f.input, stateRoot, evidenceDir)));
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^USAGE: [^\n]+\nNext: [^\n]+\n$/);
    assert.equal(fs.existsSync(stateRoot), false); assert.equal(fs.existsSync(evidenceDir), false);
  }

  const rejectedState = path.join(f.root, "rejected-state"), rejectedEvidence = path.join(f.root, "rejected-evidence");
  const rejected = runInstalled(f.bin, f.outside, acceptanceArgs({ ...f.input, pinnedZipSha256: "0".repeat(64) }, rejectedState, rejectedEvidence));
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.match(rejected.stderr, /^ARCHIVE_DIGEST_MISMATCH: [^\n]+\nNext: [^\n]+\n$/);
  assert.doesNotMatch(rejected.stderr, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rejected.stderr, /capability:/);
  assert.equal(fs.existsSync(rejectedState), false); assert.equal(fs.existsSync(rejectedEvidence), false);

  const stateRoot = path.join(f.root, "command-state"), evidenceDir = path.join(f.root, "command-evidence");
  const result = runInstalled(f.bin, f.outside, acceptanceArgs(f.input, stateRoot, evidenceDir));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, { code: "ACCEPTANCE_PASSED", evidencePath: path.join(evidenceDir, "evidence.json") });
  const evidence = JSON.parse(fs.readFileSync(summary.evidencePath, "utf8"));
  const automatedChecks = Object.entries(evidence.checks).filter(([name]) => name !== "installedCommandsPassed");
  assert.equal(automatedChecks.length, 14);
  assert.ok(automatedChecks.every(([, passed]) => passed === true));
  assert.deepEqual(evidence.manualIntervention, []);
});

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
