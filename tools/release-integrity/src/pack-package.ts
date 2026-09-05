import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./canonical.ts";
import { createDeterministicTgz } from "./deterministic-tgz.ts";
import { assertSafeArchivePath } from "./contracts.ts";
import { releaseError } from "./errors.ts";
import { auditTgz, type TarLedgerMember } from "./tar-reader.ts";
import type { StagedMember } from "./stage-package.ts";

export interface PackPackageOptions {
  packageRoot: string;
  members: readonly StagedMember[];
  releaseInstant: unknown;
}

export interface PackedPackage {
  tgz: Buffer;
  memberLedger: readonly TarLedgerMember[];
}

function readStagedMember(packageRoot: string, member: StagedMember): Buffer {
  const memberPath = assertSafeArchivePath(member.path);
  const destination = path.resolve(packageRoot, memberPath);
  if (!destination.startsWith(`${packageRoot}${path.sep}`)) return releaseError("UNSAFE_STAGE_PATH", "Package member escapes its staging root.");
  let metadata: fs.Stats;
  try { metadata = fs.lstatSync(destination); }
  catch { return releaseError("STAGED_MEMBER_MISSING", "A staged package member is missing."); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return releaseError("UNSAFE_STAGE_MEMBER", "Staged package members must be regular files.");
  const mode = (metadata.mode & 0o777).toString(8).padStart(4, "0");
  if (mode !== member.mode || (member.path === "bin/trajecta-beta") !== (member.mode === "0755")) releaseError("INVALID_TAR_MODE", "Staged package mode is not normalized.");
  const bytes = fs.readFileSync(destination);
  if (bytes.length !== member.bytes || sha256Hex(bytes) !== member.sha256) releaseError("STAGED_MEMBER_DRIFT", "Staged package member bytes do not match its ledger.");
  return bytes;
}

export function packPackage(options: PackPackageOptions): PackedPackage {
  if (!path.isAbsolute(options.packageRoot)) return releaseError("INVALID_STAGE_DIRECTORY", "Package root must be absolute.");
  const packageRoot = path.resolve(options.packageRoot);
  const listed = new Set<string>();
  let previous = "";
  const inputs = options.members.map((member) => {
    const memberPath = assertSafeArchivePath(member.path);
    if (memberPath <= previous || listed.has(memberPath)) releaseError("TAR_MEMBER_SET_MISMATCH", "Staged member ledger must be strictly sorted and unique.");
    previous = memberPath;
    listed.add(memberPath);
    return { path: memberPath, bytes: readStagedMember(packageRoot, member), mode: member.mode, originalClass: member.originalClass };
  });
  const actual = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) releaseError("UNSAFE_STAGE_MEMBER", "Staged package tree contains an unsupported entry.");
      if (entry.isDirectory()) walk(absolute);
      else actual.add(path.relative(packageRoot, absolute).split(path.sep).join("/"));
    }
  };
  try { if (!fs.lstatSync(packageRoot).isDirectory()) return releaseError("INVALID_STAGE_DIRECTORY", "Package root must be a directory."); }
  catch { return releaseError("INVALID_STAGE_DIRECTORY", "Package root is unavailable."); }
  walk(packageRoot);
  if (actual.size !== listed.size || [...actual].some((member) => !listed.has(member))) releaseError("TAR_MEMBER_SET_MISMATCH", "Staged package tree has missing or extra members.");
  const tgz = createDeterministicTgz(inputs, options.releaseInstant);
  const expected = inputs.map(({ path: memberPath, bytes, mode, originalClass }) => Object.freeze({ path: memberPath, bytes: bytes.length, sha256: sha256Hex(bytes), mode, originalClass }));
  const audited = auditTgz(tgz, { releaseInstant: options.releaseInstant, expectedMembers: expected });
  return Object.freeze({ tgz, memberLedger: audited.memberLedger });
}
