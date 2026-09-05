import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { sha256Hex } from "./canonical.ts";
import { parseCommitDigest } from "./contracts.ts";
import { releaseError } from "./errors.ts";

export interface PayloadPolicy {
  schema: string;
  sourceRoots: string[];
  stagedPaths: string[];
  exclusionList: string[];
}

export interface SnapshotEntry {
  path: string;
  bytes: number;
  mode: string;
  sha256: string;
}

export interface SourceSnapshot {
  root: string;
  buildCommit: string;
  entries: readonly SnapshotEntry[];
}

export interface PreflightOptions {
  sourceRoot: string;
  gitBin: string;
  buildCommit: string;
  policy: PayloadPolicy;
  beforeCopy?: () => void;
}

interface GitContext {
  sourceRoot: string;
  gitDir: string;
  environment: NodeJS.ProcessEnv;
}

function assertGitBin(gitBin: string): string {
  if (!path.isAbsolute(gitBin)) return releaseError("INVALID_GIT_BIN", "--git-bin must be absolute.");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(gitBin); } catch { return releaseError("INVALID_GIT_BIN", "--git-bin must exist."); }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) return releaseError("INVALID_GIT_BIN", "--git-bin must be a no-follow regular executable.");
  return gitBin;
}

function gitEnvironment(): { environment: NodeJS.ProcessEnv; cleanup: () => void } {
  const inheritedOverrides = Object.keys(process.env).filter((key) => /^GIT_CONFIG_/i.test(key));
  if (inheritedOverrides.length > 0) releaseError("UNSAFE_GIT_ENV", "Git configuration overrides are not accepted.");
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const emptyGlobalConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-release-git-config-")), "global.gitconfig");
  fs.writeFileSync(emptyGlobalConfig, "");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return { environment, cleanup: () => fs.rmSync(path.dirname(emptyGlobalConfig), { recursive: true, force: true, maxRetries: 2 }) };
}

function noFollowText(file: string, label: string): string {
  let expected: fs.Stats;
  try { expected = fs.lstatSync(file); } catch { return releaseError("INVALID_GIT_DIR", `${label} is missing.`); }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size === 0 || expected.size > 4096 || (expected.mode & 0o133) !== 0 || (expected.mode & 0o400) === 0) return releaseError("INVALID_GIT_DIR", `${label} must be a bounded no-follow regular file.`);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, flags);
    const actual = fs.fstatSync(descriptor);
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || (actual.mode & 0o777) !== (expected.mode & 0o777)) return releaseError("INVALID_GIT_DIR", `${label} changed while being read.`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size || (after.mode & 0o777) !== (expected.mode & 0o777)) return releaseError("INVALID_GIT_DIR", `${label} changed while being read.`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return releaseError("INVALID_GIT_DIR", `${label} must be UTF-8.`); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function noFollowDirectory(directory: string, label: string): string {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); } catch { return releaseError("INVALID_GIT_DIR", `${label} is missing.`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return releaseError("INVALID_GIT_DIR", `${label} must be a no-follow directory.`);
  return directory;
}

function resolvePointer(base: string, pointer: string, label: string): string {
  if (!/^[^\r\n\0]+$/.test(pointer)) return releaseError("INVALID_GIT_DIR", `${label} pointer is malformed.`);
  return path.resolve(base, pointer);
}

function resolveLinkedGitDirectory(sourceRoot: string, pointerFile: string): string {
  const pointer = noFollowText(pointerFile, ".git pointer");
  const matched = /^gitdir: ([^\r\n\0]+)\n$/.exec(pointer);
  if (!matched) return releaseError("INVALID_GIT_DIR", ".git pointer must contain exactly one gitdir line.");
  const gitDir = noFollowDirectory(resolvePointer(path.dirname(pointerFile), matched[1], ".git"), "linked gitdir");
  const worktreePointer = noFollowText(path.join(gitDir, "gitdir"), "linked gitdir metadata");
  if (!/^[^\r\n\0]+\n$/.test(worktreePointer)) return releaseError("INVALID_GIT_DIR", "Linked gitdir metadata must contain exactly one worktree path.");
  const boundWorktreeFile = resolvePointer(gitDir, worktreePointer.slice(0, -1), "linked gitdir metadata");
  if (boundWorktreeFile !== pointerFile) return releaseError("INVALID_GIT_DIR", "Linked gitdir metadata is not bound to this worktree.");
  const commonPointer = noFollowText(path.join(gitDir, "commondir"), "linked common-dir metadata");
  if (!/^[^\r\n\0]+\n$/.test(commonPointer)) return releaseError("INVALID_GIT_DIR", "Linked common-dir metadata must contain exactly one path.");
  const commonDir = noFollowDirectory(resolvePointer(gitDir, commonPointer.slice(0, -1), "linked common-dir metadata"), "linked common gitdir");
  const relative = path.relative(commonDir, gitDir);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] !== "worktrees" || relative.split(path.sep).some((part) => part === ".." || part.length === 0)) return releaseError("INVALID_GIT_DIR", "Linked gitdir is outside its common worktree metadata.");
  return gitDir;
}

