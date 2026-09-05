import { execFileSync } from "node:child_process";
import { constants, accessSync, lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveStateRoot } from "./args.ts";
import { inspectWriterLock } from "./writer-lock.ts";
import { observeWorkspace } from "./workspace.ts";

export const PRODUCT_NAME = "Trajecta Verified Resume SDK Beta";
export const PRODUCT_VERSION = "0.1.0";

export interface DoctorOptions {
  cwd: string;
  stateRoot?: string | null;
  platform?: string;
  architecture?: string;
  nodeVersion?: string;
}

export interface DoctorCheck {
  name: "platform" | "architecture" | "node" | "git" | "branch" | "origin" | "state-root-parent" | "state-root" | "sdk-files" | "writer-lock";
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  code: "OK" | "UNSUPPORTED_ENVIRONMENT" | "OPERATION_IN_DOUBT";
  exitCode: 0 | 2;
  checks: DoctorCheck[];
  repository?: string;
  branch?: string;
  stateRoot: ".trajecta-beta" | "configured";
  writerLock?: "absent" | "released";
}

function check(name: DoctorCheck["name"], ok: boolean, detail: string): DoctorCheck { return { name, ok, detail }; }

function nodeSupported(value: string): boolean {
  const matched = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!matched) return false;
  const major = Number(matched[1]), minor = Number(matched[2]);
  return major === 22 && minor >= 19;
}

function gitTopLevel(cwd: string): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return root ? realpathSync(root) : null;
  } catch { return null; }
}

function stateRootChecks(stateRoot: string, checks: DoctorCheck[]): boolean {
  const parent = path.dirname(stateRoot);
  try {
    const entry = lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
    accessSync(parent, constants.W_OK);
    checks.push(check("state-root-parent", true, "State-root parent is writable."));
  } catch {
    checks.push(check("state-root-parent", false, "State-root parent is not safely writable."));
    return false;
  }
  try {
    const entry = lstatSync(stateRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700) throw new Error();
    checks.push(check("state-root", true, "Existing state root is private and not a symbolic link."));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") checks.push(check("state-root", true, "State root is absent and will not be created by doctor."));
    else {
      checks.push(check("state-root", false, "State root is not a safe directory."));
      return false;
    }
  }
  return true;
}

function requiredSdkFilesPresent(): boolean {
  const source = path.dirname(fileURLToPath(import.meta.url));
  try {
    for (const file of [path.join(source, "index.ts"), path.join(source, "contracts.ts"), path.join(source, "..", "DEVELOPMENT-BOUNDARY.md")]) {
      const entry = lstatSync(file);
      if (!entry.isFile() || entry.isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

function unsupported(checks: DoctorCheck[], stateRoot: DoctorResult["stateRoot"]): DoctorResult {
  return { code: "UNSUPPORTED_ENVIRONMENT", exitCode: 2, checks, stateRoot };
}

/** Read-only audit. It never creates a state root, writer lock, receipt, or journal. */
export function runDoctor(options: DoctorOptions): DoctorResult {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const stateRootLabel = options.stateRoot === null || options.stateRoot === undefined ? ".trajecta-beta" : "configured";
  const checks: DoctorCheck[] = [
    check("platform", platform === "darwin", platform === "darwin" ? "macOS is supported." : "Only macOS is supported."),
    check("architecture", architecture === "arm64", architecture === "arm64" ? "Apple Silicon is supported." : "Only Apple Silicon is supported."),
    check("node", nodeSupported(nodeVersion), nodeSupported(nodeVersion) ? "Node.js version is supported." : "Node.js 22.19 through 22.x is required."),
  ];
  if (checks.some((entry) => !entry.ok)) return unsupported(checks, stateRootLabel);

  const workspaceRoot = gitTopLevel(options.cwd);
  if (!workspaceRoot) {
    checks.push(check("git", false, "A Git workspace is required."));
    return unsupported(checks, stateRootLabel);
  }
  checks.push(check("git", true, "Git workspace is available."));
  const stateRoot = resolveStateRoot(options.cwd, workspaceRoot, options.stateRoot ?? null);
  if (!stateRootChecks(stateRoot, checks)) return unsupported(checks, stateRootLabel);

  let observation;
  try { observation = observeWorkspace(options.cwd, stateRoot); }
  catch {
    checks.push(check("branch", false, "An attached Git branch and safe origin are required."));
    checks.push(check("origin", false, "A normalizable Git origin is required."));
    return unsupported(checks, stateRootLabel);
  }
  checks.push(check("branch", true, "An attached Git branch is available."));
  checks.push(check("origin", true, "Git origin was normalized without credentials."));
  const sdkFiles = requiredSdkFilesPresent();
  checks.push(check("sdk-files", sdkFiles, sdkFiles ? "Required repo-local SDK files are present." : "Required repo-local SDK files are missing."));
  if (!sdkFiles) return unsupported(checks, stateRootLabel);
  try {
    const writerLock = inspectWriterLock(observation.stateRoot);
    checks.push(check("writer-lock", true, writerLock.state === "absent" ? "No writer lock exists." : "Writer lock history is fully released."));
    return { code: "OK", exitCode: 0, checks, repository: observation.repository, branch: observation.branch, stateRoot: stateRootLabel, writerLock: writerLock.state };
  } catch {
    checks.push(check("writer-lock", false, "Writer lock evidence requires inspection."));
    return { code: "OPERATION_IN_DOUBT", exitCode: 2, checks, repository: observation.repository, branch: observation.branch, stateRoot: stateRootLabel };
  }
}
