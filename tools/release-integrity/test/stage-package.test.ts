import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderCoreModifications, stagePackage } from "../src/stage-package.ts";
import type { SourceSnapshot } from "../src/preflight-source.ts";
import { ReleaseIntegrityError } from "../src/errors.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
let directorySequence = 0;

function stageDirectory(label: string): string {
  return path.join(os.tmpdir(), `trajecta-${label}-${process.pid}-${Date.now()}-${directorySequence++}`);
}

function snapshotFrom(root = repository): SourceSnapshot {
  const files = [
    "release/payload-policy.json", "release/trajecta-beta.package.json", "release/license-map.json", "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt", "LICENSE", "NOTICE",
    "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md", "packages/trajecta-beta/bin/trajecta-beta",
    ...fs.readdirSync(path.join(root, "packages/trajecta-beta/src")).filter((name) => name.endsWith(".ts")).map((name) => `packages/trajecta-beta/src/${name}`),
    "src/index.ts", "src/relay.ts", "src/store.ts", "src/types.ts",
    ...fs.readdirSync(path.join(root, "src/adapters/proof")).filter((name) => name.endsWith(".ts")).map((name) => `src/adapters/proof/${name}`),
  ].sort();
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-stage-snapshot-"));
  const entries = files.map((relative) => {
    const bytes = fs.readFileSync(path.join(root, relative));
    const destination = path.join(snapshotRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { mode: 0o400 });
    return Object.freeze({ path: relative, bytes: bytes.length, mode: "0644", sha256: createHash("sha256").update(bytes).digest("hex") });
  });
  return Object.freeze({ root: snapshotRoot, buildCommit: "a".repeat(40), entries: Object.freeze(entries) });
}

function stagedFiles(root: string): string[] {
  const result: string[] = [];
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else result.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  walk(root);
  return result.sort();
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ReleaseIntegrityError && error.code === code);
}

