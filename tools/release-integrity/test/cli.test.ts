import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildOptionsFromCli, parseReleaseCli } from "../src/cli.ts";
import { assembleBundle, DOCUMENT_PATHS } from "../src/assemble.ts";
import { createDeterministicTgz } from "../src/deterministic-tgz.ts";
import { sha256Hex } from "../src/canonical.ts";

const required = ["--private-key", "/outside/private.pem", "--public-key", "/outside/public.pem", "--git-bin", "/usr/bin/git", "--npm-cli", "/outside/npm-cli.js", "--build-commit", "a".repeat(40), "--release-instant", "2026-09-05T00:00:00Z", "--verification-instant", "2026-09-05T00:00:00Z", "--output-dir", "/outside/out"];

test("build CLI accepts one complete explicit frozen input set", () => {
  // Would fail if seller builds could fill security or reproducibility inputs from ambient state.
  assert.deepEqual(parseReleaseCli(["build", ...required]), {
    command: "build", privateKey: "/outside/private.pem", publicKey: "/outside/public.pem", gitBin: "/usr/bin/git", npmCli: "/outside/npm-cli.js", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/out",
  });
});

test("commercial candidate build is an explicit closed CLI command", () => {
  const parsed = parseReleaseCli(["build-commercial-candidate", ...required]);
  assert.deepEqual(parsed, {
    command: "build-commercial-candidate", privateKey: "/outside/private.pem", publicKey: "/outside/public.pem", gitBin: "/usr/bin/git", npmCli: "/outside/npm-cli.js", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/out",
  });
  assert.deepEqual(buildOptionsFromCli(parsed, "/source"), {
    sourceRoot: "/source", releaseKind: "commercial-candidate", privateKey: "/outside/private.pem", publicKey: "/outside/public.pem", gitBin: "/usr/bin/git", npmCli: "/outside/npm-cli.js", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/out",
  });
  assert.throws(() => parseReleaseCli(["build-commercial", ...required]));
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
  const audit = ["--archive", "/outside/release.zip", "--archive-sha256", "a".repeat(64), "--public-key", "/outside/public.pem", "--key-fingerprint", "b".repeat(64), "--release-instant", "2026-09-05T00:00:00Z"];
  assert.deepEqual(parseReleaseCli(["audit", ...audit]), { command: "audit", archive: "/outside/release.zip", archiveSha256: "a".repeat(64), publicKey: "/outside/public.pem", keyFingerprint: "b".repeat(64), releaseInstant: "2026-09-05T00:00:00Z" });
  assert.deepEqual(parseReleaseCli(["verify", ...audit, "--output-dir", "/outside/extract"]), { command: "verify", archive: "/outside/release.zip", archiveSha256: "a".repeat(64), publicKey: "/outside/public.pem", keyFingerprint: "b".repeat(64), releaseInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/extract" });
  assert.throws(() => parseReleaseCli(["verify", ...audit]));
  assert.throws(() => parseReleaseCli(["audit", ...audit, "--output-dir", "/outside/nope"]));
});

test("verify rejects a valid signed archive when its independently pinned digest is wrong and creates no output", () => {
  // Would fail if verify derived trust from the archive it was supposed to authenticate.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-cli-pin-"));
  const keys = generateKeyPairSync("ed25519"), publicKey = path.join(root, "public.pem"), archive = path.join(root, "release.zip"), output = path.join(root, "extract");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const instant = "2026-09-05T00:00:00Z", entries = [{ path: "package/LICENSE", bytes: Buffer.from("license"), mode: "0644" as const }, { path: "package/LICENSES/CORE-MODIFICATIONS.txt", bytes: Buffer.from("notice"), mode: "0644" as const }, { path: "package/NOTICE", bytes: Buffer.from("core-notice"), mode: "0644" as const }, { path: "package/beta/DEVELOPMENT-BOUNDARY.md", bytes: Buffer.from("boundary"), mode: "0644" as const }, { path: "package/package.json", bytes: Buffer.from("{}"), mode: "0644" as const }];
  try {
    const tgz = createDeterministicTgz(entries, instant), ledger = entries.map(entry => ({ path: entry.path.slice("package/".length), bytes: entry.bytes.length, sha256: sha256Hex(entry.bytes), mode: entry.mode, originalClass: "notice" as const }));
    const docs = new Map(DOCUMENT_PATHS.map(name => [name, Buffer.from("evaluation")])); docs.set("LICENSES/CORE-APACHE-2.0.txt", Buffer.from("license")); docs.set("LICENSES/CORE-NOTICE.txt", Buffer.from("core-notice\nnotice"));
    const assembled = assembleBundle({ tgz, memberLedger: ledger, documents: docs, buildCommit: "a".repeat(40), releaseInstant: instant, verificationInstant: instant, publicKeyPem, privateKeyPem });
    fs.writeFileSync(publicKey, publicKeyPem); fs.writeFileSync(archive, assembled.zip);
    const bin = new URL("../bin/trajecta-release", import.meta.url).pathname;
    assert.throws(() => execFileSync(process.execPath, [bin, "verify", "--archive", archive, "--archive-sha256", "0".repeat(64), "--public-key", publicKey, "--key-fingerprint", assembled.publicKeyFingerprint, "--release-instant", instant, "--output-dir", output], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (error: unknown) => String((error as { stderr?: unknown }).stderr).includes("MANIFEST_MISMATCH"));
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("seller executable invokes the CLI and returns a bounded diagnostic", () => {
  // Would fail if the published seller entrypoint only imported helpers without executing the command.
  const bin = new URL("../bin/trajecta-release", import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [bin, "unknown"], { cwd: path.dirname(new URL(import.meta.url).pathname), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (error: unknown) => String((error as { stderr?: unknown }).stderr).includes("INVALID_COMMAND"));
});
