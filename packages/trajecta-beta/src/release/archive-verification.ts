import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalJsonLf, sha256Hex } from "./canonical.ts";
import { PACKAGE_PATH, parseManifest, parseSha256 } from "./contracts.ts";
import { MAX_CANONICAL_ZIP_BYTES, readZip, readZipReleaseInstant, type ZipMember } from "./deterministic-zip.ts";
import { ReleaseIntegrityError, releaseError } from "./errors.ts";
import { MAX_PUBLIC_KEY_BYTES, publicKeyFingerprint, verifySignedReceipt, type ReleaseReceipt } from "./signature-verification.ts";
import { auditTgz, type TarLedgerMember } from "./tar-reader.ts";

export const BUNDLE_ROOT = "trajecta-verified-resume-sdk-beta-0.1.0";
export const DOCUMENT_PATHS = ["START-HERE.html", "START-HERE.md", "recipes/01-planner-to-local-workspace.md", "recipes/02-stale-rejection.md", "recipes/03-inspect-retry-receipt.md", "TROUBLESHOOTING.md", "SUPPORTED-ENVIRONMENT.md", "LICENSES/CORE-APACHE-2.0.txt", "LICENSES/CORE-NOTICE.txt", "LICENSES/BETA-COMMERCIAL-TERMS.txt", "THIRD-PARTY-NOTICES.txt"] as const;
const CONTROLS = ["MANIFEST.json", "RELEASE-RECEIPT.json", "RELEASE-RECEIPT.json.sig", "SELLER-PUBLIC-KEY.pem", "SHA256SUMS.txt"] as const;

export interface DeliveredBundleInput {
  archivePath: string;
  pinnedZipSha256: string;
  bundleRoot: string;
  publicKeyPath: string;
  installedPackageRoot: string;
}

export interface DeliveredBundleAudit {
  archiveSha256: string;
  publicKeyFingerprint: string;
  memberCount: number;
  installedMemberCount: number;
  releaseInstant: string;
}

export interface VerifyBundleInput {
  zip: Buffer;
  archiveSha256: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  releaseInstant: string;
}

interface ManifestMember {
  path: string;
  bytes: number;
  sha256: string;
  memberLedger?: TarLedgerMember[];
}

interface VerifiedArchive {
  files: ReadonlyMap<string, Buffer>;
  modes: ReadonlyMap<string, "0644" | "0755">;
  receipt: ReleaseReceipt;
  installedMembers: ReadonlyMap<string, Buffer>;
  installedLedger: readonly TarLedgerMember[];
}

function fail(message = "Release members do not match the accepted bundle contract."): never {
  return releaseError("MANIFEST_MISMATCH", message);
}

function checksums(files: ReadonlyMap<string, Buffer>): Buffer {
  return Buffer.from([...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([member, bytes]) => `${sha256Hex(bytes)}  ${member}\n`).join(""));
}

