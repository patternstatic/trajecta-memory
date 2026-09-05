import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "./canonical.ts";
import { releaseError } from "./errors.ts";
import { auditTgz, type TarLedgerMember } from "./tar-reader.ts";

const FORBIDDEN_NETWORK_IMPORT = /(?:from\s*|import\s*)["'](?:node:)?(?:net|tls|http|https|http2|dgram|dns)["']/;
const NPM_CONFIG = "offline=true\nignore-scripts=true\npackage-lock=false\naudit=false\nfund=false\nupdate-notifier=false\n";

export interface ControlledOfflineInstallOptions {
  tgz: Buffer;
  memberLedger: readonly TarLedgerMember[];
  releaseInstant: unknown;
  npmCli: string;
  /** Test seam: callers may supply poisoned inherited configuration. */
  environment?: NodeJS.ProcessEnv;
}

export interface ControlledOfflineInstallResult {
  customerWorkspace: string;
  customerBranch: string;
  npmVersion: "10.9.8";
  version: string;
  doctor: string;
  demo: string;
  modificationNoticeSha256: string;
}

function command(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  try {
    return execFileSync(command, [...args], { cwd: options.cwd, env: options.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return releaseError("OFFLINE_INSTALL_FAILED", "The controlled offline package command did not complete.");
  }
}

function assertNpmCli(value: string): string {
  if (!path.isAbsolute(value)) return releaseError("INVALID_NPM_CLI", "npm CLI must be an absolute regular file.");
  const npmCli = path.resolve(value);
  let metadata: fs.Stats;
  try { metadata = fs.lstatSync(npmCli); }
  catch { return releaseError("INVALID_NPM_CLI", "npm CLI must be an absolute regular file."); }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return releaseError("INVALID_NPM_CLI", "npm CLI must be an absolute regular file.");
  const version = command(process.execPath, [npmCli, "--version"]).trim();
  if (version !== "10.9.8") return releaseError("NPM_VERSION_MISMATCH", "Controlled installation requires npm CLI version 10.9.8.");
  return npmCli;
}

function assertDependencyFreePackage(bytes: Buffer): void {
  let packageJson: Record<string, unknown>;
  try { packageJson = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
  catch { return releaseError("INVALID_OFFLINE_PACKAGE", "The package manifest must be valid JSON."); }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "scripts"]) {
    if (Object.hasOwn(packageJson, field)) releaseError("INVALID_OFFLINE_PACKAGE", "The offline package may not declare dependencies or scripts.");
  }
}

function assertNoNetworkImports(entries: ReadonlyMap<string, Buffer>): void {
  for (const [memberPath, bytes] of entries) {
    if ((memberPath.startsWith("beta/src/") || memberPath.startsWith("core/src/")) && memberPath.endsWith(".ts") && FORBIDDEN_NETWORK_IMPORT.test(bytes.toString("utf8"))) {
      releaseError("FORBIDDEN_NETWORK_IMPORT", "The offline SDK runtime may not import network-capable Node modules.");
    }
  }
}

function isolatedEnvironment(inherited: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!/(?:npm_config_|auth|proxy|registry)/i.test(key) && value !== undefined) environment[key] = value;
  }
  const home = path.join(root, "home"), cache = path.join(root, "cache"), prefix = path.join(root, "prefix");
  for (const directory of [home, cache, prefix]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const userConfig = path.join(root, "user.npmrc"), globalConfig = path.join(root, "global.npmrc");
  fs.writeFileSync(userConfig, NPM_CONFIG, { mode: 0o600 });
  fs.writeFileSync(globalConfig, NPM_CONFIG, { mode: 0o600 });
  return { ...environment, HOME: home, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: cache, NPM_CONFIG_PREFIX: prefix };
}

function createCustomerWorkspace(root: string, environment: NodeJS.ProcessEnv): string {
  const customer = path.join(root, "customer");
  fs.mkdirSync(customer, { mode: 0o700 });
  fs.writeFileSync(path.join(customer, "package.json"), "{\"name\":\"trajecta-offline-customer\",\"private\":true}\n", { mode: 0o600 });
  command("git", ["init", "-b", "main"], { cwd: customer, env: environment });
  command("git", ["add", "package.json"], { cwd: customer, env: environment });
  command("git", ["-c", "user.name=Trajecta Offline Customer", "-c", "user.email=offline@example.invalid", "commit", "-m", "Initial customer workspace"], { cwd: customer, env: environment });
  command("git", ["remote", "add", "origin", "https://example.invalid/customer/workspace.git"], { cwd: customer, env: environment });
  return customer;
}

/** Installs a verified local tgz with an npm environment that cannot inherit user npm configuration. */
export function runControlledOfflineInstall(options: ControlledOfflineInstallOptions): ControlledOfflineInstallResult {
  const npmCli = assertNpmCli(options.npmCli);
  const audited = auditTgz(options.tgz, { releaseInstant: options.releaseInstant, expectedMembers: options.memberLedger, packagePrefix: "package/" });
  const entries = audited.members;
  const notice = entries.get("LICENSES/CORE-MODIFICATIONS.txt");
  const packageJson = entries.get("package.json");
  if (!notice || !packageJson || audited.memberLedger.find(member => member.path === "LICENSES/CORE-MODIFICATIONS.txt")?.sha256 !== sha256Hex(notice)) {
    return releaseError("TAR_LEDGER_MISMATCH", "The package modification notice must be bound by the audited ledger.");
  }
  assertDependencyFreePackage(packageJson);
  assertNoNetworkImports(entries);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-controlled-offline-")));
  const environment = isolatedEnvironment(options.environment ?? process.env, root);
  const customer = createCustomerWorkspace(root, environment);
  const localTgz = path.join(root, "trajecta-beta-0.1.0.tgz");
  fs.writeFileSync(localTgz, options.tgz, { mode: 0o600 });
  command(process.execPath, [npmCli, "install", "--offline", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", localTgz], { cwd: customer, env: environment });
  const installedRoot = path.join(customer, "node_modules", "@patternstatic", "trajecta-beta");
  const installedNotice = path.join(installedRoot, "LICENSES", "CORE-MODIFICATIONS.txt");
  let installedBytes: Buffer;
  try { installedBytes = fs.readFileSync(installedNotice); }
  catch { return releaseError("INSTALLED_NOTICE_MISSING", "The installed package lacks its required modification notice."); }
  if (!installedBytes.equals(notice)) return releaseError("INSTALLED_NOTICE_MISMATCH", "The installed modification notice must match the audited tar member exactly.");
  const bin = path.join(customer, "node_modules", ".bin", "trajecta-beta");
  const stateRoot = path.join(root, "demo-state");
  const version = command(bin, ["version"], { cwd: customer, env: environment });
  const doctor = command(bin, ["doctor", "--state-root", stateRoot], { cwd: customer, env: environment });
  const demo = command(bin, ["demo", "--state-root", stateRoot], { cwd: customer, env: environment });
  return Object.freeze({ customerWorkspace: customer, customerBranch: command("git", ["branch", "--show-current"], { cwd: customer, env: environment }).trim(), npmVersion: "10.9.8", version, doctor, demo, modificationNoticeSha256: sha256Hex(installedBytes) });
}
