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

test("stages exactly the generated core + beta package and ledger from a snapshot", () => {
  const snapshot = snapshotFrom();
  const stageDirectory = path.join(os.tmpdir(), `trajecta-stage-${process.pid}-${Date.now()}`);
  const staged = stagePackage({ snapshot, stageDirectory });
  const packageRoot = path.join(stageDirectory, "package");
  assert.deepEqual(stagedFiles(packageRoot), staged.members.map((member) => member.path));
  assert.match(fs.readFileSync(path.join(packageRoot, "bin/trajecta-beta"), "utf8"), /^#!.*\nimport "\.\.\/beta\/src\/cli\.ts";\n$/);
  const originalKernel = fs.readFileSync(path.join(snapshot.root, "packages/trajecta-beta/src/kernel-port.ts"), "utf8");
  const stagedKernel = fs.readFileSync(path.join(packageRoot, "beta/src/kernel-port.ts"), "utf8");
  assert.equal(stagedKernel, originalKernel.replace("../../../src/index.ts", "../../core/src/index.ts"));
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
  expectCode(() => stagePackage({ snapshot, stageDirectory: path.join(os.tmpdir(), `trajecta-drift-${Date.now()}`) }), "SNAPSHOT_DRIFT");

  const linked = snapshotFrom();
  const source = path.join(linked.root, "packages/trajecta-beta/src/args.ts");
  fs.unlinkSync(source);
  fs.symlinkSync("canonical.ts", source);
  expectCode(() => stagePackage({ snapshot: linked, stageDirectory: path.join(os.tmpdir(), `trajecta-symlink-${Date.now()}`) }), "UNSAFE_SNAPSHOT");

  const special = snapshotFrom();
  const specialSource = path.join(special.root, "packages/trajecta-beta/src/args.ts");
  fs.unlinkSync(specialSource);
  fs.mkdirSync(specialSource);
  expectCode(() => stagePackage({ snapshot: special, stageDirectory: path.join(os.tmpdir(), `trajecta-special-${Date.now()}`) }), "UNSAFE_SNAPSHOT");

  const colliding = snapshotFrom();
  const original = colliding.entries.find((candidate) => candidate.path === "packages/trajecta-beta/src/args.ts")!;
  const collisionSnapshot = Object.freeze({ ...colliding, entries: Object.freeze([...colliding.entries, Object.freeze({ ...original, path: "packages/trajecta-beta/src/ARGS.ts" })]) });
  expectCode(() => stagePackage({ snapshot: collisionSnapshot, stageDirectory: path.join(os.tmpdir(), `trajecta-case-${Date.now()}`) }), "CASE_COLLISION");

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
  expectCode(() => stagePackage({ snapshot: updatedSnapshot, stageDirectory: path.join(os.tmpdir(), `trajecta-unclassified-${Date.now()}`) }), "UNCLASSIFIED_MEMBER");
});
