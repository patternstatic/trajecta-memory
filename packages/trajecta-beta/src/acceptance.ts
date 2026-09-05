import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runAcceptanceProof, type AcceptanceProofResult } from "./acceptance-proof.ts";
import { betaError } from "./errors.ts";
import { verifyDeliveredBundle, type DeliveredBundleInput } from "./release/archive-verification.ts";
import { PACKAGE_PATH } from "./release/contracts.ts";

export interface AcceptanceInput extends DeliveredBundleInput {
  stateRoot: string;
  evidenceDir: string;
  bin: string;
}

const NPM_CONFIG = "offline=true\nignore-scripts=true\npackage-lock=false\naudit=false\nfund=false\nupdate-notifier=false\n";

function fail(message: string): never {
  throw betaError("OPERATION_IN_DOUBT", message, "Keep existing delivery files unchanged, choose new private output paths, and retry the acceptance command.");
}

function noFollowNewDirectory(value: string, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be an absolute new directory.`);
  const resolved = path.resolve(value);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; fail(`${label} cannot be inspected safely.`); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} may not traverse symbolic links or files.`);
  }
  if (fs.existsSync(resolved)) fail(`${label} must not already exist.`);
  try { if (!fs.statSync(path.dirname(resolved)).isDirectory()) fail(`${label} requires an existing parent directory.`); }
  catch { fail(`${label} requires an existing parent directory.`); }
  return resolved;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function assertOutputsDisjoint(stateRoot: string, evidenceDir: string, input: AcceptanceInput): void {
  const deliveryPaths = [input.archivePath, input.publicKeyPath, input.bundleRoot, input.installedPackageRoot, input.bin].map(value => path.resolve(value));
  if (overlaps(stateRoot, evidenceDir) || deliveryPaths.some(delivery => overlaps(stateRoot, delivery) || overlaps(evidenceDir, delivery))) {
    fail("State and evidence directories must not overlap each other or delivered package inputs.");
  }
}

function deliveryInput(input: AcceptanceInput, installedPackageRoot = input.installedPackageRoot): DeliveredBundleInput {
  return {
    archivePath: input.archivePath,
    pinnedZipSha256: input.pinnedZipSha256,
    bundleRoot: input.bundleRoot,
    publicKeyPath: input.publicKeyPath,
    installedPackageRoot,
  };
}

function assertCallerBin(input: AcceptanceInput): string {
  const expected = path.join(path.resolve(input.installedPackageRoot), "bin", "trajecta-beta");
  if (typeof input.bin !== "string" || !path.isAbsolute(input.bin) || path.resolve(input.bin) !== expected) fail("Acceptance must use the executable from the audited installed package.");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(expected); } catch { return fail("The audited installed package executable is unavailable."); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) fail("The audited installed package executable must be a regular executable file.");
  return expected;
}

function localNpmCli(): string {
  const candidate = path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  try { const stat = fs.lstatSync(candidate); if (stat.isFile() && !stat.isSymbolicLink()) return candidate; } catch { /* bounded error below */ }
  return fail("The customer Node installation does not expose a local npm CLI.");
}

function isolatedNpmEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(?:^npm_config_|auth|proxy|registry)/i.test(key) && value !== undefined) environment[key] = value;
  }
  const home = path.join(root, "home"), cache = path.join(root, "cache"), prefix = path.join(root, "prefix");
  for (const directory of [home, cache, prefix]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const userConfig = path.join(root, "user.npmrc"), globalConfig = path.join(root, "global.npmrc");
  fs.writeFileSync(userConfig, NPM_CONFIG, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(globalConfig, NPM_CONFIG, { mode: 0o600, flag: "wx" });
  return { ...environment, HOME: home, TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: cache, NPM_CONFIG_PREFIX: prefix };
}

interface InstallEvidence { npmVersion: string; versionArgv: string[]; versionExitCode: number; argv: string[]; exitCode: number; stdout: string; stderr: string; }

function installOffline(input: AcceptanceInput, stateRoot: string): { installedPackageRoot: string; bin: string; evidence: InstallEvidence } {
  const root = path.join(stateRoot, "offline-install"), workspace = path.join(root, "workspace"), tmp = path.join(root, "tmp");
  for (const directory of [root, workspace, tmp]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "package.json"), "{\"name\":\"trajecta-acceptance-install\",\"private\":true}\n", { mode: 0o600, flag: "wx" });
  const npmCli = localNpmCli(), environment = isolatedNpmEnvironment(root);
  const version = spawnSync(process.execPath, [npmCli, "--version"], { cwd: workspace, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const npmVersion = (version.stdout ?? "").trim();
  if (version.error || version.status !== 0 || !/^\d+\.\d+\.\d+$/.test(npmVersion)) fail("The customer npm version could not be verified locally.");
  const tgz = path.join(input.bundleRoot, ...PACKAGE_PATH.split("/"));
  const args = [npmCli, "install", "--offline", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", tgz];
  const result = spawnSync(process.execPath, args, { cwd: workspace, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const evidence = { npmVersion, versionArgv: [process.execPath, npmCli, "--version"], versionExitCode: version.status ?? 1, argv: [process.execPath, ...args], exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if (result.error || result.status !== 0) fail("The authenticated package did not install with the isolated offline npm command.");
  const installedPackageRoot = path.join(workspace, "node_modules", "@patternstatic", "trajecta-beta");
  const bin = path.join(installedPackageRoot, "bin", "trajecta-beta");
  return { installedPackageRoot, bin, evidence };
}

function writeExclusive(file: string, bytes: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
}

function inventoryDigest(inventory: AcceptanceProofResult["stateInventory"]): string {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

function fullInventory(root: string, relative = ""): AcceptanceProofResult["stateInventory"] {
  const result: AcceptanceProofResult["stateInventory"] = [];
  const directory = path.join(root, relative);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const child = relative ? path.posix.join(relative.split(path.sep).join("/"), entry.name) : entry.name;
    const absolute = path.join(root, ...child.split("/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) result.push(...fullInventory(root, child));
    else if (stat.isFile() && !stat.isSymbolicLink()) { const bytes = fs.readFileSync(absolute); result.push({ path: child, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }); }
    else if (stat.isSymbolicLink()) { const bytes = Buffer.from(fs.readlinkSync(absolute)); result.push({ path: child, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }); }
    else fail("Acceptance state contains an unsupported filesystem entry.");
  }
  return result;
}

interface CleanupInventoryEntry { path: string; type: "directory" | "file" | "symlink"; sha256: string; bytes: number; }

function wholeTreeInventory(root: string, relative = ""): CleanupInventoryEntry[] {
  const result: CleanupInventoryEntry[] = [];
  const directory = path.join(root, relative);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const child = relative ? path.posix.join(relative.split(path.sep).join("/"), entry.name) : entry.name;
    const absolute = path.join(root, ...child.split("/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      result.push({ path: child, type: "directory", sha256: createHash("sha256").update("").digest("hex"), bytes: 0 });
      result.push(...wholeTreeInventory(root, child));
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      const bytes = fs.readFileSync(absolute); result.push({ path: child, type: "file", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    } else if (stat.isSymbolicLink()) {
      const bytes = Buffer.from(fs.readlinkSync(absolute)); result.push({ path: child, type: "symlink", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    } else fail("Disposable acceptance state contains an unsupported filesystem entry.");
  }
  return result;
}

function sanitize(value: string, roots: Array<[string, string]>): string {
  let result = value;
  for (const [root, label] of roots.sort((left, right) => right[0].length - left[0].length)) result = result.split(root).join(label);
  return result.replace(/capability:[A-Za-z0-9._-]+/g, "[redacted capability]").replace(/\/(?:Users|home)\/[^\s\"'<>]+/g, "[redacted home path]");
}

function commandReport(commands: AcceptanceProofResult["commands"], roots: Array<[string, string]>) {
  return commands.map(command => ({ argv: command.argv.map((value, index) => index === 0 ? "[installed bin]" : sanitize(value, roots)), exitCode: command.exitCode, stdout: sanitize(command.stdout, roots), stderr: sanitize(command.stderr, roots) }));
}

function absentNoFollow(file: string): boolean {
  try { fs.lstatSync(file); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Authenticate the delivery, reinstall it offline, and export repeatable acceptance evidence. */
export async function runAcceptance(input: AcceptanceInput): Promise<{code: "ACCEPTANCE_PASSED"; evidencePath: string}> {
  const expectedKeys = ["archivePath", "pinnedZipSha256", "bundleRoot", "publicKeyPath", "installedPackageRoot", "stateRoot", "evidenceDir", "bin"];
  if (!input || typeof input !== "object" || Object.keys(input).sort().join("\0") !== expectedKeys.sort().join("\0") || expectedKeys.some(key => typeof (input as unknown as Record<string, unknown>)[key] !== "string")) fail("Acceptance inputs are incomplete or unsupported.");
  const stateRoot = noFollowNewDirectory(input.stateRoot, "State root"), evidenceDir = noFollowNewDirectory(input.evidenceDir, "Evidence directory");
  assertOutputsDisjoint(stateRoot, evidenceDir, input);
  assertCallerBin(input);
  const callerAudit = verifyDeliveredBundle(deliveryInput(input));

  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const installed = installOffline(input, stateRoot);
  const installedAudit = verifyDeliveredBundle(deliveryInput(input, installed.installedPackageRoot));
  const primaryRoot = path.join(stateRoot, "proof-primary"), repeatRoot = path.join(stateRoot, "proof-repeat");
  const primary = await runAcceptanceProof({ root: primaryRoot, bin: installed.bin });
  const repeat = await runAcceptanceProof({ root: repeatRoot, bin: installed.bin });
  if (primary.finalRevision !== 4 || !Object.values(primary.checks).every(Boolean) || !Object.values(repeat.checks).every(Boolean) || JSON.stringify(primary.semanticTrace) !== JSON.stringify(repeat.semanticTrace)) fail("Independent acceptance proofs did not agree on the normalized semantic trace.");

  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(primary.receipts)) writeExclusive(path.join(evidenceDir, "receipts", `${name}.json`), bytes);
  for (const [name, bytes] of Object.entries(repeat.receipts)) writeExclusive(path.join(evidenceDir, "repeat-receipts", `${name}.json`), bytes);
  const roots: Array<[string, string]> = [[stateRoot, "<state-root>"], [evidenceDir, "<evidence-dir>"], [input.bundleRoot, "<bundle-root>"], [input.installedPackageRoot, "<caller-package>"]];
  writeExclusive(path.join(evidenceDir, "commands.json"), `${JSON.stringify({ primary: commandReport(primary.commands, roots), repeat: commandReport(repeat.commands, roots) }, null, 2)}\n`);
  const cleanupInventory = wholeTreeInventory(repeatRoot);
  writeExclusive(path.join(evidenceDir, "repeat-evidence.json"), `${JSON.stringify({ checks: repeat.checks, semanticTrace: repeat.semanticTrace, finalRevision: repeat.finalRevision, stateInventory: repeat.stateInventory, cleanupInventory }, null, 2)}\n`);

  fs.rmSync(repeatRoot, { recursive: true, force: false });
  const cleanupComplete = absentNoFollow(repeatRoot) && cleanupInventory.every(entry => absentNoFollow(path.join(repeatRoot, ...entry.path.split("/"))));
  if (!cleanupComplete) fail("The disposable repeat proof could not be removed exactly.");
  const evidencePath = path.join(evidenceDir, "evidence.json");
  const installReport = { npmVersion: installed.evidence.npmVersion, versionCommand: { argv: installed.evidence.versionArgv.map((_value, index) => index === 0 ? "[node]" : index === 1 ? "[local npm cli]" : installed.evidence.versionArgv[index]!), exitCode: installed.evidence.versionExitCode }, argv: installed.evidence.argv.map((_value, index) => index === 0 ? "[node]" : index === 1 ? "[local npm cli]" : sanitize(installed.evidence.argv[index]!, roots)), exitCode: installed.evidence.exitCode, stdout: sanitize(installed.evidence.stdout, roots), stderr: sanitize(installed.evidence.stderr, roots) };
  const stateInventory = fullInventory(stateRoot);
  const report = {
    schema: "trajecta.customer-acceptance-evidence/v1", code: "ACCEPTANCE_PASSED", evaluation: "not-for-sale",
    archiveAudit: callerAudit, installedArchiveAudit: installedAudit, runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch }, install: installReport,
    checks: primary.checks, beforeAfterDigests: { ...primary.evidence.beforeAfterDigests, finalInventorySha256: inventoryDigest(stateInventory) },
    targetStatus: primary.evidence.targetStatus, finalRevision: primary.finalRevision,
    semanticTrace: primary.semanticTrace, stateInventory, semanticEquivalent: true,
    cleanup: { root: "<state-root>/proof-repeat", inventory: cleanupInventory, complete: cleanupComplete }, manualIntervention: [], commandTrace: "commands.json",
  };
  writeExclusive(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  return { code: "ACCEPTANCE_PASSED", evidencePath };
}
