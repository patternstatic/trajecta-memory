import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BetaError,
  type BetaErrorCode,
  canonicalJson,
  canonicalSha256,
  MAX_ENVELOPE_BYTES,
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
  assert.throws(() => parseStrictJsonText('{"\\u0061":1,"a":2}'), errorCode("DUPLICATE_KEY"));
  assert.throws(() => parseStrictJsonText('[[[[[[[[[0]]]]]]]]]'), errorCode("JSON_TOO_DEEP"));
  assert.throws(() => parseStrictJsonText('{"a":1} true'), errorCode("INVALID_JSON"));
  assert.throws(() => parseStrictJsonBytes(Buffer.from([0xc3, 0x28])), errorCode("INVALID_UTF8"));
});

test("strict reader enforces the 16 KiB limit for direct text and bytes", () => {
  const text = `{"value":"${"x".repeat(16_384)}"}`;
  assert.throws(() => parseStrictJsonText(text), errorCode("FILE_TOO_LARGE"));
  assert.throws(() => parseStrictJsonBytes(Buffer.from(text)), errorCode("FILE_TOO_LARGE"));
  assert.equal(parseStrictJsonText(`0${" ".repeat(16_383)}`), 0);
});

test("strict reader rejects malformed controls and number tokens", () => {
  for (const input of ['"line\nbreak"', "01", "1.", "1e", "-", "+1"]) {
    assert.throws(() => parseStrictJsonText(input), errorCode("INVALID_JSON"));
  }
});

test("strict reader accepts exactly eight nested containers", () => {
  const input = `${"[".repeat(8)}0${"]".repeat(8)}`;
  assert.deepEqual(parseStrictJsonText(input), [[[[[[[ [0] ]]]]]]]);
});

test("missing or unreadable JSON files return a stable beta error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-beta-json-"));
  try {
    assert.throws(() => parseStrictJsonFile(path.join(root, "missing.json")), errorCode("INVALID_JSON"));
    assert.throws(() => parseStrictJsonFile(root), errorCode("INVALID_JSON"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strict reader rejects appended oversize data instead of truncating to an earlier boundary", () => {
  const { root, file } = writeRaw('{"value":1}');
  try {
    fs.appendFileSync(file, "x".repeat(MAX_ENVELOPE_BYTES));
    assert.throws(() => parseStrictJsonFile(file), errorCode("FILE_TOO_LARGE"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strict reader fails closed when the open file grows during read", () => {
  const { root, file } = writeRaw('{"value":1}');
  const require = createRequire(import.meta.url);
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const originalReadSync = nodeFs.readSync;
  let mutated = false;
  nodeFs.readSync = ((...args: Parameters<typeof originalReadSync>) => {
    if (!mutated) {
      mutated = true;
      fs.appendFileSync(file, " true");
    }
    return originalReadSync(...args);
  }) as typeof originalReadSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => parseStrictJsonFile(file), errorCode("INVALID_JSON"));
  } finally {
    nodeFs.readSync = originalReadSync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("canonical JSON rejects extra array keys and incomplete object properties", () => {
  const withExtraKey = [1] as unknown[] & Record<string, unknown>;
  withExtraKey["00"] = 2;
  assert.throws(() => canonicalJson(withExtraKey), errorCode("UNSUPPORTED_SCHEMA"));

  const withHidden = {};
  Object.defineProperty(withHidden, "hidden", { value: 1, enumerable: false });
  assert.throws(() => canonicalJson(withHidden), errorCode("UNSUPPORTED_SCHEMA"));

  const withGetter = {};
  Object.defineProperty(withGetter, "value", { get: () => 1, enumerable: true });
  assert.throws(() => canonicalJson(withGetter), errorCode("UNSUPPORTED_SCHEMA"));
});

test("canonical digest is stable for exact canonical UTF-8 bytes", () => {
  assert.equal(
    canonicalJson({ z: 2, a: 1 }),
    '{"a":1,"z":2}',
  );
  assert.equal(
    canonicalSha256({ z: 2, a: 1 }),
    "99168216144c7fed5d4c54916cf98d9c66096280c04a499822a99b6658bd177a",
  );
});
