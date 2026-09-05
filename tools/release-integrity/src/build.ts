import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonLf, sha256Hex } from "./canonical.ts";
import { assertNewOutputDirectory, parseReleasePins } from "./contracts.ts";
import { releaseError } from "./errors.ts";
import { assembleBundle, verifyBundle } from "./assemble.ts";
import { packPackage } from "./pack-package.ts";
import { preflightSource, type PayloadPolicy, type SourceSnapshot } from "./preflight-source.ts";
import { runControlledOfflineInstall } from "./run.ts";
import { stagePackage } from "./stage-package.ts";

const DOCUMENT_INPUTS = ["START-HERE.html", "START-HERE.md", "recipes/01-planner-to-local-workspace.md", "recipes/02-stale-rejection.md", "recipes/03-inspect-retry-receipt.md", "TROUBLESHOOTING.md", "SUPPORTED-ENVIRONMENT.md"] as const;
const BUILDER_NODE_VERSION = "v22.23.1";

export interface BuildReleaseOptions {
  sourceRoot: string; gitBin: string; npmCli: string; buildCommit: string;
  releaseInstant: string; verificationInstant: string; privateKey: string; publicKey: string; outputDir: string;
}
export interface BuiltRelease { archivePath: string; pinsPath: string; evidencePath: string; archiveSha256: string; publicKeyFingerprint: string; }

/** The builder strips TypeScript during staging, so its exact implementation is frozen separately from buyer support. */
export function assertBuildRuntime(version = process.version): void {
  if (version !== BUILDER_NODE_VERSION) releaseError("BUILDER_NODE_VERSION_MISMATCH", "Release construction requires the pinned Node 22.23.1 runtime.");
}

function outside(source: string, candidate: string, code: string): string {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return releaseError(code, "Release inputs must use absolute paths.");
  const resolved = path.resolve(candidate), root = fs.realpathSync(source);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return releaseError(code, "Seller key input must remain outside the source tree.");
  return resolved;
}

function readExternalPem(source: string, file: string, label: string): string {
  const supplied = outside(source, file, "KEY_INSIDE_SOURCE");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(supplied); } catch { return releaseError("INVALID_KEY_FILE", `${label} key file is unavailable.`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 16 * 1024) return releaseError("INVALID_KEY_FILE", `${label} key file is invalid.`);
  let target: string;
  try { target = fs.realpathSync(supplied); } catch { return releaseError("INVALID_KEY_FILE", `${label} key file is invalid.`); }
  const root = fs.realpathSync(source);
  if (target === root || target.startsWith(`${root}${path.sep}`)) return releaseError("KEY_INSIDE_SOURCE", "Seller key input must remain outside the source tree.");
  try { return fs.readFileSync(target, "utf8"); } catch { return releaseError("INVALID_KEY_FILE", `${label} key file is invalid.`); }
}

function sourcePolicy(source: string): PayloadPolicy {
  const file = path.join(source, "release", "payload-policy.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as PayloadPolicy; }
  catch { return releaseError("INVALID_POLICY", "Release payload policy is unavailable."); }
}

function snapshotBytes(snapshot: SourceSnapshot, relative: string): Buffer {
  const entry = snapshot.entries.find(candidate => candidate.path === relative);
  const target = path.resolve(snapshot.root, relative);
  if (!entry || !target.startsWith(`${snapshot.root}${path.sep}`)) return releaseError("SNAPSHOT_INPUT_MISSING", "Frozen release input is unavailable.");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch { return releaseError("SNAPSHOT_INPUT_MISSING", "Frozen release input is unavailable."); }
  if (!stat.isFile() || stat.isSymbolicLink()) return releaseError("UNSAFE_SNAPSHOT", "Frozen release input is invalid.");
  const bytes = fs.readFileSync(target);
  if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) return releaseError("SNAPSHOT_DRIFT", "Frozen release input changed.");
  return bytes;
}

function documents(snapshot: SourceSnapshot, modificationNotice: Buffer): ReadonlyMap<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const name of DOCUMENT_INPUTS) result.set(name, snapshotBytes(snapshot, `release/evaluation/payload/${name}`));
  result.set("LICENSES/CORE-APACHE-2.0.txt", snapshotBytes(snapshot, "LICENSE"));
  const notice = snapshotBytes(snapshot, "NOTICE");
  result.set("LICENSES/CORE-NOTICE.txt", Buffer.concat([notice, Buffer.from("\n"), modificationNotice]));
  result.set("LICENSES/BETA-COMMERCIAL-TERMS.txt", snapshotBytes(snapshot, "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt"));
  result.set("THIRD-PARTY-NOTICES.txt", snapshotBytes(snapshot, "release/evaluation/THIRD-PARTY-NOTICES.txt"));
  return result;
}

