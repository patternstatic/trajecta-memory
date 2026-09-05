import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { betaError } from "./errors.ts";

export interface WorkspaceObservation {
  repository: string;
  repositoryFingerprint: string;
  stateRootFingerprint: string;
  branch: string;
  workspaceRoot: string;
  stateRoot: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Git identity comes from fixed argv and cwd, never inherited Git overrides. */
export function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("GIT_")));
}

function unavailable(message: string): never {
  throw betaError("CAPABILITY_UNAVAILABLE", message);
}

function requiredGit(cwd: string, args: readonly string[]): string {
  try {
    const value = execFileSync("git", [...args], { cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!value) unavailable("The local workspace does not provide the required Git identity.");
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "BetaError") throw error;
    unavailable("The local workspace does not provide the required Git identity.");
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function assertNoSymlinkComponents(directory: string): void {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) unavailable("The configured state root must not traverse symbolic links.");
    } catch (error) {
      if (error instanceof Error && error.name === "BetaError") throw error;
      if (isMissing(error)) return;
      unavailable("Unable to inspect the configured state root.");
    }
  }
}

function intendedStateRoot(stateRoot: string): string {
  const rawParts = stateRoot.split(path.sep);
  if (rawParts.includes("..")) unavailable("The configured state root must not traverse parent directories.");
  const resolved = path.resolve(stateRoot);
  assertNoSymlinkComponents(resolved);
  let existing = resolved;
  const remaining: string[] = [];
  while (true) {
    try {
      const entry = lstatSync(existing);
      if (entry.isSymbolicLink() || !entry.isDirectory()) unavailable("The configured state root must be a non-symlink directory.");
      break;
    } catch (error) {
      if (error instanceof Error && error.name === "BetaError") throw error;
      if (!isMissing(error)) unavailable("Unable to inspect the configured state root.");
      const parent = path.dirname(existing);
      if (parent === existing) unavailable("The configured state root has no existing parent directory.");
      remaining.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const canonicalParent = realpathSync(existing);
  let canonical = canonicalParent;
  for (const component of remaining) {
    if (!component || component === "." || component === "..") unavailable("The configured state root is not canonical.");
    canonical = path.join(canonical, component);
  }
  return canonical;
}

export function normalizeRepositoryRemote(remote: string): string {
  if (!remote || /[\u0000-\u001f\u007f?#]/.test(remote)) unavailable("The Git origin remote is not a supported repository URL.");
  let host: string;
  let pathname: string;
  if (remote.includes("://")) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      unavailable("The Git origin remote is not a supported repository URL.");
    }
    if (!url.hostname || url.search || url.hash) unavailable("The Git origin remote is not a supported repository URL.");
    host = url.host.toLowerCase();
    pathname = url.pathname;
  } else {
    const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(remote);
    if (!match) unavailable("The Git origin remote is not a supported repository URL.");
    host = match[1]!.toLowerCase();
    pathname = match[2]!;
  }
  if (pathname.startsWith("/")) pathname = pathname.slice(1);
  if (pathname.endsWith(".git")) pathname = pathname.slice(0, -4);
  const parts = pathname.split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === ".." || /\s/.test(part))) {
    unavailable("The Git origin remote must name one owner and repository.");
  }
  return `${host}/${parts[0]}/${parts[1]}`;
}

export function observeWorkspace(cwd: string, stateRoot: string): WorkspaceObservation {
  const workspaceRoot = realpathSync(requiredGit(cwd, ["rev-parse", "--show-toplevel"]));
  const branch = requiredGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const repository = normalizeRepositoryRemote(requiredGit(cwd, ["config", "--get", "remote.origin.url"]));
  const canonicalStateRoot = intendedStateRoot(stateRoot);
  return {
    repository,
    repositoryFingerprint: sha256(repository),
    stateRootFingerprint: sha256(canonicalStateRoot),
    branch,
    workspaceRoot,
    stateRoot: canonicalStateRoot,
  };
}
