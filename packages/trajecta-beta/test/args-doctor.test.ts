import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CliUsageError,
  parseCliArgs,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  runDoctor,
} from "../src/index.ts";

function makeWorkspace(remote = "https://user:token@github.com/patternstatic/trajecta-memory.git") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "trajecta-doctor-"));
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["config", "user.name", "Trajecta Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root });
  execFileSync("git", ["config", "remote.origin.url", remote], { cwd: root });
  return { root, stateRoot: path.join(root, ".trajecta-beta") };
}

function treeDigest(root: string): string {
  if (!fs.existsSync(root)) return "missing";
  const digest = createHash("sha256");
  const visit = (current: string, relative: string) => {
    const entry = fs.lstatSync(current);
    digest.update(`${relative}\u0000${entry.mode & 0o777}\u0000${entry.size}\u0000`);
    if (entry.isSymbolicLink()) digest.update(fs.readlinkSync(current));
    else if (entry.isFile()) digest.update(fs.readFileSync(current));
    else if (entry.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
    }
  };
  visit(root, ".");
  return digest.digest("hex");
}

function supportedDoctor(cwd: string) {
  return runDoctor({ cwd, platform: "darwin", architecture: "arm64", nodeVersion: "22.19.0" });
}

function usageError(error: unknown): boolean {
  return error instanceof CliUsageError;
}

test("parses each supported command into its sole exact invocation", () => {
  // Would fail if any command is routed to a permissive or wrong invocation member.
  assert.deepEqual(parseCliArgs(["doctor"]), { kind: "doctor", stateRoot: null });
  assert.deepEqual(parseCliArgs(["doctor", "--state-root", "state"]), { kind: "doctor", stateRoot: "state" });
  assert.deepEqual(parseCliArgs(["demo"]), { kind: "demo", stateRoot: null });
  assert.deepEqual(parseCliArgs(["host", "init", "--out", "card.json", "--state-root", "state"]), { kind: "host-init", stateRoot: "state", out: "card.json" });
  assert.deepEqual(parseCliArgs(["inspect", "handoff.json"]), { kind: "inspect", file: "handoff.json", stateRoot: null });
  assert.deepEqual(parseCliArgs(["resume", "handoff.json", "--accept"]), { kind: "resume", file: "handoff.json", stateRoot: null, accept: true });
  assert.deepEqual(parseCliArgs(["resume", "handoff.json", "--state-root", "state"]), { kind: "resume", file: "handoff.json", stateRoot: "state", accept: false });
  assert.deepEqual(parseCliArgs(["receipt", "operation:fixture", "--state-root", "state"]), { kind: "receipt", operationId: "operation:fixture", stateRoot: "state" });
  assert.deepEqual(parseCliArgs([
    "verify-acceptance",
    "--archive", "/delivery.zip",
    "--pinned-zip-sha256", "a".repeat(64),
    "--bundle-root", "/unpacked",
    "--public-key", "/independent-public.pem",
    "--state-root", "/new-state",
    "--evidence-dir", "/new-evidence",
  ]), {
    kind: "verify-acceptance",
    archivePath: "/delivery.zip",
    pinnedZipSha256: "a".repeat(64),
    bundleRoot: "/unpacked",
    publicKeyPath: "/independent-public.pem",
    stateRoot: "/new-state",
    evidenceDir: "/new-evidence",
  });
  assert.deepEqual(parseCliArgs(["version"]), { kind: "version" });
});

test("parser rejects ambiguous, repeated, empty, and equals-style arguments", () => {
  // Would fail if a caller could smuggle an extra argument or alter confirmation semantics.
  for (const argv of [
    [], ["doctor", "extra"], ["doctor", "--wat"], ["doctor", "--state-root", "one", "--state-root", "two"],
    ["doctor", "--state-root", ""], ["doctor", "--state-root"], ["resume", "handoff", "--accept", "--accept"],
    ["resume", "handoff", "--accept=value"], ["resume", "handoff", "--state-root=value"], ["doctor", "--state-root", "../outside"], ["inspect", ""],
    ["host"], ["host", "init", "--out"], ["version", "--state-root", "state"],
    ["verify-acceptance", "--archive", "/delivery.zip"],
    ["verify-acceptance", "--archive", "/delivery.zip", "--archive", "/other.zip", "--pinned-zip-sha256", "a".repeat(64), "--bundle-root", "/unpacked", "--public-key", "/key.pem", "--state-root", "/state", "--evidence-dir", "/evidence"],
    ["verify-acceptance", "--archive", "/delivery.zip", "--pinned-zip-sha256", "a".repeat(64), "--bundle-root", "/unpacked", "--public-key", "/key.pem", "--state-root", "/state", "--evidence-dir", "/evidence", "--unknown", "value"],
    ["doctor", "--archive", "/delivery.zip"],
  ]) assert.throws(() => parseCliArgs(argv), usageError, argv.join(" "));
});

