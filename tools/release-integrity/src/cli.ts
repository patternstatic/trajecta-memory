import { buildRelease, type BuildReleaseOptions } from "./build.ts";
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./canonical.ts";
import { verifyAndExtractBundle, verifyBundle } from "./assemble.ts";
import { releaseError } from "./errors.ts";

const FLAGS = ["--private-key", "--public-key", "--git-bin", "--npm-cli", "--build-commit", "--release-instant", "--verification-instant", "--output-dir"] as const;
type Flag = typeof FLAGS[number];
export type ReleaseCliArguments = ({ command: "build" | "build-commercial-candidate" } & Omit<BuildReleaseOptions, "sourceRoot" | "releaseKind">) | { command: "audit"; archive: string; archiveSha256: string; publicKey: string; keyFingerprint: string; releaseInstant: string } | { command: "verify"; archive: string; archiveSha256: string; publicKey: string; keyFingerprint: string; releaseInstant: string; outputDir: string };

function flags(argv: readonly string[], expected: readonly string[]): Map<string, string> {
  if (argv.length !== 1 + expected.length * 2) return releaseError("INVALID_ARGUMENT", "Release command requires every accepted flag exactly once.");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!expected.includes(flag) || values.has(flag) || typeof value !== "string" || value.length === 0) return releaseError("INVALID_ARGUMENT", "Release flags must be known, unique, and non-empty.");
    values.set(flag, value);
  }
  return values;
}

export function parseReleaseCli(argv: readonly string[]): ReleaseCliArguments {
  if (argv[0] === "build" || argv[0] === "build-commercial-candidate") {
    const values = flags(argv, FLAGS);
    return Object.freeze({ command: argv[0], privateKey: values.get("--private-key")!, publicKey: values.get("--public-key")!, gitBin: values.get("--git-bin")!, npmCli: values.get("--npm-cli")!, buildCommit: values.get("--build-commit")!, releaseInstant: values.get("--release-instant")!, verificationInstant: values.get("--verification-instant")!, outputDir: values.get("--output-dir")! });
  }
  const trust = ["--archive", "--archive-sha256", "--public-key", "--key-fingerprint", "--release-instant"];
  if (argv[0] === "audit") { const values = flags(argv, trust); return Object.freeze({ command: "audit", archive: values.get("--archive")!, archiveSha256: values.get("--archive-sha256")!, publicKey: values.get("--public-key")!, keyFingerprint: values.get("--key-fingerprint")!, releaseInstant: values.get("--release-instant")! }); }
  if (argv[0] === "verify") { const values = flags(argv, [...trust, "--output-dir"]); return Object.freeze({ command: "verify", archive: values.get("--archive")!, archiveSha256: values.get("--archive-sha256")!, publicKey: values.get("--public-key")!, keyFingerprint: values.get("--key-fingerprint")!, releaseInstant: values.get("--release-instant")!, outputDir: values.get("--output-dir")! }); }
  return releaseError("INVALID_COMMAND", "Release command must be build, build-commercial-candidate, audit, or verify.");
}

export function buildOptionsFromCli(input: Extract<ReleaseCliArguments, { command: "build" | "build-commercial-candidate" }>, sourceRoot: string): BuildReleaseOptions {
  const common = { sourceRoot, privateKey: input.privateKey, publicKey: input.publicKey, gitBin: input.gitBin, npmCli: input.npmCli, buildCommit: input.buildCommit, releaseInstant: input.releaseInstant, verificationInstant: input.verificationInstant, outputDir: input.outputDir };
  return Object.freeze(input.command === "build-commercial-candidate" ? { ...common, releaseKind: "commercial-candidate" as const } : common);
}

function regularBytes(value: string, label: string): Buffer {
  if (!path.isAbsolute(value)) return releaseError("INVALID_ARGUMENT", `${label} must be an absolute regular file.`);
  try { const stat = fs.lstatSync(value); if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 128 * 1024 * 1024) throw new Error(); return fs.readFileSync(value); }
  catch { return releaseError("INVALID_ARGUMENT", `${label} must be an absolute regular file.`); }
}

export function runReleaseCli(argv: readonly string[], sourceRoot: string): string {
  const input = parseReleaseCli(argv);
  if (input.command === "build" || input.command === "build-commercial-candidate") {
    const result = buildRelease(buildOptionsFromCli(input, sourceRoot));
    return `${JSON.stringify({ archiveSha256: result.archiveSha256, publicKeyFingerprint: result.publicKeyFingerprint, archivePath: result.archivePath, pinsPath: result.pinsPath, evidencePath: result.evidencePath })}\n`;
  }
  const zip = regularBytes(input.archive, "Archive"), publicKeyPem = regularBytes(input.publicKey, "Public key").toString("utf8");
  if (!/^[a-f0-9]{64}$/.test(input.archiveSha256)) return releaseError("INVALID_DIGEST", "Pinned archive digest must be lowercase SHA-256.");
  const pinned = { zip, archiveSha256: input.archiveSha256, publicKeyPem, publicKeyFingerprint: input.keyFingerprint, releaseInstant: input.releaseInstant };
  if (input.command === "audit") return `${JSON.stringify({ archiveSha256: sha256Hex(zip), members: verifyBundle(pinned).size })}\n`;
  return `${JSON.stringify({ archiveSha256: sha256Hex(zip), extractedRoot: verifyAndExtractBundle({ ...pinned, outputDirectory: input.outputDir, sourceRoot }) })}\n`;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try { process.stdout.write(runReleaseCli(process.argv.slice(2), process.cwd())); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "RELEASE_FAILED";
    process.stderr.write(`${code}: Release command did not complete.\n`);
    process.exitCode = 1;
  }
}