function buildOne(snapshot: SourceSnapshot, options: BuildReleaseOptions, publicKeyPem: string, privateKeyPem: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-release-build-"));
  try {
    const staged = stagePackage({ snapshot, stageDirectory: path.join(root, "stage") });
    const packed = packPackage({ packageRoot: staged.packageRoot, members: staged.members, releaseInstant: options.releaseInstant });
    const modificationNotice = fs.readFileSync(path.join(staged.packageRoot, "LICENSES", "CORE-MODIFICATIONS.txt"));
    const assembled = assembleBundle({ tgz: packed.tgz, memberLedger: packed.memberLedger, documents: documents(snapshot, modificationNotice), buildCommit: options.buildCommit, releaseInstant: options.releaseInstant, verificationInstant: options.verificationInstant, publicKeyPem, privateKeyPem });
    verifyBundle({ zip: assembled.zip, archiveSha256: assembled.archiveSha256, publicKeyPem, publicKeyFingerprint: assembled.publicKeyFingerprint, releaseInstant: options.releaseInstant });
    return { ...assembled, packed };
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 2 }); }
}

/** Runs two clean immutable builds, then writes the ZIP and external pins only after both gates pass. */
export function buildRelease(options: BuildReleaseOptions): BuiltRelease {
  const keys = ["sourceRoot", "gitBin", "npmCli", "buildCommit", "releaseInstant", "verificationInstant", "privateKey", "publicKey", "outputDir"];
  if (!options || Object.keys(options).length !== keys.length || keys.some(key => !Object.hasOwn(options, key)) || typeof options.sourceRoot !== "string" || !path.isAbsolute(options.sourceRoot)) return releaseError("INVALID_BUILD_INPUT", "Build requires complete explicit frozen inputs.");
  let source: string;
  try { source = fs.realpathSync(options.sourceRoot); }
  catch { return releaseError("INVALID_SOURCE_ROOT", "Build source root is unavailable."); }
  assertBuildRuntime();
  const output = assertNewOutputDirectory(options.outputDir, source);
  const privateKeyPem = readExternalPem(source, options.privateKey, "Private");
  const publicKeyPem = readExternalPem(source, options.publicKey, "Public");
  const policy = sourcePolicy(source);
  let firstSnapshot: SourceSnapshot | undefined, secondSnapshot: SourceSnapshot | undefined;
  try {
    firstSnapshot = preflightSource({ sourceRoot: source, gitBin: options.gitBin, buildCommit: options.buildCommit, policy });
    const first = buildOne(firstSnapshot, options, publicKeyPem, privateKeyPem);
    secondSnapshot = preflightSource({ sourceRoot: source, gitBin: options.gitBin, buildCommit: options.buildCommit, policy });
    const second = buildOne(secondSnapshot, options, publicKeyPem, privateKeyPem);
    if (!first.zip.equals(second.zip) || first.archiveSha256 !== second.archiveSha256 || first.publicKeyFingerprint !== second.publicKeyFingerprint) return releaseError("REPRODUCIBILITY_MISMATCH", "Independent frozen builds did not produce identical archives.");
    const offline = runControlledOfflineInstall({ tgz: first.packed.tgz, memberLedger: first.packed.memberLedger, releaseInstant: options.releaseInstant, npmCli: options.npmCli });
    fs.mkdirSync(output, { mode: 0o700 });
    const archivePath = path.join(output, "trajecta-verified-resume-sdk-beta-0.1.0.zip");
    fs.writeFileSync(archivePath, first.zip, { mode: 0o600, flag: "wx" });
    const finalZip = fs.readFileSync(archivePath);
    verifyBundle({ zip: finalZip, archiveSha256: first.archiveSha256, publicKeyPem, publicKeyFingerprint: first.publicKeyFingerprint, releaseInstant: options.releaseInstant });
    const pins = { schema: "trajecta.release-pins/v1", archiveSha256: first.archiveSha256, keyFingerprint: first.publicKeyFingerprint, archiveAudit: "passed", reproducibility: "passed" };
    parseReleasePins(pins);
    const pinsPath = path.join(output, "release-pins.json");
    fs.writeFileSync(pinsPath, canonicalJsonLf(pins), { mode: 0o600, flag: "wx" });
    const evidencePath = path.join(output, "release-evidence.json");
    fs.writeFileSync(evidencePath, canonicalJsonLf({ schema: "trajecta.release-evidence/v1", archiveSha256: first.archiveSha256, keyFingerprint: first.publicKeyFingerprint, archiveAudit: "passed", reproducibility: "passed", builderNodeVersion: process.version, builderNpmVersion: offline.npmVersion, offlineInstall: offline }), { mode: 0o600, flag: "wx" });
    return Object.freeze({ archivePath, pinsPath, evidencePath, archiveSha256: first.archiveSha256, publicKeyFingerprint: first.publicKeyFingerprint });
  } finally {
    if (firstSnapshot) fs.rmSync(firstSnapshot.root, { recursive: true, force: true, maxRetries: 2 });
    if (secondSnapshot) fs.rmSync(secondSnapshot.root, { recursive: true, force: true, maxRetries: 2 });
  }
}
