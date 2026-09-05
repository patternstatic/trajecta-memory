import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { packPackage } from "../src/pack-package.ts";
import { auditTgz } from "../src/tar-reader.ts";
import { ReleaseIntegrityError } from "../src/errors.ts";
import type { StagedMember } from "../src/stage-package.ts";

let sequence = 0;
const instant = "2026-09-05T00:00:00Z";

function temporaryPackage(): { root: string; members: readonly StagedMember[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `trajecta-tgz-${process.pid}-${sequence++}-`));
  const entries: Array<[string, string, "0644" | "0755", StagedMember["originalClass"]]> = [
    ["package.json", "{\"name\":\"@patternstatic/trajecta-beta\"}\n", "0644", "commercial-beta"],
    ["bin/trajecta-beta", "#!/usr/bin/env node\n", "0755", "commercial-beta"],
    ["beta/DEVELOPMENT-BOUNDARY.md", "Evaluation boundary.\n", "0644", "documentation"],
    ["LICENSES/CORE-MODIFICATIONS.txt", "No modifications.\n", "0644", "notice"],
    ["core/src/index.ts", "export {};\n", "0644", "apache-core"],
  ];
  const members = entries.map(([memberPath, contents, mode, originalClass]) => {
    const bytes = Buffer.from(contents, "utf8");
    const destination = path.join(root, memberPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { mode: Number.parseInt(mode, 8) });
    fs.chmodSync(destination, Number.parseInt(mode, 8));
    return Object.freeze({ path: memberPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode, originalClass });
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { root, members: Object.freeze(members) };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ReleaseIntegrityError && error.code === code);
}

function octal(value: number, width: number): Buffer {
  const field = Buffer.alloc(width, 0);
  Buffer.from(value.toString(8).padStart(width - 1, "0")).copy(field);
  return field;
}

function header(name: string, data: Buffer, type = "0", mode = 0o644): Buffer {
  const value = Buffer.alloc(512, 0);
  Buffer.from(name).copy(value, 0);
  octal(mode, 8).copy(value, 100);
  octal(0, 8).copy(value, 108);
  octal(0, 8).copy(value, 116);
  octal(data.length, 12).copy(value, 124);
  octal(Math.floor(Date.parse(instant) / 1000), 12).copy(value, 136);
  value.fill(0x20, 148, 156);
  value[156] = type.charCodeAt(0);
  Buffer.from("ustar\0").copy(value, 257);
  Buffer.from("00").copy(value, 263);
  const checksum = value.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(value, 148);
  return value;
}

