import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { buildOptionsFromCli, parseReleaseCli } from "../src/cli.ts";

const required = ["--private-key", "/outside/private.pem", "--public-key", "/outside/public.pem", "--git-bin", "/usr/bin/git", "--npm-cli", "/outside/npm-cli.js", "--build-commit", "a".repeat(40), "--release-instant", "2026-09-05T00:00:00Z", "--verification-instant", "2026-09-05T00:00:00Z", "--output-dir", "/outside/out"];

test("build CLI accepts one complete explicit frozen input set", () => {
  // Would fail if seller builds could fill security or reproducibility inputs from ambient state.
  assert.deepEqual(parseReleaseCli(["build", ...required]), {
    command: "build", privateKey: "/outside/private.pem", publicKey: "/outside/public.pem", gitBin: "/usr/bin/git", npmCli: "/outside/npm-cli.js", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/out",
  });
});

test("CLI rejects unknown, duplicate, empty, and missing frozen flags", () => {
  // Would fail if an ambiguous command selected an unreviewed default or silently ignored operator input.
  for (const argv of [["build", ...required, "--unknown", "x"], ["build", ...required, "--git-bin", "/again"], ["build", ...required.slice(0, -2)], ["build", ...required.map(value => value === "/outside/out" ? "" : value)]]) assert.throws(() => parseReleaseCli(argv));
});

test("CLI removes its command discriminator before passing exact build inputs", () => {
  // Would fail if the CLI-only command field caused the strict build input gate to reject a legitimate invocation.
  const parsed = parseReleaseCli(["build", ...required]);
  assert.deepEqual(buildOptionsFromCli(parsed, "/source"), {
    sourceRoot: "/source", privateKey: "/outside/private.pem", publicKey: "/outside/public.pem", gitBin: "/usr/bin/git", npmCli: "/outside/npm-cli.js", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/out",
  });
});

test("audit and verify require independently pinned archive trust inputs", () => {
  // Would fail if a post-delivery operation could infer a seller key or archive hash from a mutable local archive.
  const audit = ["--archive", "/outside/release.zip", "--public-key", "/outside/public.pem", "--key-fingerprint", "b".repeat(64), "--release-instant", "2026-09-05T00:00:00Z"];
  assert.deepEqual(parseReleaseCli(["audit", ...audit]), { command: "audit", archive: "/outside/release.zip", publicKey: "/outside/public.pem", keyFingerprint: "b".repeat(64), releaseInstant: "2026-09-05T00:00:00Z" });
  assert.deepEqual(parseReleaseCli(["verify", ...audit, "--output-dir", "/outside/extract"]), { command: "verify", archive: "/outside/release.zip", publicKey: "/outside/public.pem", keyFingerprint: "b".repeat(64), releaseInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/extract" });
  assert.throws(() => parseReleaseCli(["verify", ...audit]));
  assert.throws(() => parseReleaseCli(["audit", ...audit, "--output-dir", "/outside/nope"]));
});

test("seller executable invokes the CLI and returns a bounded diagnostic", () => {
  // Would fail if the published seller entrypoint only imported helpers without executing the command.
  const bin = new URL("../bin/trajecta-release", import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [bin, "unknown"], { cwd: path.dirname(new URL(import.meta.url).pathname), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (error: unknown) => String((error as { stderr?: unknown }).stderr).includes("INVALID_COMMAND"));
});
