import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TrajectaStore } from "../../../src/index.ts";
import { buildLocalResumeEnvelope } from "../src/envelope.ts";
import * as kernelBoundary from "../src/kernel-port.ts";
import { runCli } from "../src/cli.ts";

const executable = fileURLToPath(new URL("../bin/trajecta-beta", import.meta.url));
function run(cwd: string, ...args: string[]) {
  return spawnSync(executable, args, { cwd, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
}
function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://user:SECRET_TOKEN@example.invalid/team/repo.git"]);
  return root;
}
function tree(directory: string): unknown {
  return fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode & 0o777, stat.isSymbolicLink() ? ["symlink", fs.readlinkSync(file)] : stat.isDirectory() ? tree(file) : createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  });
}
function safe(text: string) {
  assert.doesNotMatch(text, /SECRET_TOKEN|capability:|\/Users\/|\/home\/|PRIVATE_PROMPT|PRIVATE_TRANSCRIPT|PRIVATE_HIDDEN/);
}
function failure(result: ReturnType<typeof run>, code: string, status = 2) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^${code}: [^\\n]+\\nNext: [^\\n]+\\n$`));
  assert.ok(result.stderr.length < 1000);
  safe(result.stderr);
}
function seed(root: string, stateRoot = path.join(root, ".trajecta-beta")) {
  const target = JSON.parse(fs.readFileSync(path.join(root, "trajecta-target.traj.json"), "utf8"));
  const store = new TrajectaStore(path.join(stateRoot, "kernel"));
  const surface = { kind: "cloud" as const, name: "PRIVATE_PROMPT", session: "cloud:PRIVATE_TRANSCRIPT" };
  const { work } = store.open({ operationId: "operation:open", topic: "PRIVATE_HIDDEN", goal: "CLI journey", surface,
    initialBranch: { label: "delivery", purpose: "Resume safely", cues: ["handoff"], returnPoint: "Receipt" } });
  store.capture({ operationId: "operation:handoff", workId: work.id, expectedRevision: 1, surface, kind: "handoff",
    summary: "PRIVATE_PROMPT", provenance: ["artifact:cli"], nextAction: "Review the delivery proof", targetSurface: "local" });
  const packet = store.transfer(work.id, "resume", "local");
  const envelope = buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: "envelope:cli", operationId: "operation:cli",
    createdAt: target.createdAt, expiresAt: target.expiresAt, target, packet });
  const file = path.join(root, "handoff.traj.json");
  fs.writeFileSync(file, JSON.stringify(envelope));
  return { store, workId: work.id, branchId: work.activeBranchId, envelope, file };
}

test("real executable shebang and executable mode run version without a workspace", t => {
  const root = fixture(t);
  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  assert.equal(fs.readFileSync(executable, "utf8").split("\n")[0], "#!/usr/bin/env -S node --experimental-strip-types");
  const result = run(path.dirname(root), "version");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Trajecta Verified Resume SDK Beta 0.1.0\n");
  assert.equal(result.stderr, "");
});

test("kernel factory is read-only and uses only the declared state root", t => {
  const root = fixture(t), stateRoot = path.join(root, "sdk"), before = tree(root);
  const kernel = kernelBoundary.createLocalKernelPort(stateRoot);
  assert.deepEqual(tree(root), before);
  const store = new TrajectaStore(path.join(stateRoot, "kernel"));
  const opened = store.open({ operationId: "operation:factory", topic: "Factory", goal: "Bounded root", surface: { kind: "local", name: "Fixture", session: "local:test" } });
  assert.equal(kernel.getWork(opened.work.id).id, opened.work.id);
  assert.equal(fs.existsSync(path.join(root, ".trajecta")), false);
});

test("factory port refuses a kernel symlink without reading or writing outside state", t => {
  const root = fixture(t), stateRoot = path.join(root, "sdk"), outside = path.join(root, "outside");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const store = new TrajectaStore(outside);
  const opened = store.open({ operationId: "operation:outside", topic: "Private", goal: "Private", surface: { kind: "local", name: "Fixture", session: "local:test" } });
  fs.symlinkSync(outside, path.join(stateRoot, "kernel"));
  const before = tree(root);
  assert.throws(() => kernelBoundary.createLocalKernelPort(stateRoot).getWork(opened.work.id), (error: any) => error.code === "OPERATION_IN_DOUBT");
  assert.deepEqual(tree(root), before);
});

for (const name of ["state.json", "deltas.jsonl", "operations.jsonl"]) {
  test(`factory refuses a symlinked ${name} and leaves outside bytes unchanged`, t => {
    const root = fixture(t), stateRoot = path.join(root, "sdk"), kernelRoot = path.join(stateRoot, "kernel");
    const store = new TrajectaStore(kernelRoot);
    const opened = store.open({ operationId: "operation:guard", topic: "Private", goal: "Guard", surface: { kind: "local", name: "Fixture", session: "local:test" } });
    const original = path.join(kernelRoot, name), outside = path.join(root, "outside");
    fs.mkdirSync(outside); fs.renameSync(original, path.join(outside, name)); fs.symlinkSync(path.join(outside, name), original);
    const before = tree(root), kernel = kernelBoundary.createLocalKernelPort(stateRoot);
    assert.throws(() => kernel.getWork(opened.work.id), (e: any) => e.code === "OPERATION_IN_DOUBT");
    assert.throws(() => kernel.history(opened.work.id), (e: any) => e.code === "OPERATION_IN_DOUBT");
    assert.throws(() => kernel.resume({ operationId: "operation:reject", workId: opened.work.id, expectedRevision: 1, surface: { kind: "local", name: "Fixture", session: "local:test" } }), (e: any) => e.code === "OPERATION_IN_DOUBT");
    assert.deepEqual(tree(root), before);
  });
}

test("factory refuses insecure kernel modes without repairing them", t => {
  const root = fixture(t), stateRoot = path.join(root, "sdk"), store = new TrajectaStore(path.join(stateRoot, "kernel"));
  const opened = store.open({ operationId: "operation:guard", topic: "Private", goal: "Guard", surface: { kind: "local", name: "Fixture", session: "local:test" } });
  for (const [file, mode] of [[path.join(stateRoot, "kernel"), 0o755], [path.join(stateRoot, "kernel", "state.json"), 0o644]] as const) {
    const original = fs.statSync(file).mode & 0o777; fs.chmodSync(file, mode);
    const before = tree(root);
    assert.throws(() => kernelBoundary.createLocalKernelPort(stateRoot).getWork(opened.work.id), (e: any) => e.code === "OPERATION_IN_DOUBT");
    assert.deepEqual(tree(root), before); assert.equal(fs.statSync(file).mode & 0o777, mode);
    fs.chmodSync(file, original);
  }
});

test("factory checks kernel safety after a core read before returning work", t => {
  const root = fixture(t), stateRoot = path.join(root, "sdk"), store = new TrajectaStore(path.join(stateRoot, "kernel"));
  const opened = store.open({ operationId: "operation:guard", topic: "Private", goal: "Guard", surface: { kind: "local", name: "Fixture", session: "local:test" } });
  const stateFile = path.join(stateRoot, "kernel", "state.json"), read = fs.readFileSync;
  fs.readFileSync = ((...args: any[]) => {
    const bytes = (read as any)(...args);
    if (args[0] === stateFile) fs.chmodSync(stateFile, 0o644);
    return bytes;
  }) as typeof fs.readFileSync;
  try { assert.throws(() => kernelBoundary.createLocalKernelPort(stateRoot).getWork(opened.work.id), (e: any) => e.code === "OPERATION_IN_DOUBT"); }
  finally { fs.readFileSync = read; }
});

test("beta source reaches root only through the kernel port public barrel", () => {
  const source = path.dirname(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const imports = fs.readdirSync(source).filter(name => name.endsWith(".ts")).flatMap(name =>
    [...fs.readFileSync(path.join(source, name), "utf8").matchAll(/(?:from\s+|import\s*\()(["'])(\.\.\/\.\.\/\.\.\/src\/[^"']+)\1/g)]
      .map(match => [name, match[2]]));
  assert.deepEqual(imports, [["kernel-port.ts", "../../../src/index.ts"]]);
});

test("doctor is read-only and omits origin credentials", t => {
  const root = fixture(t), before = tree(root), result = run(root, "doctor");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.code, "OK"); assert.equal(report.repository, "example.invalid/team/repo");
  safe(result.stdout); assert.deepEqual(tree(root), before);
});

test("host init creates one private card and refuses overwrite without new state", t => {
  const root = fixture(t), result = run(root, "host", "init");
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); safe(result.stdout);
  assert.match(result.stdout, /example.invalid\/team\/repo/); assert.match(result.stdout, /main/);
  const file = path.join(root, "trajecta-target.traj.json"), bytes = fs.readFileSync(file, "utf8"), card = JSON.parse(bytes);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(card.workspace.branch, "main"); assert.equal(card.workspace.repository, "example.invalid/team/repo");
  assert.doesNotMatch(bytes, /SECRET_TOKEN|\/Users\/|\/home\//);
  assert.ok(fs.existsSync(path.join(root, ".trajecta-beta", "targets")));
  const before = tree(root);
  failure(run(root, "host", "init"), "TARGET_MISMATCH");
  assert.deepEqual(tree(root), before);
});

test("inspect, explicit accepted resume, replay, and lookup preserve exact durable receipts", t => {
  const root = fixture(t);
  assert.equal(run(root, "host", "init").status, 0);
  const f = seed(root), before = tree(root), inspected = run(root, "inspect", f.file);
  assert.equal(inspected.status, 0, inspected.stderr); safe(inspected.stdout); assert.equal(inspected.stderr, "");
  const value = JSON.parse(inspected.stdout);
  assert.equal(value.workId, f.workId); assert.equal(value.branchId, f.branchId);
  assert.equal(value.expectedRevision, 2); assert.equal(value.currentRevision, 2);
  assert.deepEqual(value.provenance, ["artifact:cli"]); assert.equal(value.nextAction, "Review the delivery proof");
  assert.deepEqual(tree(root), before);
  failure(run(root, "resume", f.file), "USER_ACCEPTANCE_REQUIRED");
  assert.equal(f.store.getWork(f.workId).revision, 2);
  const result = run(root, "resume", f.file, "--accept");
  assert.equal(result.status, 0, result.stderr); safe(result.stdout); assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).code, "RESUMED"); assert.equal(f.store.getWork(f.workId).revision, 3);
  const lookupBefore = tree(root), lookup = run(root, "receipt", "operation:cli");
  assert.equal(lookup.status, 0, lookup.stderr); assert.equal(lookup.stdout, result.stdout); assert.equal(lookup.stderr, "");
  assert.deepEqual(tree(root), lookupBefore);
  const replay = run(root, "resume", f.file, "--accept");
  assert.equal(replay.status, 0, replay.stderr); assert.equal(replay.stdout, result.stdout);
  assert.equal(f.store.getWork(f.workId).revision, 3);
});

test("custom state root and output are honored from a Git subdirectory", t => {
  const root = fixture(t), sub = path.join(root, "sub"); fs.mkdirSync(sub);
  const result = run(sub, "host", "init", "--state-root", path.join(root, "chosen-state"), "--out", "target.json");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, "chosen-state", "targets")));
  assert.ok(fs.existsSync(path.join(sub, "target.json")));
  assert.equal(fs.existsSync(path.join(root, ".trajecta-beta")), false);
  safe(result.stdout);
});

test("unknown commands, flags and missing values have bounded two-line errors", t => {
  const root = fixture(t);
  for (const args of [[], ["unknown"], ["codex", "pair"], ["version", "--accept"], ["resume"], ["host", "init", "--out"], ["doctor", "--state-root", "../unsafe"], ["resume", "x", "--accept", "--accept"]]) {
    failure(run(root, ...args), "USAGE");
  }
  failure(run(root, "demo"), "CAPABILITY_UNAVAILABLE");
  const before = tree(root); failure(run(root, "receipt", "operation:absent"), "OPERATION_IN_DOUBT");
  assert.deepEqual(tree(root), before);
});

test("unavailable output parents are user errors and do not issue targets", t => {
  const root = fixture(t), before = tree(root);
  failure(run(root, "host", "init", "--out", "missing/target.json"), "TARGET_MISMATCH");
  assert.deepEqual(tree(root), before);
});

for (const kind of ["stale", "branch"] as const) test(`${kind} resume emits the original rejection receipt, bounded diagnostic and exit two`, t => {
  const root = fixture(t); assert.equal(run(root, "host", "init").status, 0);
  const f = seed(root);
  f.store.capture({ operationId: "operation:advance", workId: f.workId, expectedRevision: 2,
    surface: { kind: "cloud", name: "Fixture", session: "cloud:fixture" }, kind: kind === "stale" ? "decision" : "branch_open", summary: "Advance",
    ...(kind === "branch" ? { branch: { label: "other", purpose: "Other", cues: ["other"], returnPoint: "Return" } } : {}) });
  const result = run(root, "resume", f.file, "--accept");
  assert.equal(result.status, 2, result.stderr);
  const code = kind === "stale" ? "REVISION_CONFLICT" : "BRANCH_MISMATCH";
  assert.equal(JSON.parse(result.stdout).code, code);
  assert.match(result.stderr, new RegExp(`^${code}: [^\\n]+\\nNext: [^\\n]+\\n$`));
  assert.equal(f.store.getWork(f.workId).revision, 3); safe(result.stdout + result.stderr);
  const lookup = run(root, "receipt", "operation:cli");
  assert.equal(lookup.status, 0, lookup.stderr); assert.equal(lookup.stdout, result.stdout);
  const replay = run(root, "resume", f.file);
  assert.equal(replay.status, 2, replay.stderr); assert.equal(replay.stdout, result.stdout);
});

test("symlink output and input paths fail without modifying their targets", t => {
  const root = fixture(t), sentinel = path.join(root, "sentinel"); fs.writeFileSync(sentinel, "PRIVATE_HIDDEN");
  fs.symlinkSync(sentinel, path.join(root, "card.json"));
  failure(run(root, "host", "init", "--out", "card.json"), "TARGET_MISMATCH");
  failure(run(root, "inspect", "card.json"), "INVALID_JSON");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "PRIVATE_HIDDEN");
  assert.equal(fs.existsSync(path.join(root, ".trajecta-beta")), false);
});

test("unexpected internal failures are exit one with no raw diagnostic leak", async t => {
  const root = fixture(t); let stderr = "";
  const status = await runCli(["version"], root, {
    stdout: () => { throw new Error("PRIVATE_HIDDEN /Users/private/account SECRET_TOKEN"); },
    stderr: text => { stderr += text; },
  });
  assert.equal(status, 1); safe(stderr);
  assert.match(stderr, /^INTERNAL_ERROR: [^\n]+\nNext: [^\n]+\n$/);
});