function tar(entries: Array<{ name: string; data?: Buffer; type?: string; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(header(entry.name, data, entry.type, entry.mode));
    parts.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function canonicalGzip(stream: Buffer): Buffer {
  const gzip = gzipSync(stream, { mtime: 0 });
  gzip[8] = 0;
  gzip[9] = 255;
  return gzip;
}

test("packs deterministic bounded ustar bytes and binds every regular member into one ledger", () => {
  const staged = temporaryPackage();
  const first = packPackage({ packageRoot: staged.root, members: staged.members, releaseInstant: instant });
  const second = packPackage({ packageRoot: staged.root, members: staged.members, releaseInstant: instant });
  assert.deepEqual(first.tgz, second.tgz);
  assert.deepEqual(first.memberLedger, staged.members);
  assert.equal(first.tgz[4], 0);
  assert.equal(first.tgz[5], 0);
  assert.equal(first.tgz[6], 0);
  assert.equal(first.tgz[7], 0);
  assert.equal(first.tgz[8], 0);
  assert.equal(first.tgz[9], 255);
  assert.deepEqual(auditTgz(first.tgz, { releaseInstant: instant, expectedMembers: staged.members }).memberLedger, staged.members);
});

test("rejects tar traversal, duplicate/case-colliding names, links, PAX records, and bad gzip headers", () => {
  const staged = temporaryPackage();
  const packed = packPackage({ packageRoot: staged.root, members: staged.members, releaseInstant: instant });
  for (const [label, bytes, code] of [
    ["traversal", canonicalGzip(tar([{ name: "../escape", data: Buffer.from("x") }])), "UNSAFE_TAR_PATH"],
    ["duplicate", canonicalGzip(tar([{ name: "a", data: Buffer.from("x") }, { name: "a", data: Buffer.from("y") }])), "DUPLICATE_TAR_MEMBER"],
    ["case", canonicalGzip(tar([{ name: "a", data: Buffer.from("x") }, { name: "A", data: Buffer.from("y") }])), "CASE_COLLISION"],
    ["link", canonicalGzip(tar([{ name: "a", type: "2" }])), "UNSUPPORTED_TAR_ENTRY"],
    ["device", canonicalGzip(tar([{ name: "a", type: "3" }])), "UNSUPPORTED_TAR_ENTRY"],
    ["sparse", canonicalGzip(tar([{ name: "a", type: "S" }])), "UNSUPPORTED_TAR_ENTRY"],
    ["pax", canonicalGzip(tar([{ name: "pax", type: "x", data: Buffer.from("10 path=a\n") }])), "UNSUPPORTED_TAR_ENTRY"],
  ] as const) {
    assert.ok(label);
    expectCode(() => auditTgz(bytes, { releaseInstant: instant }), code);
  }
  const badHeader = Buffer.from(packed.tgz);
  badHeader[9] = 3;
  expectCode(() => auditTgz(badHeader, { releaseInstant: instant }), "INVALID_GZIP_HEADER");
});

test("rejects non-canonical tar metadata, ordering, bounds, and a ledger that misses required package members", () => {
  const staged = temporaryPackage();
  const packed = packPackage({ packageRoot: staged.root, members: staged.members, releaseInstant: instant });
  const wrongMode = tar([{ name: "package.json", data: Buffer.from("{}\n"), mode: 0o600 }]);
  expectCode(() => auditTgz(canonicalGzip(wrongMode), { releaseInstant: instant }), "INVALID_TAR_MODE");
  const wrongExecutable = tar([{ name: "not-bin", data: Buffer.from("x"), mode: 0o755 }]);
  expectCode(() => auditTgz(canonicalGzip(wrongExecutable), { releaseInstant: instant }), "INVALID_TAR_MODE");
  const unordered = tar([{ name: "z", data: Buffer.from("x") }, { name: "a", data: Buffer.from("x") }]);
  expectCode(() => auditTgz(canonicalGzip(unordered), { releaseInstant: instant }), "NONCANONICAL_TAR_ORDER");
  expectCode(() => auditTgz(packed.tgz, { releaseInstant: instant, expectedMembers: staged.members.slice(1) }), "TAR_MEMBER_SET_MISMATCH");
  const mismatched = [...staged.members];
  mismatched[0] = { ...mismatched[0], sha256: "0".repeat(64) };
  expectCode(() => auditTgz(packed.tgz, { releaseInstant: instant, expectedMembers: mismatched }), "TAR_LEDGER_MISMATCH");
  expectCode(() => auditTgz(packed.tgz, { releaseInstant: instant, limits: { maxMembers: 1 } }), "TAR_LIMIT_EXCEEDED");
  const tooDeep = tar([{ name: "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q", data: Buffer.from("x") }]);
  expectCode(() => auditTgz(canonicalGzip(tooDeep), { releaseInstant: instant }), "TAR_LIMIT_EXCEEDED");
  const highRatio = tar([{ name: "compressible", data: Buffer.alloc(8 * 1024, 0) }]);
  expectCode(() => auditTgz(canonicalGzip(highRatio), { releaseInstant: instant, limits: { maxCompressionRatio: 1 } }), "TAR_LIMIT_EXCEEDED");
});

test("fails closed when either mandatory in-package boundary notice is absent", () => {
  for (const mandatory of ["beta/DEVELOPMENT-BOUNDARY.md", "LICENSES/CORE-MODIFICATIONS.txt"]) {
    const staged = temporaryPackage();
    fs.unlinkSync(path.join(staged.root, mandatory));
    const members = staged.members.filter((member) => member.path !== mandatory);
    expectCode(() => packPackage({ packageRoot: staged.root, members, releaseInstant: instant }), "REQUIRED_TAR_MEMBER_MISSING");
  }
});
