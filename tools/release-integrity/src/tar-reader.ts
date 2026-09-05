import { gunzipSync } from "node:zlib";
import { sha256Hex } from "./canonical.ts";
import { assertSafeArchivePath, parseReleaseInstant, type OriginalLicenseClass } from "./contracts.ts";
import { ReleaseIntegrityError, releaseError } from "./errors.ts";

export interface TarLedgerMember {
  path: string;
  bytes: number;
  sha256: string;
  mode: "0644" | "0755";
  originalClass: OriginalLicenseClass;
}

export interface TarAuditLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxMembers: number;
  maxMemberBytes: number;
  maxPathDepth: number;
  maxCompressionRatio: number;
}

export interface AuditTgzOptions {
  releaseInstant: unknown;
  expectedMembers?: readonly TarLedgerMember[];
  limits?: Partial<TarAuditLimits>;
}

export interface AuditedTgz {
  memberLedger: readonly TarLedgerMember[];
}

const DEFAULT_LIMITS: TarAuditLimits = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxMembers: 512,
  maxMemberBytes: 16 * 1024 * 1024,
  maxPathDepth: 16,
  maxCompressionRatio: 100,
});
const REQUIRED_PACKAGE_MEMBERS = ["beta/DEVELOPMENT-BOUNDARY.md", "LICENSES/CORE-MODIFICATIONS.txt"] as const;

function limitsFor(value: Partial<TarAuditLimits> | undefined): TarAuditLimits {
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const limit of Object.values(limits)) if (!Number.isSafeInteger(limit) || limit <= 0) releaseError("INVALID_TAR_LIMIT", "Tar audit limits must be positive bounded integers.");
  return limits;
}

function exactBuffer(bytes: Buffer, offset: number, expected: Buffer): boolean {
  return bytes.subarray(offset, offset + expected.length).equals(expected);
}

function zeroBuffer(bytes: Buffer, offset: number, width: number): boolean {
  for (let index = offset; index < offset + width; index++) if (bytes[index] !== 0) return false;
  return true;
}

function parseOctal(header: Buffer, offset: number, width: number, field: string): number {
  const data = header.subarray(offset, offset + width);
  if (data[width - 1] !== 0 || !/^[0-7]+$/.test(data.subarray(0, width - 1).toString("ascii"))) releaseError("INVALID_TAR_HEADER", `Tar ${field} is not canonically encoded.`);
  const parsed = Number.parseInt(data.subarray(0, width - 1).toString("ascii"), 8);
  if (!Number.isSafeInteger(parsed)) releaseError("INVALID_TAR_HEADER", `Tar ${field} is out of range.`);
  return parsed;
}

function parseString(header: Buffer, offset: number, width: number, field: string): string {
  const data = header.subarray(offset, offset + width);
  const terminator = data.indexOf(0);
  const body = terminator < 0 ? data : data.subarray(0, terminator);
  if (terminator >= 0 && !zeroBuffer(header, offset + terminator, width - terminator)) releaseError("INVALID_TAR_HEADER", `Tar ${field} is not zero padded.`);
  if (!/^[\x20-\x7e]*$/.test(body.toString("ascii"))) releaseError("INVALID_TAR_HEADER", `Tar ${field} must be ASCII.`);
  return body.toString("ascii");
}

function headerChecksum(header: Buffer): number {
  let checksum = 0;
  for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  return checksum;
}

function assertCanonicalHeader(header: Buffer, releaseSeconds: number): { path: string; bytes: number; mode: "0644" | "0755" } {
  if (!exactBuffer(header, 257, Buffer.from("ustar\0", "ascii")) || !exactBuffer(header, 263, Buffer.from("00", "ascii"))) releaseError("UNSUPPORTED_TAR_HEADER", "Tar must use POSIX ustar headers.");
  const checksumField = header.subarray(148, 156);
  if (!/^[0-7]{6}\0 $/.test(checksumField.toString("ascii")) || Number.parseInt(checksumField.subarray(0, 6).toString("ascii"), 8) !== headerChecksum(header)) releaseError("INVALID_TAR_HEADER", "Tar header checksum is invalid.");
  const modeValue = parseOctal(header, 100, 8, "mode");
  if (modeValue !== 0o644 && modeValue !== 0o755) releaseError("INVALID_TAR_MODE", "Tar member mode is unsupported.");
  if (parseOctal(header, 108, 8, "uid") !== 0 || parseOctal(header, 116, 8, "gid") !== 0 || parseOctal(header, 136, 12, "mtime") !== releaseSeconds) releaseError("NONCANONICAL_TAR_HEADER", "Tar ownership or timestamp is non-canonical.");
  if (!zeroBuffer(header, 265, 32) || !zeroBuffer(header, 297, 32) || !zeroBuffer(header, 329, 8) || !zeroBuffer(header, 337, 8) || !zeroBuffer(header, 157, 100) || !zeroBuffer(header, 500, 12)) releaseError("NONCANONICAL_TAR_HEADER", "Tar identity, device, link, or reserved fields must be empty.");
  if (header[156] !== "0".charCodeAt(0)) releaseError("UNSUPPORTED_TAR_ENTRY", "Tar may contain only regular files.");
  const name = parseString(header, 0, 100, "name");
  const prefix = parseString(header, 345, 155, "prefix");
  let memberPath: string;
  try { memberPath = assertSafeArchivePath(prefix ? `${prefix}/${name}` : name); }
  catch (error) {
    if (error instanceof ReleaseIntegrityError && error.code === "UNSAFE_PATH") return releaseError("UNSAFE_TAR_PATH", "Tar member path is unsafe.");
    throw error;
  }
  return { path: memberPath, bytes: parseOctal(header, 124, 12, "size"), mode: modeValue === 0o755 ? "0755" : "0644" };
}