test("doctor exposes the beta identity and leaves a fresh default state root absent", () => {
  // Would fail if doctor creates private state or leaks the credential-bearing remote/home path.
  const fixture = makeWorkspace();
  try {
    const before = treeDigest(fixture.stateRoot);
    const result = supportedDoctor(fixture.root);
    const after = treeDigest(fixture.stateRoot);
    const rendered = JSON.stringify(result);
    assert.equal(PRODUCT_NAME, "Trajecta Verified Resume SDK Beta");
    assert.equal(PRODUCT_VERSION, "0.1.0");
    assert.equal(result.exitCode, 0);
    assert.equal(result.code, "OK");
    assert.equal(result.repository, "github.com/patternstatic/trajecta-memory");
    assert.match(rendered, /github\.com\/patternstatic\/trajecta-memory/);
    assert.ok(!rendered.includes("user:token"));
    assert.ok(!rendered.includes(os.homedir()));
    assert.equal(after, before);
    assert.equal(fs.existsSync(fixture.stateRoot), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor returns unsupported-environment for each unsupported host requirement without writes", () => {
  // Would fail if a hard host requirement is ignored or a failed diagnostic mutates state.
  const fixture = makeWorkspace();
  try {
    for (const environment of [
      { platform: "linux", architecture: "arm64", nodeVersion: "22.19.0" },
      { platform: "darwin", architecture: "x64", nodeVersion: "22.19.0" },
      { platform: "darwin", architecture: "arm64", nodeVersion: "23.0.0" },
      { platform: "darwin", architecture: "arm64", nodeVersion: "22.19.0-rc.1" },
      { platform: "darwin", architecture: "arm64", nodeVersion: "022.19.0" },
      { platform: "darwin", architecture: "arm64", nodeVersion: "22.019.0" },
      { platform: "darwin", architecture: "arm64", nodeVersion: "22.19.00" },
    ]) {
      const before = treeDigest(fixture.stateRoot);
      const result = runDoctor({ cwd: fixture.root, ...environment });
      assert.equal(result.code, "UNSUPPORTED_ENVIRONMENT");
      assert.equal(result.exitCode, 2);
      assert.equal(treeDigest(fixture.stateRoot), before);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor accepts only canonical SemVer cores at the supported node boundaries", () => {
  // Would fail if coercion lets a noncanonical version string enter the supported range.
  const fixture = makeWorkspace();
  try {
    for (const nodeVersion of ["22.19.0", "22.19.0+build.1", "22.99.999", "22.18.999", "23.0.0"]) {
      const result = runDoctor({ cwd: fixture.root, platform: "darwin", architecture: "arm64", nodeVersion });
      assert.equal(result.code, ["22.19.0", "22.19.0+build.1", "22.99.999"].includes(nodeVersion) ? "OK" : "UNSUPPORTED_ENVIRONMENT", nodeVersion);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor turns an unreadable persistent writer lock into operation-in-doubt without changing it", () => {
  // Would fail if doctor treats damaged durable writer evidence as safe or attempts a repair.
  const fixture = makeWorkspace();
  try {
    fs.mkdirSync(path.join(fixture.stateRoot, "locks"), { recursive: true, mode: 0o700 });
    fs.chmodSync(fixture.stateRoot, 0o700);
    fs.chmodSync(path.join(fixture.stateRoot, "locks"), 0o700);
    const lock = path.join(fixture.stateRoot, "locks", "writer.lock");
    fs.writeFileSync(lock, "not-json\n", { mode: 0o600 });
    fs.chmodSync(lock, 0o600);
    const before = treeDigest(fixture.stateRoot);
    const result = supportedDoctor(fixture.root);
    assert.equal(result.code, "OPERATION_IN_DOUBT");
    assert.equal(result.exitCode, 2);
    assert.equal(treeDigest(fixture.stateRoot), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor rejects an insecure existing state root as unsupported before probing writer evidence", () => {
  // Would fail if a hard state-root requirement were misreported as a mutable-writer uncertainty.
  const fixture = makeWorkspace();
  try {
    fs.mkdirSync(fixture.stateRoot, { mode: 0o755 });
    fs.chmodSync(fixture.stateRoot, 0o755);
    const before = treeDigest(fixture.stateRoot);
    const result = supportedDoctor(fixture.root);
    assert.equal(result.code, "UNSUPPORTED_ENVIRONMENT");
    assert.equal(result.exitCode, 2);
    assert.equal(treeDigest(fixture.stateRoot), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
