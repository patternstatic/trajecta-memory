import { buildRelease, type BuildReleaseOptions } from "./build.ts";
import { releaseError } from "./errors.ts";

const FLAGS = ["--private-key", "--public-key", "--git-bin", "--npm-cli", "--build-commit", "--release-instant", "--verification-instant", "--output-dir"] as const;
type Flag = typeof FLAGS[number];
export type ReleaseCliArguments = { command: "build" } & Omit<BuildReleaseOptions, "sourceRoot">;

export function parseReleaseCli(argv: readonly string[]): ReleaseCliArguments {
  if (argv[0] !== "build") return releaseError("INVALID_COMMAND", "Release command must be build.");
  const values = new Map<Flag, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index] as Flag, value = argv[index + 1];
    if (!FLAGS.includes(flag) || values.has(flag) || typeof value !== "string" || value.length === 0) return releaseError("INVALID_ARGUMENT", "Release flags must be known, unique, and non-empty.");
    values.set(flag, value);
  }
  if (argv.length !== 1 + FLAGS.length * 2 || values.size !== FLAGS.length) return releaseError("INVALID_ARGUMENT", "Build requires every frozen release flag exactly once.");
  return Object.freeze({ command: "build", privateKey: values.get("--private-key")!, publicKey: values.get("--public-key")!, gitBin: values.get("--git-bin")!, npmCli: values.get("--npm-cli")!, buildCommit: values.get("--build-commit")!, releaseInstant: values.get("--release-instant")!, verificationInstant: values.get("--verification-instant")!, outputDir: values.get("--output-dir")! });
}

export function buildOptionsFromCli(input: ReleaseCliArguments, sourceRoot: string): BuildReleaseOptions {
  return Object.freeze({ sourceRoot, privateKey: input.privateKey, publicKey: input.publicKey, gitBin: input.gitBin, npmCli: input.npmCli, buildCommit: input.buildCommit, releaseInstant: input.releaseInstant, verificationInstant: input.verificationInstant, outputDir: input.outputDir });
}

export function runReleaseCli(argv: readonly string[], sourceRoot: string): string {
  const input = parseReleaseCli(argv);
  const result = buildRelease(buildOptionsFromCli(input, sourceRoot));
  return `${JSON.stringify({ archiveSha256: result.archiveSha256, publicKeyFingerprint: result.publicKeyFingerprint, archivePath: result.archivePath, pinsPath: result.pinsPath, evidencePath: result.evidencePath })}\n`;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try { process.stdout.write(runReleaseCli(process.argv.slice(2), process.cwd())); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "RELEASE_FAILED";
    process.stderr.write(`${code}: Release command did not complete.\n`);
    process.exitCode = 1;
  }
}
