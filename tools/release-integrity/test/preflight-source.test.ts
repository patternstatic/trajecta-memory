import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preflightSource } from "../src/preflight-source.ts";

type Fixture = { root: string; gitBin: string; commit: string; policy: { schema: string; sourceRoots: string[]; stagedPaths: string[]; exclusionList: string[] } };

function command(file: string, args: string[], cwd: string) {
  return execFileSync(file, args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-preflight-"));
  command("git", ["init", "-b", "main"], root);
  command("git", ["config", "user.name", "Trajecta Test"], root);
  command("git", ["config", "user.email", "test@example.invalid"], root);
  fs.mkdirSync(path.join(root, "input", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "input", "one.txt"), "one\n");
  fs.writeFileSync(path.join(root, "input", "nested", "two.txt"), "two\n");
  command("git", ["add", "input"], root);
  command("git", ["commit", "-m", "fixture"], root);
  return {
    root,
    gitBin: fs.realpathSync(command("git", ["--exec-path"], root).replace(/\/libexec\/git$/, "/bin/git")),
    commit: command("git", ["rev-parse", "HEAD"], root),
    policy: { schema: "trajecta.release-payload-policy/v1", sourceRoots: ["input/**/*.txt"], stagedPaths: ["input/one.txt", "input/nested/two.txt"], exclusionList: [] },
  };
}

function gitBin(): string {
  return fs.realpathSync(command("which", ["git"], process.cwd()));
}

function assertNoSnapshots(root: string) {
  assert.equal(fs.readdirSync(root).filter((name) => name.startsWith("trajecta-release-snapshot-")).length, 0);
}

test("preflight freezes only the clean commit-tree allowlist into immutable outside-source bytes", () => {
  // Would fail if construction could read a mutable repository rather than the verified snapshot.
  const value = fixture();
  value.gitBin = gitBin();
  try {
    const snapshot = preflightSource({ sourceRoot: value.root, gitBin: value.gitBin, buildCommit: value.commit, policy: value.policy });
    assert.ok(path.isAbsolute(snapshot.root));
    assert.equal(snapshot.root.startsWith(`${path.resolve(value.root)}${path.sep}`), false);
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["input/nested/two.txt", "input/one.txt"]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.entries), true);
    fs.writeFileSync(path.join(value.root, "input", "one.txt"), "changed\n");
    assert.equal(fs.readFileSync(path.join(snapshot.root, "input", "one.txt"), "utf8"), "one\n");
    fs.rmSync(snapshot.root, { recursive: true, force: true });
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("preflight rejects invalid git executables and a commit other than HEAD before a snapshot exists", () => {
  // Would fail if Git behavior could be selected through PATH or a stale commit.
  const value = fixture();
  try {
    const link = path.join(value.root, "git-link");
    fs.symlinkSync(gitBin(), link);
    const nonExecutable = path.join(value.root, "not-executable");
    fs.writeFileSync(nonExecutable, "#!/bin/sh\n");
    for (const bad of ["git", path.join(value.root, "missing-git"), link, nonExecutable, process.execPath]) {
      assert.throws(() => preflightSource({ sourceRoot: value.root, gitBin: bad, buildCommit: value.commit, policy: value.policy }), undefined, bad);
      assertNoSnapshots(value.root);
    }
    assert.throws(() => preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: "a".repeat(40), policy: value.policy }));
    assertNoSnapshots(value.root);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("preflight rejects scoped staged, unstaged, untracked, deleted, symlinked, case-colliding and missing policy inputs", () => {
  // Would fail if the claimed commit differed from every byte later staged into the archive.
  const variants: Array<(value: Fixture) => void> = [
    (value) => { fs.writeFileSync(path.join(value.root, "input", "one.txt"), "changed\n"); },
    (value) => { fs.writeFileSync(path.join(value.root, "input", "one.txt"), "changed\n"); command("git", ["add", "input/one.txt"], value.root); },
    (value) => { fs.writeFileSync(path.join(value.root, "input", "new.txt"), "new\n"); },
    (value) => { fs.rmSync(path.join(value.root, "input", "one.txt")); },
    (value) => { fs.rmSync(path.join(value.root, "input", "one.txt")); fs.symlinkSync("nested/two.txt", path.join(value.root, "input", "one.txt")); },
    (value) => { fs.writeFileSync(path.join(value.root, "input", "ONE.txt"), "case\n"); },
  ];
  for (const mutate of variants) {
    const value = fixture();
    try {
      mutate(value);
      assert.throws(() => preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: value.commit, policy: value.policy }));
      assertNoSnapshots(value.root);
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
  }
  const missing = fixture();
  try {
    assert.throws(() => preflightSource({ sourceRoot: missing.root, gitBin: gitBin(), buildCommit: missing.commit, policy: { ...missing.policy, sourceRoots: ["missing/**/*.ts"] } }));
    assertNoSnapshots(missing.root);
  } finally { fs.rmSync(missing.root, { recursive: true, force: true }); }
});

test("preflight sanitizes Git configuration and detects a file changed while snapshotting", () => {
  // Would fail if hostile Git configuration or a time-of-check/time-of-use mutation reached construction.
  const value = fixture();
  try {
    command("git", ["config", "alias.status", "!false"], value.root);
    assert.doesNotThrow(() => {
      const snapshot = preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: value.commit, policy: value.policy });
      fs.rmSync(snapshot.root, { recursive: true, force: true });
    });
    assert.throws(() => preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: value.commit, policy: value.policy, beforeCopy: () => fs.writeFileSync(path.join(value.root, "input", "one.txt"), "race\n") }));
    assertNoSnapshots(value.root);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