function verifyArchive(input: VerifyBundleInput): VerifiedArchive {
  parseSha256(input.archiveSha256, "archiveSha256");
  parseSha256(input.publicKeyFingerprint, "publicKeyFingerprint");
  if (sha256Hex(input.zip) !== input.archiveSha256) fail();
  const members = readZip(input.zip, input.releaseInstant);
  const expected = new Set<string>([...DOCUMENT_PATHS, PACKAGE_PATH, ...CONTROLS]);
  const files = new Map<string, Buffer>();
  const modes = new Map<string, "0644" | "0755">();
  for (const member of members) {
    if (!member.path.startsWith(`${BUNDLE_ROOT}/`) || member.mode !== "0644") fail();
    const relative = member.path.slice(BUNDLE_ROOT.length + 1);
    if (!expected.delete(relative)) fail();
    files.set(relative, member.bytes);
    modes.set(relative, member.mode);
  }
  if (expected.size !== 0) fail();

  const manifestBytes = files.get("MANIFEST.json")!;
  const receiptBytes = files.get("RELEASE-RECEIPT.json")!;
  const receipt = verifySignedReceipt({
    receiptBytes,
    signature: files.get("RELEASE-RECEIPT.json.sig")!,
    manifestBytes,
    publicKeyPem: input.publicKeyPem,
    expectedPublicKeyFingerprint: input.publicKeyFingerprint,
  });
  if (receipt.releaseInstant !== input.releaseInstant || !files.get("SELLER-PUBLIC-KEY.pem")!.equals(Buffer.from(input.publicKeyPem))) fail();

  let manifest: { members: ManifestMember[] };
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as { members: ManifestMember[] }; }
  catch { return fail(); }
  parseManifest(manifest);
  const payloadNames = new Set<string>([...DOCUMENT_PATHS, PACKAGE_PATH]);
  let installedMembers: ReadonlyMap<string, Buffer> | undefined;
  let installedLedger: readonly TarLedgerMember[] | undefined;
  for (const member of manifest.members) {
    if (!payloadNames.delete(member.path)) fail();
    const bytes = files.get(member.path)!;
    if (bytes.length !== member.bytes || sha256Hex(bytes) !== member.sha256) fail();
    if (member.path === PACKAGE_PATH) {
      const audited = auditTgz(bytes, { releaseInstant: input.releaseInstant, expectedMembers: member.memberLedger });
      installedMembers = audited.members;
      installedLedger = audited.memberLedger;
      const coreLicense = audited.members.get("LICENSE");
      const coreNotice = audited.members.get("NOTICE");
      const modifications = audited.members.get("LICENSES/CORE-MODIFICATIONS.txt");
      if (!coreLicense || !coreNotice || !modifications
        || !files.get("LICENSES/CORE-APACHE-2.0.txt")!.equals(coreLicense)
        || !files.get("LICENSES/CORE-NOTICE.txt")!.equals(Buffer.concat([coreNotice, Buffer.from("\n"), modifications]))) {
        releaseError("NOTICE_MISMATCH", "Outer license and notice must preserve the packaged core license and modification notice.");
      }
      for (const inner of audited.memberLedger) {
        if (inner.originalClass === "apache-core" && inner.path.startsWith("core/src/") && !modifications.toString("utf8").includes(`- ${inner.path}\n`)) {
          releaseError("NOTICE_MISMATCH", "Every generated Apache runtime member requires a modification notice.");
        }
      }
    }
  }
  if (payloadNames.size !== 0 || !installedMembers || !installedLedger || !canonicalJsonLf(manifest).equals(manifestBytes)) fail();
  const covered = new Map(files);
  covered.delete("SHA256SUMS.txt");
  if (!files.get("SHA256SUMS.txt")!.equals(checksums(covered))) fail();
  return Object.freeze({ files, modes, receipt, installedMembers, installedLedger });
}

/** Compatibility in-memory verification used by the seller build rail and adversarial release tests. */
export function verifyBundle(input: VerifyBundleInput): ReadonlyMap<string, Buffer> {
  return verifyArchive(input).files;
}

function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) return releaseError("INVALID_DELIVERED_PATH", `${label} must be an absolute path.`);
  const resolved = path.resolve(value);
  let current = path.parse(resolved).root;
  for (const segment of path.relative(current, resolved).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() && current !== "/var") return releaseError("UNSAFE_DELIVERED_PATH", `${label} may not have symbolic-link ancestry.`);
  }
  return resolved;
}

