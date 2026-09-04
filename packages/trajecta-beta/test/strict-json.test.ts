import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BetaError,
  type BetaErrorCode,
  canonicalJson,
  canonicalSha256,
  parseStrictJsonBytes,
  parseStrictJsonFile,
  parseStrictJsonText,
} from "../src/index.ts";

function errorCode(code: BetaErrorCode) {
  return (error: unknown) => error instanceof BetaError && error.code === code;
}

function writeRaw(contents: string | Uint8Array) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-beta-json-"));
  const file = path.join(root, "input.json");
  fs.writeFileSync(file, contents);
  return { root, file };
}

test("strict reader rejects before parsing when the file exceeds 16 KiB", () => {
  const { root, file } = writeRaw(`{"value":"${"x".repeat(16_384)}"}`);
  try {
    assert.throws(() => parseStrictJsonFile(file), errorCode("FILE_TOO_LARGE"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strict reader rejects duplicate keys, depth nine, trailing data, and invalid UTF-8", () => {
  assert.throws(() => parseStrictJsonText('{"a":1,"a":2}'), errorCode("DUPLICATE_KEY"));
  assert.throws(() => parseStrictJsonText('[[[[[[[[[0]]]]]]]]]'), errorCode("JSON_TOO_DEEP"));
  assert.throws(() => parseStrictJsonText('{"a":1} true'), errorCode("INVALID_JSON"));
  assert.throws(() => parseStrictJsonBytes(Buffer.from([0xc3, 0x28])), errorCode("INVALID_UTF8"));
});

test("canonical JSON is insertion-order independent and locale independent", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, b: 2 } }),
    '{"a":{"b":2,"y":true},"z":1}',
  );
});

test("canonical digest changes on a material value change", () => {
  assert.notEqual(canonicalSha256({ value: "left" }), canonicalSha256({ value: "right" }));
});