function resolveGitDirectory(sourceRoot: string): string {
  const candidate = path.join(sourceRoot, ".git");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(candidate); } catch { return releaseError("INVALID_GIT_DIR", "Source root must contain a regular .git directory."); }
  if (stat.isSymbolicLink()) return releaseError("INVALID_GIT_DIR", "Source root .git may not be a symbolic link.");
  if (stat.isDirectory()) return candidate;
  if (stat.isFile()) return resolveLinkedGitDirectory(sourceRoot, candidate);
  return releaseError("INVALID_GIT_DIR", "Source root must contain a no-follow .git directory or linked-worktree pointer.");
}

function runGit(gitBin: string, context: GitContext, args: string[]): Buffer {
  try {
    return execFileSync(gitBin, ["--no-replace-objects", `--git-dir=${context.gitDir}`, `--work-tree=${context.sourceRoot}`, ...args], { cwd: context.sourceRoot, env: context.environment, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return releaseError("GIT_PREFLIGHT_FAILED", "Git preflight rejected the source inputs.");
  }
}

function requirePolicy(policy: PayloadPolicy): void {
  if (!policy || policy.schema !== "trajecta.release-payload-policy/v1" || !Array.isArray(policy.sourceRoots) || policy.sourceRoots.length === 0 || !Array.isArray(policy.stagedPaths) || !Array.isArray(policy.exclusionList) || [...policy.sourceRoots, ...policy.stagedPaths, ...policy.exclusionList].some((item) => typeof item !== "string" || item.length === 0 || path.isAbsolute(item) || item.includes("\\") || item.includes(".."))) {
    releaseError("INVALID_POLICY", "Payload policy is invalid.");
  }
}

function nulList(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean).sort();
}

function rootForPattern(pattern: string): string {
  if (!/[?*[]/.test(pattern)) return pattern;
  const prefix = pattern.slice(0, pattern.search(/[?*[]/));
  const root = prefix.endsWith("/") ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  if (root === ".") return releaseError("INVALID_POLICY", "Policy patterns must have a literal path root.");
  return root;
}

function globPattern(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") { index += 1; expression += "(?:.*/)?"; }
        else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function expandCommitAllowlist(gitBin: string, context: GitContext, buildCommit: string, sourceRoots: string[]): string[] {
  // Keep the policy roots visible in the authoritative Git invocation, then expand recursive patterns only from that commit tree.
  const direct = nulList(runGit(gitBin, context, ["ls-tree", "-r", "-z", "--name-only", buildCommit, "--", ...sourceRoots]));
  if (!sourceRoots.some((root) => /[?*[]/.test(root))) {
    for (const sourceRoot of sourceRoots) if (!direct.some((entry) => entry === sourceRoot || entry.startsWith(`${sourceRoot}/`))) releaseError("POLICY_INPUT_MISSING", "Every policy source root must match the build commit.");
    return direct;
  }
  const roots = [...new Set(sourceRoots.map(rootForPattern))];
  const candidates = nulList(runGit(gitBin, context, ["ls-tree", "-r", "-z", "--name-only", buildCommit, "--", ...roots]));
  const expanded = sourceRoots.map((sourceRoot) => {
    const matches = /[?*[]/.test(sourceRoot) ? candidates.filter((candidate) => globPattern(sourceRoot).test(candidate)) : direct.filter((candidate) => candidate === sourceRoot || candidate.startsWith(`${sourceRoot}/`));
    if (matches.length === 0) releaseError("POLICY_INPUT_MISSING", "Every policy source root must match the build commit.");
    return matches;
  });
  return [...new Set(expanded.flat())].sort();
}

function commitBlob(gitBin: string, context: GitContext, buildCommit: string, relative: string): Buffer {
  return runGit(gitBin, context, ["cat-file", "blob", `${buildCommit}:${relative}`]);
}

function commitMode(gitBin: string, context: GitContext, buildCommit: string, relative: string): number {
  const entry = nulList(runGit(gitBin, context, ["ls-tree", "-z", buildCommit, "--", relative]))[0];
  const match = /^(\d+) blob [a-f0-9]+\t/.exec(entry ?? "");
  if (!match) return releaseError("POLICY_INPUT_MISSING", "Commit-tree source metadata is missing.");
  return Number.parseInt(match[1], 8) & 0o777;
}

function copyNoFollow(source: string, destination: string, expected: fs.Stats, blob: Buffer, mode: number): SnapshotEntry {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(source, flags);
    const actual = fs.fstatSync(descriptor);
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) releaseError("SOURCE_CHANGED", "A source input changed during snapshot.");
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) releaseError("SOURCE_CHANGED", "A source input changed during snapshot.");
    if (!content.equals(blob) || (actual.mode & 0o777) !== mode) releaseError("SOURCE_CHANGED", "Source bytes or mode do not match the build commit.");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, content, { mode: 0o400, flag: "wx" });
    return Object.freeze({ path: "", bytes: content.length, mode: mode.toString(8).padStart(4, "0"), sha256: sha256Hex(content) });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function freezeSnapshot(root: string, buildCommit: string, entries: SnapshotEntry[]): SourceSnapshot {
  const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  return Object.freeze({ root, buildCommit, entries: frozenEntries });
}

export function preflightSource(options: PreflightOptions): SourceSnapshot {
  const gitBin = assertGitBin(options.gitBin);
  const sourceRoot = fs.realpathSync(options.sourceRoot);
  requirePolicy(options.policy);
  parseCommitDigest(options.buildCommit);
  const git = gitEnvironment();
  try {
  const context: GitContext = { sourceRoot, gitDir: resolveGitDirectory(sourceRoot), environment: git.environment };
  const version = runGit(gitBin, context, ["--version"]).toString("utf8").trim();
  if (!/^git version \d/.test(version)) return releaseError("INVALID_GIT_BIN", "--git-bin is not Git.");
  const buildCommit = runGit(gitBin, context, ["rev-parse", "--verify", `${options.buildCommit}^{commit}`]).toString("utf8").trim();
  const headCommit = runGit(gitBin, context, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
  if (buildCommit !== options.buildCommit || headCommit !== buildCommit) return releaseError("BUILD_COMMIT_NOT_HEAD", "buildCommit must resolve exactly to HEAD.");
  const inputs = expandCommitAllowlist(gitBin, context, buildCommit, options.policy.sourceRoots);
  if (inputs.length === 0) return releaseError("POLICY_INPUT_MISSING", "A policy source root has no member in the build commit.");
  const scopedStatus = nulList(runGit(gitBin, context, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...inputs]));
  const rootStatus = nulList(runGit(gitBin, context, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...[...new Set(options.policy.sourceRoots.map(rootForPattern))]]));
  if (scopedStatus.length > 0 || rootStatus.length > 0) return releaseError("DIRTY_SOURCE", "Allowlisted source inputs must be clean.");
  const folds = new Set<string>();
  for (const input of inputs) {
    const folded = input.toLocaleLowerCase("en-US");
    if (folds.has(folded)) return releaseError("CASE_COLLISION", "Source inputs may not case-fold collide.");
    folds.add(folded);
  }
  const observed: Array<{ relative: string; source: string; stat: fs.Stats; blob: Buffer; mode: number }> = [];
  for (const relative of inputs) {
    const source = path.resolve(sourceRoot, relative);
    if (!source.startsWith(`${sourceRoot}${path.sep}`)) return releaseError("UNSAFE_SOURCE", "Commit-tree input escapes the source root.");
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source); } catch { return releaseError("SOURCE_MISSING", "A commit-tree source input is absent."); }
    if (!stat.isFile() || stat.isSymbolicLink()) return releaseError("UNSAFE_SOURCE", "Source inputs must be regular files.");
    observed.push({ relative, source, stat, blob: commitBlob(gitBin, context, buildCommit, relative), mode: commitMode(gitBin, context, buildCommit, relative) });
  }
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-release-snapshot-"));
  try {
    options.beforeCopy?.();
    const entries = observed.map(({ relative, source, stat, blob, mode }) => ({ ...copyNoFollow(source, path.join(snapshotRoot, relative), stat, blob, mode), path: relative }));
    return freezeSnapshot(snapshotRoot, buildCommit, entries);
  } catch (error) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
  } finally {
    git.cleanup();
  }
}