function readBoundedRegularFile(file: string, maximumBytes: number, label: string, expectedBytes?: number, expectedMode?: "0644" | "0755"): Buffer {
  const target = assertAbsolutePath(file, label);
  let expected: fs.Stats;
  try { expected = fs.lstatSync(target); }
  catch { return releaseError("DELIVERED_FILE_INVALID", `${label} is missing.`); }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > maximumBytes || (expectedBytes !== undefined && expected.size !== expectedBytes)) return releaseError("DELIVERED_FILE_INVALID", `${label} must be the expected bounded regular file.`);
  if (expected.nlink !== 1) return releaseError("DELIVERED_HARD_LINK_REJECTED", `${label} may not have multiple hard links.`);
  if (expectedMode && (expected.mode & 0o777) !== Number.parseInt(expectedMode, 8)) return releaseError("DELIVERED_MODE_MISMATCH", `${label} mode does not match the authenticated ledger.`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || (opened.mode & 0o777) !== (expected.mode & 0o777)) return releaseError("DELIVERED_FILE_CHANGED", `${label} changed while it was opened.`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.nlink !== 1 || after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size || (after.mode & 0o777) !== (expected.mode & 0o777) || bytes.length !== expected.size) return releaseError("DELIVERED_FILE_CHANGED", `${label} changed while it was read.`);
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseIntegrityError) throw error;
    return releaseError("DELIVERED_FILE_INVALID", `${label} could not be read without following links.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function expectedDirectories(members: Iterable<string>): Set<string> {
  const directories = new Set<string>([""]);
  for (const member of members) {
    const parts = member.split("/");
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"));
  }
  return directories;
}

function compareRegularTree(rootInput: string, expectedMembers: ReadonlyMap<string, Buffer>, modes: ReadonlyMap<string, "0644" | "0755">, label: string): void {
  const root = assertAbsolutePath(rootInput, label);
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(root); }
  catch { return releaseError("DELIVERED_TREE_MISMATCH", `${label} is missing.`); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return releaseError("DELIVERED_TREE_MISMATCH", `${label} must be a no-follow directory.`);
  const directories = expectedDirectories(expectedMembers.keys());
  const seen = new Set<string>();
  const walk = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return releaseError("DELIVERED_LINK_REJECTED", `${label} may not contain links.`);
      if (stat.isDirectory()) {
        if (!directories.has(relative)) return releaseError("DELIVERED_TREE_MISMATCH", `${label} contains an unexpected directory.`);
        walk(absolute, relative);
      } else if (stat.isFile()) {
        const expected = expectedMembers.get(relative);
        const mode = modes.get(relative);
        if (!expected || !mode || seen.has(relative)) return releaseError("DELIVERED_TREE_MISMATCH", `${label} contains an unexpected file.`);
        const actual = readBoundedRegularFile(absolute, expected.length, `${label} member`, expected.length, mode);
        if (!actual.equals(expected)) return releaseError("DELIVERED_TREE_MISMATCH", `${label} bytes do not match the authenticated ledger.`);
        seen.add(relative);
      } else return releaseError("DELIVERED_SPECIAL_FILE_REJECTED", `${label} may contain only regular files and directories.`);
    }
  };
  walk(root, "");
  if (seen.size !== expectedMembers.size) return releaseError("DELIVERED_TREE_MISMATCH", `${label} is missing an authenticated file.`);
}

/** Read-only customer verifier for the independently pinned archive, unpacked tree, and installed package. */
export function verifyDeliveredBundle(input: DeliveredBundleInput): DeliveredBundleAudit {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join("\0") !== ["archivePath", "bundleRoot", "installedPackageRoot", "pinnedZipSha256", "publicKeyPath"].sort().join("\0")) return releaseError("INVALID_DELIVERED_INPUT", "Delivered bundle verification inputs are invalid.");
  const pinnedZipSha256 = parseSha256(input.pinnedZipSha256, "pinnedZipSha256");
  const zip = readBoundedRegularFile(input.archivePath, MAX_CANONICAL_ZIP_BYTES, "Original ZIP");
  const archiveSha256 = sha256Hex(zip);
  if (archiveSha256 !== pinnedZipSha256) return releaseError("ARCHIVE_DIGEST_MISMATCH", "Original ZIP does not match the independently pinned digest.");

  const releaseInstant = readZipReleaseInstant(zip);
  const keyBytes = readBoundedRegularFile(input.publicKeyPath, MAX_PUBLIC_KEY_BYTES, "Independent public key");
  let publicKeyPem: string;
  try { publicKeyPem = new TextDecoder("utf-8", { fatal: true }).decode(keyBytes); }
  catch { return releaseError("INVALID_PUBLIC_KEY", "Independent public key must be UTF-8 PEM."); }
  const fingerprint = publicKeyFingerprint(publicKeyPem);
  const verified = verifyArchive({ zip, archiveSha256, publicKeyPem, publicKeyFingerprint: fingerprint, releaseInstant });
  compareRegularTree(input.bundleRoot, verified.files, verified.modes, "Unpacked bundle");
  const installedModes = new Map(verified.installedLedger.map((member) => [member.path, member.mode]));
  compareRegularTree(input.installedPackageRoot, verified.installedMembers, installedModes, "Installed package");
  return Object.freeze({
    archiveSha256,
    publicKeyFingerprint: fingerprint,
    memberCount: verified.files.size,
    installedMemberCount: verified.installedLedger.length,
    releaseInstant: verified.receipt.releaseInstant,
  });
}
