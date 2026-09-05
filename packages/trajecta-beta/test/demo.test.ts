import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sdk from "../src/index.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const expectedTrace = "TARGET    issued for example.invalid/patternstatic/trajecta-memory · main\n"
  + "STALE     REJECTED REVISION_CONFLICT · revision 3 -> 3 · receipt:ID\n"
  + "CURRENT   ACCEPTED RESUMED · revision 3 -> 4 · receipt:ID\n"
  + "RETRY     same receipt bytes · revision remains 4 · receipt:ID\n";
function normalize(text: string): string { return text.replace(/receipt:[a-f0-9]{32}/g, "receipt:ID"); }
function safe(text: string) { assert.doesNotMatch(text, /capability:|SECRET_TOKEN|PRIVATE_ACCOUNT|\/Users\/|\/home\/|https?:\/\/[^/\s]+@/); }
function temporary(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-demo-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function files(root: string, relative = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const child = path.join(relative, name), full = path.join(root, child), stat = fs.lstatSync(full);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) Object.assign(result, files(root, child));
    else result[child] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
  return result;
}

test("public demo runs real stale/current/expired retry receipts and retains only supplied state", async t => {
  assert.equal(typeof sdk.runDemo, "function", "Task 10 must export its real demo");
  const root = temporary(t), stateRoot = path.join(root, "state"); let text = "";
  const result = await sdk.runDemo({ stateRoot, clock: () => new Date("2026-09-05T00:00:00.000Z"), output: chunk => { text += chunk; } });
  assert.equal(normalize(text), expectedTrace); safe(text);
  assert.equal(result.stale.code, "REVISION_CONFLICT"); assert.equal(result.current.code, "RESUMED");
  assert.equal(result.targetAfterStale, "issued"); assert.equal(result.targetAfterCurrent, "consumed");
  assert.equal(result.retryReceiptId, result.current.receiptId); assert.equal(result.revision, 4);
  assert.deepEqual(fs.readdirSync(root), ["state"]);
  const state = JSON.parse(fs.readFileSync(path.join(stateRoot, "kernel/state.json"), "utf8"));
  assert.equal(state.work.length, 1); assert.equal(state.work[0].revision, 4);
  const deltas = fs.readFileSync(path.join(stateRoot, "kernel/deltas.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(deltas.filter(delta => delta.operationId === `${result.current.operationId}.kernel`).length, 1);
  assert.equal(deltas.filter(delta => delta.kind === "resume").length, 1);
  const receipts = new sdk.ReceiptStore({ stateRoot });
  assert.deepEqual(JSON.parse(receipts.readBytes(result.stale.operationId)!.toString()), result.stale);
  assert.deepEqual(JSON.parse(receipts.readBytes(result.current.operationId)!.toString()), result.current);
  assert.equal(fs.readdirSync(path.join(stateRoot, "receipts")).length, 2);
  for (const name of Object.keys(files(stateRoot))) safe(fs.readFileSync(path.join(stateRoot, name), "utf8"));
});

test("two copied tracked-source processes give the same proof and confine durable writes", t => {
  const root = temporary(t);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  const traces: string[] = [];
  for (const number of [1, 2]) {
    const clean = path.join(root, `run-${number}`), source = path.join(clean, "source"), stateRoot = path.join(clean, "state"), temp = path.join(clean, "temporary");
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(temp);
    for (const relative of tracked) {
      const destination = path.join(source, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(repo, relative), destination);
      fs.chmodSync(destination, fs.statSync(path.join(repo, relative)).mode & 0o777);
    }
    const before = files(source);
    const run = spawnSync(path.join(source, "packages/trajecta-beta/bin/trajecta-beta"), ["demo", "--state-root", stateRoot],
      { cwd: source, encoding: "utf8", env: { ...process.env, TMPDIR: temp, NODE_OPTIONS: "", PRIVATE_ACCOUNT: "PRIVATE_ACCOUNT", SECRET_TOKEN: "SECRET_TOKEN" } });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, ""); safe(run.stdout);
    traces.push(normalize(run.stdout)); assert.equal(traces.at(-1), expectedTrace);
    assert.deepEqual(files(source), before); assert.deepEqual(fs.readdirSync(temp), []);
    assert.deepEqual(fs.readdirSync(clean).sort(), ["source", "state", "temporary"]);
    const receiptFiles = fs.readdirSync(path.join(stateRoot, "receipts")); assert.equal(receiptFiles.length, 2);
    const receipts = receiptFiles.map(name => JSON.parse(fs.readFileSync(path.join(stateRoot, "receipts", name), "utf8")));
    const accepted = receipts.find(receipt => receipt.outcome === "accepted"), rejected = receipts.find(receipt => receipt.outcome === "rejected");
    assert.equal(rejected.code, "REVISION_CONFLICT"); assert.equal(rejected.observedRevisionBefore, 3); assert.equal(rejected.observedRevisionAfter, 3);
    assert.equal(accepted.code, "RESUMED"); assert.equal(accepted.observedRevisionBefore, 3); assert.equal(accepted.observedRevisionAfter, 4);
    assert.equal(rejected.targetId, accepted.targetId);
    const targetFiles = fs.readdirSync(path.join(stateRoot, "targets")).filter(name => name.endsWith(".journal")); assert.equal(targetFiles.length, 1);
    const transitions = fs.readFileSync(path.join(stateRoot, "targets", targetFiles[0]!), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(transitions.map(record => record.state), ["issued", "reserved", "consumed"]);
    assert.equal(transitions[2].operationId, accepted.operationId); assert.equal(transitions[2].receiptId, accepted.receiptId);
    const deltas = fs.readFileSync(path.join(stateRoot, "kernel/deltas.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(deltas.filter(delta => delta.kind === "resume").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, "kernel/state.json"), "utf8")).work[0].revision, 4);
    for (const file of Object.keys(files(stateRoot))) safe(fs.readFileSync(path.join(stateRoot, file), "utf8"));
  }
  assert.equal(traces[0], traces[1]);
});

test("default CLI demo removes temporary workspace and state after printing proof", t => {
  const root = temporary(t), before = files(root);
  const result = spawnSync(path.join(repo, "packages/trajecta-beta/bin/trajecta-beta"), ["demo"],
    { cwd: root, encoding: "utf8", env: { ...process.env, TMPDIR: root, NODE_OPTIONS: "" } });
  assert.equal(result.status, 0, result.stderr); assert.equal(normalize(result.stdout), expectedTrace);
  assert.deepEqual(files(root), before); assert.deepEqual(fs.readdirSync(root), []);
});

test("demo refuses nonempty supplied state without changing existing bytes", async t => {
  assert.equal(typeof sdk.runDemo, "function"); const root = temporary(t); fs.writeFileSync(path.join(root, "sentinel"), "retained");
  const before = files(root); let output = "";
  await assert.rejects(sdk.runDemo({ stateRoot: root, output: text => { output += text; } }), (error: any) => error.code === "OPERATION_IN_DOUBT");
  assert.deepEqual(files(root), before); assert.equal(output, "");
});

test("demo cleans its owned temporary resources even when output throws", async t => {
  const root = temporary(t), previous = os.tmpdir; os.tmpdir = () => root;
  try {
    await assert.rejects(sdk.runDemo({ output: () => { throw new Error("output closed"); } }), /output closed/);
    assert.deepEqual(fs.readdirSync(root), []);
    const stateRoot = path.join(root, "retained");
    await assert.rejects(sdk.runDemo({ stateRoot, output: () => { throw new Error("output closed"); } }), /output closed/);
    assert.deepEqual(fs.readdirSync(root), ["retained"]);
    assert.equal(fs.readdirSync(path.join(stateRoot, "receipts")).length, 2);
  } finally { os.tmpdir = previous; }
});

test("demo rejects supplied symlink roots and absent parents without outside mutation", async t => {
  const root = temporary(t), outside = path.join(root, "outside"); fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, "state-link"));
  await assert.rejects(sdk.runDemo({ stateRoot: path.join(root, "state-link") }), (error: any) => error.code === "OPERATION_IN_DOUBT");
  assert.deepEqual(fs.readdirSync(outside), []);
  await assert.rejects(sdk.runDemo({ stateRoot: path.join(root, "absent", "state") }), (error: any) => error.code === "OPERATION_IN_DOUBT");
  assert.equal(fs.existsSync(path.join(root, "absent")), false);
});

function poisonedGitFixture(t: test.TestContext) {
  const root = temporary(t), external = path.join(root, "external"), cwd = path.join(root, "workspace"), temp = path.join(root, "temporary");
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  fs.mkdirSync(temp);
  for (const [directory, branch, remote] of [[external, "external-branch", "https://example.invalid/external/sentinel.git"], [cwd, "main", "https://example.invalid/expected/workspace.git"]]) {
    fs.mkdirSync(directory!);
    execFileSync("git", ["init", "-b", branch!, directory!], { env: base, stdio: "ignore" });
    execFileSync("git", ["-C", directory!, "remote", "add", "origin", remote!], { env: base, stdio: "ignore" });
    fs.writeFileSync(path.join(directory!, "sentinel.txt"), "Sentinel object and index must remain unchanged");
    execFileSync("git", ["-C", directory!, "add", "sentinel.txt"], { env: base, stdio: "ignore" });
  }
  const env = { ...base, TMPDIR: temp, NODE_OPTIONS: "", GIT_DIR: path.join(external, ".git"), GIT_WORK_TREE: external,
    GIT_INDEX_FILE: path.join(external, ".git/index"), GIT_OBJECT_DIRECTORY: path.join(external, ".git/objects"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://user:SECRET_TOKEN@example.invalid/redirected/repo.git" };
  return { root, external, cwd, temp, env };
}

test("Git environment boundary removes every GIT_ override without changing other environment", () => {
  assert.equal(typeof sdk.gitEnvironment, "function");
  const supplied = { HOME: "/preserved/home", PATH: "/preserved/bin", LANG: "C", EMPTY: undefined, GITHUB_TOKEN: "unchanged",
    GIT_DIR: "external", GIT_WORK_TREE: "external", GIT_INDEX_FILE: "index", GIT_OBJECT_DIRECTORY: "objects", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "redirect", GIT_CONFIG_PARAMETERS: "override", GIT_FUTURE_OVERRIDE: "remove" };
  const before = { ...supplied };
  assert.deepEqual(sdk.gitEnvironment(supplied), { HOME: "/preserved/home", PATH: "/preserved/bin", LANG: "C", EMPTY: undefined, GITHUB_TOKEN: "unchanged" });
  assert.deepEqual(supplied, before);
});

test("direct demo ignores poisoned Git routing/config and leaves external repo bytes unchanged", t => {
  const f = poisonedGitFixture(t), beforeExternal = files(f.external), beforeWorkspace = files(f.cwd), stateRoot = path.join(f.root, "state");
  const result = spawnSync(path.join(repo, "packages/trajecta-beta/bin/trajecta-beta"), ["demo", "--state-root", stateRoot],
    { cwd: f.cwd, encoding: "utf8", env: f.env });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.equal(normalize(result.stdout), expectedTrace); safe(result.stdout);
  assert.deepEqual(files(f.external), beforeExternal); assert.deepEqual(files(f.cwd), beforeWorkspace); assert.deepEqual(fs.readdirSync(f.temp), []);
  const receipts = fs.readdirSync(path.join(stateRoot, "receipts")).map(name => JSON.parse(fs.readFileSync(path.join(stateRoot, "receipts", name), "utf8")));
  assert.equal(receipts.length, 2); assert.equal(receipts.filter(receipt => receipt.code === "RESUMED").length, 1);
});

for (const command of ["doctor", "host init"]) test(`${command} binds cwd rather than inherited external Git overrides`, t => {
  const f = poisonedGitFixture(t), beforeExternal = files(f.external), beforeWorkspace = files(f.cwd);
  const executable = path.join(repo, "packages/trajecta-beta/bin/trajecta-beta");
  if (command === "doctor") {
    const doctor = spawnSync(executable, ["doctor"], { cwd: f.cwd, encoding: "utf8", env: f.env });
    assert.equal(doctor.status, 0, doctor.stderr); assert.equal(doctor.stderr, ""); safe(doctor.stdout);
    const diagnosis = JSON.parse(doctor.stdout); assert.equal(diagnosis.repository, "example.invalid/expected/workspace"); assert.equal(diagnosis.branch, "main");
    assert.deepEqual(files(f.external), beforeExternal); assert.deepEqual(files(f.cwd), beforeWorkspace); return;
  }
  const initialized = spawnSync(executable, ["host", "init"], { cwd: f.cwd, encoding: "utf8", env: f.env });
  assert.equal(initialized.status, 0, initialized.stderr); assert.equal(initialized.stderr, ""); safe(initialized.stdout);
  const target = JSON.parse(fs.readFileSync(path.join(f.cwd, "trajecta-target.traj.json"), "utf8"));
  assert.equal(target.workspace.repository, "example.invalid/expected/workspace"); assert.equal(target.workspace.branch, "main");
  assert.ok(fs.existsSync(path.join(f.cwd, ".trajecta-beta/targets")));
  assert.equal(target.workspace.stateRootFingerprint, createHash("sha256").update(path.join(f.cwd, ".trajecta-beta")).digest("hex"));
  assert.deepEqual(files(f.external), beforeExternal); assert.deepEqual(fs.readdirSync(f.temp), []);
});
