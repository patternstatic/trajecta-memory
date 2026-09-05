import { canonicalJsonLf, sha256Hex } from "./canonical.ts";
import { ORIGINAL_LICENSE_CLASSES, PACKAGE_PATH, assertSafeArchivePath, parseManifest, type OriginalLicenseClass } from "./contracts.ts";
import { releaseError } from "./errors.ts";
import { auditTgz, type TarLedgerMember } from "./tar-reader.ts";

export interface PayloadFile {
  path: string;
  bytes: Buffer;
  originalClass: OriginalLicenseClass;
}

export interface PackagePayload {
  path: typeof PACKAGE_PATH;
  bytes: Buffer;
  memberLedger: readonly TarLedgerMember[];
}

export interface BuildManifestOptions {
  releaseInstant: unknown;
  payload: readonly (PayloadFile | PackagePayload)[];
}

export interface ReleaseManifest {
  schema: "trajecta.release-manifest/v1";
  members: readonly Record<string, unknown>[];
}

export interface BuiltManifest {
  value: ReleaseManifest;
  bytes: Buffer;
  sha256: string;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPackage(value: PayloadFile | PackagePayload): value is PackagePayload {
  return Object.hasOwn(value, "memberLedger");
}

/** Builds a payload-only manifest, re-auditing the only permitted nested container. */
export function buildManifest(options: BuildManifestOptions): BuiltManifest {
  if (!options || !Array.isArray(options.payload) || options.payload.length === 0) return releaseError("INVALID_MANIFEST", "Manifest requires a non-empty payload inventory.");
  const paths = new Set<string>();
  let packageCount = 0;
  const members = options.payload.map((input) => {
    if (!input || typeof input !== "object" || typeof input.path !== "string" || !Buffer.isBuffer(input.bytes)) return releaseError("INVALID_MANIFEST", "Manifest payload members require paths and byte buffers.");
    const memberPath = assertSafeArchivePath(input.path);
    if (paths.has(memberPath)) return releaseError("INVALID_MANIFEST", "Manifest payload paths must be unique.");
    paths.add(memberPath);
    if (isPackage(input)) {
      if (memberPath !== PACKAGE_PATH || !Array.isArray(input.memberLedger)) return releaseError("INVALID_MANIFEST", "Only the package tgz may carry a member ledger.");
      packageCount += 1;
      const audited = auditTgz(input.bytes, { releaseInstant: options.releaseInstant, expectedMembers: input.memberLedger });
      return Object.freeze({ path: memberPath, bytes: input.bytes.length, sha256: sha256Hex(input.bytes), originalClass: "mixed-container", memberLedger: audited.memberLedger.map((member) => Object.freeze({ ...member })) });
    }
    if (!ORIGINAL_LICENSE_CLASSES.includes(input.originalClass)) return releaseError("INVALID_MANIFEST", "Manifest payload class is invalid.");
    return Object.freeze({ path: memberPath, bytes: input.bytes.length, sha256: sha256Hex(input.bytes), originalClass: input.originalClass });
  }).sort((left, right) => lexical(left.path, right.path));
  if (packageCount !== 1) return releaseError("INVALID_MANIFEST", "Manifest must contain exactly one audited package tgz.");
  const value = Object.freeze({ schema: "trajecta.release-manifest/v1" as const, members: Object.freeze(members) });
  parseManifest(value);
  const bytes = canonicalJsonLf(value);
  return Object.freeze({ value, bytes, sha256: sha256Hex(bytes) });
}
