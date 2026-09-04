import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const example = new URL("../examples/verified-resume-proof.ts", import.meta.url).pathname;

function runIsolated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-clean-"));
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", example], {
      cwd: root,
      env: { ...process.env, TRAJECTA_PROOF_ROOT: path.join(root, ".trajecta") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, ".trajecta", "state.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".trajecta", "proof-attempts.jsonl")), true);
    assert.match(result.stdout, /REJECTED\s+REVISION_CONFLICT/);
    assert.match(result.stdout, /ACCEPTED\s+RESUMED/);
    assert.match(result.stdout, /same receipt \/ revision remains/);
    assert.doesNotMatch(result.stdout, /mst_|api[_ -]?key|pinksilkpham/i);
    return result.stdout
      .replace(/(?:work|branch|packet|receipt|delta):[A-Za-z0-9._-]+/g, "$ID")
      .replace(/2026-[^\s]+/g, "$TIME");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("P12 two clean roots reproduce the same semantic proof", () => {
  assert.equal(runIsolated(), runIsolated());
});
