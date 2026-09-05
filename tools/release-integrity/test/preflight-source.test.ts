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
  fs.writeFileSync(path.join(root, "LICENSE"), "fixture license\n");
  command("git", ["add", "input", "LICENSE"], root);
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

function removeLinkedWorktree(repository: string, linked: string) {
  try { command("git", ["worktree", "remove", "--force", linked], repository); }
  finally { fs.rmSync(linked, { recursive: true, force: true }); }
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
  const mixed = fixture();
  try {
    assert.throws(() => preflightSource({ sourceRoot: mixed.root, gitBin: gitBin(), buildCommit: mixed.commit, policy: { ...mixed.policy, sourceRoots: ["input/**/*.txt", "missing/**/*.ts"] } }));
    assertNoSnapshots(mixed.root);
  } finally { fs.rmSync(mixed.root, { recursive: true, force: true }); }
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

test("preflight binds descriptors to build-commit blobs despite a malicious local core.worktree", () => {
  // Would fail if local .git/config could point Git's cleanliness checks away from the bytes copied into a release snapshot.
  const value = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-external-worktree-"));
  try {
    fs.mkdirSync(path.join(outside, "input", "nested"), { recursive: true });
    fs.writeFileSync(path.join(outside, "input", "one.txt"), "one\n");
    fs.writeFileSync(path.join(outside, "input", "nested", "two.txt"), "two\n");
    command("git", ["config", "core.worktree", outside], value.root);
    fs.writeFileSync(path.join(value.root, "input", "one.txt"), "malicious\n");
    assert.throws(() => preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: value.commit, policy: value.policy }));
    assertNoSnapshots(value.root);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("literal policy roots do not widen status scanning to unrelated ignored-tool state", () => {
  // Would fail if a literal root such as LICENSE were normalized to '.' and made unrelated .superpowers state block release inputs.
  const value = fixture();
  try {
    fs.mkdirSync(path.join(value.root, ".superpowers"), { recursive: true });
    fs.writeFileSync(path.join(value.root, ".superpowers", "local-note"), "ignored by policy\n");
    const snapshot = preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: value.commit, policy: { ...value.policy, sourceRoots: ["LICENSE"] } });
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["LICENSE"]);
    fs.rmSync(snapshot.root, { recursive: true, force: true });
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("preflight accepts a standard linked Git worktree and the current linked worktree with exact metadata binding", () => {
  // Would fail if a valid .git gitdir pointer were treated as a directory-only repository or if metadata were not tied to its worktree.
  const repository = fixture();
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-linked-worktree-"));
  fs.rmSync(linked, { recursive: true, force: true });
  try {
    command("git", ["worktree", "add", "--detach", linked, repository.commit], repository.root);
    const snapshot = preflightSource({ sourceRoot: linked, gitBin: gitBin(), buildCommit: repository.commit, policy: repository.policy });
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["input/nested/two.txt", "input/one.txt"]);
    fs.rmSync(snapshot.root, { recursive: true, force: true });
    const currentRoot = process.cwd();
    const currentSnapshot = preflightSource({ sourceRoot: currentRoot, gitBin: gitBin(), buildCommit: command(gitBin(), ["rev-parse", "HEAD"], currentRoot), policy: { schema: "trajecta.release-payload-policy/v1", sourceRoots: ["LICENSE"], stagedPaths: [], exclusionList: [] } });
    assert.deepEqual(currentSnapshot.entries.map((entry) => entry.path), ["LICENSE"]);
    fs.rmSync(currentSnapshot.root, { recursive: true, force: true });
  } finally {
    removeLinkedWorktree(repository.root, linked);
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("preflight rejects symlinked, malformed, and unrelated .git pointer files", () => {
  // Would fail if an attacker could substitute a pointer that targets another repository or smuggle extra metadata lines.
  for (const pointer of ["gitdir: ../outside\nextra\n", "gitdir: ../outside\n"]) {
    const value = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-unrelated-git-"));
    try {
      fs.rmSync(path.join(value.root, ".git"), { recursive: true, force: true });
      fs.writeFileSync(path.join(value.root, ".git"), pointer, { mode: 0o644 });
      assert.throws(() => preflightSource({ sourceRoot: value.root, gitBin: gitBin(), buildCommit: value.commit, policy: value.policy }));
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
  const linked = fixture();
  try {
    const pointer = path.join(linked.root, ".git");
    fs.rmSync(pointer, { recursive: true, force: true });
    fs.symlinkSync(path.join(linked.root, "input", "one.txt"), pointer);
    assert.throws(() => preflightSource({ sourceRoot: linked.root, gitBin: gitBin(), buildCommit: linked.commit, policy: linked.policy }));
  } finally { fs.rmSync(linked.root, { recursive: true, force: true }); }
  const victim = fixture();
  const unrelated = fixture();
  const unrelatedWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-unrelated-worktree-"));
  fs.rmSync(unrelatedWorktree, { recursive: true, force: true });
  try {
    command("git", ["worktree", "add", "--detach", unrelatedWorktree, unrelated.commit], unrelated.root);
    const unrelatedPointer = fs.readFileSync(path.join(unrelatedWorktree, ".git"));
    fs.rmSync(path.join(victim.root, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(victim.root, ".git"), unrelatedPointer, { mode: 0o644 });
    assert.throws(() => preflightSource({ sourceRoot: victim.root, gitBin: gitBin(), buildCommit: victim.commit, policy: victim.policy }));
  } finally {
    removeLinkedWorktree(unrelated.root, unrelatedWorktree);
    fs.rmSync(victim.root, { recursive: true, force: true });
    fs.rmSync(unrelated.root, { recursive: true, force: true });
  }
});
