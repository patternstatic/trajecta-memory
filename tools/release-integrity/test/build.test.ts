import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRelease } from "../src/build.ts";

test("build rejects an in-source signing key and never creates output before preflight", () => {
  // Would fail if an evaluation build could copy seller authority into source or create an artifact before its source gate.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-build-"));
  const root = path.join(parent, "source"), output = path.join(parent, "output"), privateKey = path.join(root, "seller-private.pem");
  fs.mkdirSync(root);
  fs.writeFileSync(privateKey, "not-a-key\n");
  try {
    assert.throws(() => buildRelease({ sourceRoot: root, gitBin: "/missing/git", npmCli: "/missing/npm", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", privateKey, publicKey: "/missing/public.pem", outputDir: output }), { code: "KEY_INSIDE_SOURCE" });
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test("build rejects an already-existing output before reading or constructing release inputs", () => {
  // Would fail if a repeated seller command could overwrite a previous evidence directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-build-"));
  const output = path.join(root, "outside");
  fs.mkdirSync(output);
  try {
    assert.throws(() => buildRelease({ sourceRoot: "/", gitBin: "/missing/git", npmCli: "/missing/npm", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", privateKey: "/missing/private.pem", publicKey: "/missing/public.pem", outputDir: output }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