function assertGzipHeader(bytes: Buffer, limits: TarAuditLimits): void {
  if (bytes.length < 18 || bytes.length > limits.maxCompressedBytes) releaseError("TAR_LIMIT_EXCEEDED", "Compressed tarball exceeds its bound.");
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || bytes[3] !== 0 || bytes[4] !== 0 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0 || bytes[8] !== 0 || bytes[9] !== 255) releaseError("INVALID_GZIP_HEADER", "Gzip header is not canonical.");
}

function matchesExpected(actual: readonly TarLedgerMember[], expected: readonly TarLedgerMember[]): boolean {
  return actual.length === expected.length && actual.every((member, index) => {
    const wanted = expected[index];
    return member.path === wanted.path && member.bytes === wanted.bytes && member.sha256 === wanted.sha256 && member.mode === wanted.mode && member.originalClass === wanted.originalClass;
  });
}

/** Decodes a canonical tgz only after all bounded header checks pass. */
export function auditTgz(tgz: Buffer, options: AuditTgzOptions): AuditedTgz {
  const limits = limitsFor(options.limits);
  const releaseSeconds = Math.floor(parseReleaseInstant(options.releaseInstant).valueOf() / 1000);
  assertGzipHeader(tgz, limits);
  let stream: Buffer;
  try { stream = gunzipSync(tgz, { maxOutputLength: limits.maxUncompressedBytes }); }
  catch { return releaseError("INVALID_TGZ", "Tarball gzip stream is invalid or exceeds its bound."); }
  if (stream.length < 1024 || stream.length > limits.maxUncompressedBytes || stream.length > tgz.length * limits.maxCompressionRatio) releaseError("TAR_LIMIT_EXCEEDED", "Uncompressed tarball exceeds its bound.");
  const members: TarLedgerMember[] = [];
  const names = new Set<string>();
  const folded = new Set<string>();
  let cursor = 0;
  let previous = "";
  let sawEnd = false;
  while (cursor < stream.length) {
    if (cursor + 512 > stream.length) releaseError("INVALID_TAR_HEADER", "Tar stream ends in a partial header.");
    const header = stream.subarray(cursor, cursor + 512);
    if (zeroBuffer(header, 0, 512)) {
      if (cursor + 1024 !== stream.length || !zeroBuffer(stream, cursor + 512, 512)) releaseError("INVALID_TAR_HEADER", "Tar must end with exactly two zero blocks.");
      sawEnd = true;
      break;
    }
    if (members.length >= limits.maxMembers) releaseError("TAR_LIMIT_EXCEEDED", "Tar member count exceeds its bound.");
    const parsed = assertCanonicalHeader(header, releaseSeconds);
    if ((parsed.path === "bin/trajecta-beta") !== (parsed.mode === "0755")) releaseError("INVALID_TAR_MODE", "Only the package binary may be executable.");
    if (names.has(parsed.path)) releaseError("DUPLICATE_TAR_MEMBER", "Tar may not contain duplicate members.");
    if (folded.has(parsed.path.toLocaleLowerCase("en-US"))) releaseError("CASE_COLLISION", "Tar members may not case-fold collide.");
    if (parsed.path <= previous) releaseError("NONCANONICAL_TAR_ORDER", "Tar member paths must be strictly ascending.");
    previous = parsed.path;
    if (parsed.path.split("/").length > limits.maxPathDepth || parsed.bytes > limits.maxMemberBytes || parsed.bytes > limits.maxUncompressedBytes) releaseError("TAR_LIMIT_EXCEEDED", "Tar member exceeds a safety bound.");
    const start = cursor + 512;
    const padding = (512 - (parsed.bytes % 512)) % 512;
    const end = start + parsed.bytes;
    if (end + padding > stream.length || !zeroBuffer(stream, end, padding)) releaseError("INVALID_TAR_HEADER", "Tar member data is truncated or non-canonically padded.");
    // Classification is bound by the caller's staged/manifest ledger. A
    // header-only adversarial scan may omit it, but cannot become a release
    // audit because release construction always supplies expectedMembers.
    const classification = options.expectedMembers?.find((member) => member.path === parsed.path)?.originalClass ?? "notice";
    members.push(Object.freeze({ path: parsed.path, bytes: parsed.bytes, sha256: sha256Hex(stream.subarray(start, end)), mode: parsed.mode, originalClass: classification }));
    names.add(parsed.path);
    folded.add(parsed.path.toLocaleLowerCase("en-US"));
    cursor = end + padding;
  }
  if (!sawEnd || members.length === 0) releaseError("INVALID_TAR_HEADER", "Tar must contain members and a canonical end marker.");
  for (const required of REQUIRED_PACKAGE_MEMBERS) if (!names.has(required)) releaseError("REQUIRED_TAR_MEMBER_MISSING", "Tarball lacks a required package boundary member.");
  if (options.expectedMembers && !matchesExpected(members, options.expectedMembers)) {
    const samePaths = members.length === options.expectedMembers.length && members.every((member, index) => member.path === options.expectedMembers![index].path);
    releaseError(samePaths ? "TAR_LEDGER_MISMATCH" : "TAR_MEMBER_SET_MISMATCH", "Tar members do not match the bound package ledger.");
  }
  return Object.freeze({ memberLedger: Object.freeze(members) });
}
