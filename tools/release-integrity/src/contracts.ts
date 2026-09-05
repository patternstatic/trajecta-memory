import fs from "node:fs";
import path from "node:path";
import { releaseError } from "./errors.ts";

export const ORIGINAL_LICENSE_CLASSES = ["apache-core", "commercial-beta", "documentation", "notice"] as const;
export type OriginalLicenseClass = typeof ORIGINAL_LICENSE_CLASSES[number];
export const PACKAGE_PATH = "packages/trajecta-beta-0.1.0.tgz";
export const RECEIPT_TEST_SCOPE_IDS = [
  "release-contracts-v1",
  "release-source-preflight-v1",
  "release-stage-layout-v1",
  "release-tgz-audit-v1",
  "release-offline-npm-v1",
  "release-archive-audit-v1",
  "release-reproducibility-v1",
] as const;
export const RECEIPT_LIMITATIONS = ["Customer-0-not-run", "not-for-sale", "no-commercial-activation"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return releaseError("INVALID_SCHEMA", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    releaseError("INVALID_SCHEMA", `${label} has unexpected or missing fields.`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return releaseError("INVALID_SCHEMA", `${label} must be a string array.`);
  return value;
}

export function parseSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return releaseError("INVALID_DIGEST", `${label} must be a lowercase SHA-256 digest.`);
  return value;
}

export function parseCommitDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) return releaseError("INVALID_COMMIT", "buildCommit must be a lowercase Git commit digest.");
  return value;
}

export function assertSafeArchivePath(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("//") || value.endsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "." || part === "..")) {
    return releaseError("UNSAFE_PATH", "Archive paths must be safe ASCII relative file names.");
  }
  return value;
}

export function parseReleaseInstant(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return releaseError("INVALID_RELEASE_INSTANT", "Release instant must be a whole-second UTC RFC 3339 instant.");
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== value.replace(/Z$/, ".000Z")) return releaseError("INVALID_RELEASE_INSTANT", "Release instant is not a real UTC instant.");
  const minimum = Date.parse("1980-01-01T00:00:00Z");
  const maximum = Date.parse("2107-12-31T23:59:58Z");
  if (instant.valueOf() < minimum || instant.valueOf() > maximum || instant.getUTCSeconds() % 2 !== 0 || instant.getUTCMilliseconds() !== 0) return releaseError("INVALID_RELEASE_INSTANT", "Release instant is outside ZIP DOS precision or range.");
  return instant;
}

export function parseVerificationInstant(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return releaseError("INVALID_VERIFICATION_INSTANT", "Verification instant must be a whole-second UTC RFC 3339 instant.");
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== value.replace(/Z$/, ".000Z")) return releaseError("INVALID_VERIFICATION_INSTANT", "Verification instant is not a real UTC instant.");
  return instant;
}

function assertNoSymlinkAncestry(target: string): void {
  let current = path.parse(target).root;
  for (const segment of path.relative(current, target).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink() && current !== "/var") releaseError("UNSAFE_OUTPUT", "Output path may not have symlink ancestry.");
  }
}

export function assertNewOutputDirectory(outputDir: unknown, sourceRoot: string): string {
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir)) return releaseError("UNSAFE_OUTPUT", "Output directory must be absolute.");
  const resolved = path.resolve(outputDir);
  const suppliedSource = path.resolve(sourceRoot);
  const source = fs.realpathSync(sourceRoot);
  if (resolved === suppliedSource || resolved.startsWith(`${suppliedSource}${path.sep}`) || resolved === source || resolved.startsWith(`${source}${path.sep}`)) return releaseError("UNSAFE_OUTPUT", "Output directory must be outside the source root.");
  assertNoSymlinkAncestry(resolved);
  if (fs.existsSync(resolved)) return releaseError("UNSAFE_OUTPUT", "Output directory must not exist yet.");
  return resolved;
}

function parseMember(value: unknown, allowContainer: boolean): void {
  const member = record(value, "member");
  const keys = Object.keys(member);
  const container = member.originalClass === "mixed-container";
  const expected = container ? ["path", "bytes", "sha256", "originalClass", "memberLedger"] : ["path", "bytes", "sha256", "originalClass"];
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(member, key))) releaseError("INVALID_MANIFEST", "Manifest member fields are invalid.");
  const memberPath = assertSafeArchivePath(member.path);
  if (!Number.isSafeInteger(member.bytes) || (member.bytes as number) < 0) releaseError("INVALID_MANIFEST", "Manifest member bytes are invalid.");
  parseSha256(member.sha256, "member sha256");
  if (container) {
    if (!allowContainer || memberPath !== PACKAGE_PATH || !Array.isArray(member.memberLedger)) releaseError("INVALID_MANIFEST", "Only the package may be a mixed container.");
    for (const inner of member.memberLedger) {
      const ledger = record(inner, "member ledger");
      exactKeys(ledger, ["path", "bytes", "sha256", "mode", "originalClass"], "member ledger");
      assertSafeArchivePath(ledger.path);
      if (!Number.isSafeInteger(ledger.bytes) || (ledger.bytes as number) < 0 || (ledger.mode !== "0644" && ledger.mode !== "0755") || !ORIGINAL_LICENSE_CLASSES.includes(ledger.originalClass as OriginalLicenseClass)) releaseError("INVALID_MANIFEST", "Package member ledger is invalid.");
      parseSha256(ledger.sha256, "ledger sha256");
    }
    return;
  }
  if (!ORIGINAL_LICENSE_CLASSES.includes(member.originalClass as OriginalLicenseClass)) releaseError("INVALID_MANIFEST", "Manifest original class is invalid.");
}

export function parseManifest(value: unknown): void {
  const manifest = record(value, "manifest");
  exactKeys(manifest, ["schema", "members"], "manifest");
  if (manifest.schema !== "trajecta.release-manifest/v1" || !Array.isArray(manifest.members)) releaseError("INVALID_MANIFEST", "Manifest schema is invalid.");
  for (const member of manifest.members) parseMember(member, true);
}

export function parseEvaluationReceipt(value: unknown): void {
  const receipt = record(value, "receipt");
  exactKeys(receipt, ["schema", "testScopeIds", "highestProvenReceiptLevel", "limitations"], "receipt");
  if (receipt.schema !== "trajecta.release-integrity-evaluation/v1" || receipt.highestProvenReceiptLevel !== "production-local-sdk") releaseError("INVALID_RECEIPT", "Receipt schema or level is invalid.");
  const scopes = stringArray(receipt.testScopeIds, "receipt testScopeIds");
  const limitations = stringArray(receipt.limitations, "receipt limitations");
  if (scopes.length !== RECEIPT_TEST_SCOPE_IDS.length || scopes.some((scope, index) => scope !== RECEIPT_TEST_SCOPE_IDS[index]) || limitations.length !== RECEIPT_LIMITATIONS.length || limitations.some((limitation, index) => limitation !== RECEIPT_LIMITATIONS[index])) releaseError("INVALID_RECEIPT", "Receipt claims must exactly match the fixed evaluation scope.");
}

export function parseReleasePins(value: unknown): void {
  const pins = record(value, "release pins");
  exactKeys(pins, ["schema", "archiveSha256", "keyFingerprint", "archiveAudit", "reproducibility"], "release pins");
  if (pins.schema !== "trajecta.release-pins/v1" || pins.archiveAudit !== "passed" || pins.reproducibility !== "passed") releaseError("INVALID_PINS", "Release pins must contain external gate results.");
  parseSha256(pins.archiveSha256, "archiveSha256");
  parseSha256(pins.keyFingerprint, "keyFingerprint");
}