function replaceSnapshotBytes(snapshot: SourceSnapshot, relative: string, bytes: Buffer): SourceSnapshot {
  const target = path.join(snapshot.root, relative);
  fs.chmodSync(target, 0o600);
  fs.writeFileSync(target, bytes);
  return Object.freeze({
    ...snapshot,
    entries: Object.freeze(snapshot.entries.map((candidate) => candidate.path === relative
      ? Object.freeze({ ...candidate, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
      : candidate)),
  });
}

test("stages exactly the generated core + beta package and ledger from a snapshot", () => {
  const snapshot = snapshotFrom();
  const output = stageDirectory("stage");
  const staged = stagePackage({ snapshot, stageDirectory: output });
  const packageRoot = path.join(output, "package");
  assert.deepEqual(stagedFiles(packageRoot), staged.members.map((member) => member.path));
  assert.equal(fs.readFileSync(path.join(packageRoot, "bin/trajecta-beta"), "utf8"), "#!/usr/bin/env node\nimport { runCli } from \"../beta/src/cli.js\";\nprocess.exitCode = await runCli(process.argv.slice(2), process.cwd(), { stdout: bytes => { process.stdout.write(bytes); }, stderr: text => { process.stderr.write(text); } });\n");
  const originalKernel = fs.readFileSync(path.join(snapshot.root, "packages/trajecta-beta/src/kernel-port.ts"), "utf8");
  const stagedKernel = fs.readFileSync(path.join(packageRoot, "beta/src/kernel-port.js"), "utf8");
  assert.match(originalKernel, /\.\.\/\.\.\/\.\.\/src\/index\.ts/);
  assert.match(stagedKernel, /from "\.\.\/\.\.\/core\/src\/index\.js"/);
  assert.doesNotMatch(stagedKernel, /\.ts["']/);
  assert.ok(staged.members.every(member => !member.path.endsWith(".ts")));
  assert.equal(fs.readFileSync(path.join(packageRoot, "LICENSE"), "utf8"), fs.readFileSync(path.join(snapshot.root, "LICENSE"), "utf8"));
  assert.equal(fs.readFileSync(path.join(packageRoot, "NOTICE"), "utf8"), fs.readFileSync(path.join(snapshot.root, "NOTICE"), "utf8"));
  assert.match(fs.readFileSync(path.join(packageRoot, "BETA-COMMERCIAL-TERMS.txt"), "utf8"), /evaluation only[\s\S]*not for sale[\s\S]*not activate a commercial offer/i);
  assert.ok(staged.members.some((member) => member.path === "beta/DEVELOPMENT-BOUNDARY.md" && member.originalClass === "documentation"));
  assert.ok(staged.members.some((member) => member.path === "LICENSES/CORE-MODIFICATIONS.txt" && member.originalClass === "notice"));
  assert.ok(!stagedFiles(packageRoot).some((member) => member.includes("/test/") || member.startsWith("tools/") || member.includes(".git")));
  for (const member of staged.members) assert.equal(fs.statSync(path.join(packageRoot, member.path)).mode & 0o777, member.path === "bin/trajecta-beta" ? 0o755 : 0o644);
  const map = JSON.parse(fs.readFileSync(path.join(repository, "release/license-map.json"), "utf8"));
  const outerNotice = fs.readFileSync(path.join(repository, "release/evaluation/LICENSES/CORE-NOTICE.txt"));
  assert.ok(outerNotice.subarray(0, fs.readFileSync(path.join(repository, "NOTICE")).length).equals(fs.readFileSync(path.join(repository, "NOTICE"))));
  assert.ok(outerNotice.subarray(outerNotice.length - renderCoreModifications(map.members).length).equals(renderCoreModifications(map.members)));
  assert.doesNotMatch(outerNotice.toString("utf8"), /doctor/i);
});

test("fails closed on source drift, symlinks, and unclassified package members", () => {
  const snapshot = snapshotFrom();
  const drift = path.join(snapshot.root, "packages/trajecta-beta/src/args.ts");
  fs.chmodSync(drift, 0o600);
  fs.appendFileSync(drift, "\n");
  expectCode(() => stagePackage({ snapshot, stageDirectory: stageDirectory("drift") }), "SNAPSHOT_DRIFT");

  const linked = snapshotFrom();
  const source = path.join(linked.root, "packages/trajecta-beta/src/args.ts");
  fs.unlinkSync(source);
  fs.symlinkSync("canonical.ts", source);
  expectCode(() => stagePackage({ snapshot: linked, stageDirectory: stageDirectory("symlink") }), "UNSAFE_SNAPSHOT");

  const special = snapshotFrom();
  const specialSource = path.join(special.root, "packages/trajecta-beta/src/args.ts");
  fs.unlinkSync(specialSource);
  fs.mkdirSync(specialSource);
  expectCode(() => stagePackage({ snapshot: special, stageDirectory: stageDirectory("special") }), "UNSAFE_SNAPSHOT");

  const colliding = snapshotFrom();
  const original = colliding.entries.find((candidate) => candidate.path === "packages/trajecta-beta/src/args.ts")!;
  const collisionSnapshot = Object.freeze({ ...colliding, entries: Object.freeze([...colliding.entries, Object.freeze({ ...original, path: "packages/trajecta-beta/src/ARGS.ts" })]) });
  expectCode(() => stagePackage({ snapshot: collisionSnapshot, stageDirectory: stageDirectory("case") }), "CASE_COLLISION");

  const unclassified = snapshotFrom();
  const mapPath = path.join(unclassified.root, "release/license-map.json");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  map.members.pop();
  const mapBytes = Buffer.from(`${JSON.stringify(map)}\n`);
  fs.chmodSync(mapPath, 0o600);
  fs.writeFileSync(mapPath, mapBytes);
  const updatedSnapshot = Object.freeze({
    ...unclassified,
    entries: Object.freeze(unclassified.entries.map((candidate) => candidate.path === "release/license-map.json"
      ? Object.freeze({ ...candidate, bytes: mapBytes.length, sha256: createHash("sha256").update(mapBytes).digest("hex") })
      : candidate)),
  });
  expectCode(() => stagePackage({ snapshot: updatedSnapshot, stageDirectory: stageDirectory("unclassified") }), "UNCLASSIFIED_MEMBER");
});

test("accepts only the exact dependency-free package-template schema", () => {
  for (const field of ["publishConfig", "main", "exports", "workspaces", "unexpected"]) {
    const snapshot = snapshotFrom();
    const template = JSON.parse(fs.readFileSync(path.join(snapshot.root, "release/trajecta-beta.package.json"), "utf8"));
    template[field] = field === "workspaces" ? [] : {};
    const altered = replaceSnapshotBytes(snapshot, "release/trajecta-beta.package.json", Buffer.from(`${JSON.stringify(template)}\n`));
    expectCode(() => stagePackage({ snapshot: altered, stageDirectory: stageDirectory(`template-${field}`) }), "INVALID_PACKAGE_TEMPLATE");
  }
  for (const nested of ["engines", "bin"] as const) {
    const snapshot = snapshotFrom();
    const template = JSON.parse(fs.readFileSync(path.join(snapshot.root, "release/trajecta-beta.package.json"), "utf8"));
    template[nested].unexpected = "no";
    const altered = replaceSnapshotBytes(snapshot, "release/trajecta-beta.package.json", Buffer.from(`${JSON.stringify(template)}\n`));
    expectCode(() => stagePackage({ snapshot: altered, stageDirectory: stageDirectory(`template-${nested}`) }), "INVALID_PACKAGE_TEMPLATE");
  }
});

test("fails closed on dynamic imports and identical-ledger symlinked snapshot ancestry", () => {
  for (const relative of ["packages/trajecta-beta/src/args.ts", "src/store.ts"]) {
    const snapshot = snapshotFrom();
    const source = fs.readFileSync(path.join(snapshot.root, relative));
    const altered = replaceSnapshotBytes(snapshot, relative, Buffer.concat([source, Buffer.from("\nvoid import('../../outside.ts');\n")]));
    expectCode(() => stagePackage({ snapshot: altered, stageDirectory: stageDirectory("dynamic") }), "DYNAMIC_IMPORT_FORBIDDEN");
  }

  const ancestor = snapshotFrom();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-outside-identical-"));
  fs.cpSync(path.join(ancestor.root, "packages"), path.join(outside, "packages"), { recursive: true });
  fs.rmSync(path.join(ancestor.root, "packages"), { recursive: true, force: true });
  fs.symlinkSync(path.join(outside, "packages"), path.join(ancestor.root, "packages"));
  expectCode(() => stagePackage({ snapshot: ancestor, stageDirectory: stageDirectory("ancestor-link") }), "UNSAFE_SNAPSHOT");

  const rooted = snapshotFrom();
  const redirectedRoot = path.join(os.tmpdir(), `trajecta-root-link-${process.pid}-${Date.now()}-${directorySequence++}`);
  fs.symlinkSync(rooted.root, redirectedRoot);
  expectCode(() => stagePackage({ snapshot: Object.freeze({ ...rooted, root: redirectedRoot }), stageDirectory: stageDirectory("root-link") }), "UNSAFE_SNAPSHOT");
});
