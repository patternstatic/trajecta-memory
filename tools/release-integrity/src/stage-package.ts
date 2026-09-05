import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { TextDecoder } from "node:util";
import { sha256Hex } from "./canonical.ts";
import { assertSafeArchivePath, ORIGINAL_LICENSE_CLASSES, resolveReleaseKind, type OriginalLicenseClass, type ReleaseKind } from "./contracts.ts";
import { releaseError } from "./errors.ts";
import type { SnapshotEntry, SourceSnapshot } from "./preflight-source.ts";

const BETA_SOURCE_PREFIX = "packages/trajecta-beta/src/";
const CORE_SOURCE_PREFIX = "src/";
const REQUIRED_TEMPLATE_FILES = [
  "bin/trajecta-beta", "beta/DEVELOPMENT-BOUNDARY.md", "beta/src", "core/src", "LICENSE", "NOTICE", "BETA-COMMERCIAL-TERMS.txt", "LICENSES/CORE-MODIFICATIONS.txt",
] as const;
const SNAPSHOT_REQUIRED = ["release/payload-policy.json", "release/trajecta-beta.package.json", "release/license-map.json", "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt", "LICENSE", "NOTICE", "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md", "packages/trajecta-beta/bin/trajecta-beta"] as const;
const KERNEL_SPECIFIER = "../../../src/index.ts";
const STAGED_KERNEL_SPECIFIER = "../../core/src/index.ts";

export interface LicenseMapEntry {
  path: string;
  originalClass: OriginalLicenseClass;
  modified?: boolean;
}

export interface StagedMember {
  path: string;
  bytes: number;
  sha256: string;
  mode: "0644" | "0755";
  originalClass: OriginalLicenseClass;
}

export interface StagePackageOptions {
  snapshot: SourceSnapshot;
  /** A new, absolute staging directory. The package is created below it. */
  stageDirectory: string;
  releaseKind?: ReleaseKind;
}

export interface StagedPackage {
  stageDirectory: string;
  packageRoot: string;
  members: readonly StagedMember[];
  modifiedApacheMembers: readonly string[];
}

interface SnapshotIndex {
  root: string;
  entries: ReadonlyMap<string, SnapshotEntry>;
}

interface DirectoryBinding {
  path: string;
  dev: number;
  ino: number;
  mode: number;
  descriptor: number;
}

function samePathOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSnapshotRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    return releaseError("UNSAFE_SNAPSHOT", "Snapshot paths must be safe, non-empty relative POSIX paths.");
  }
  return value;
}

function indexSnapshot(snapshot: SourceSnapshot): SnapshotIndex {
  if (!snapshot || typeof snapshot.root !== "string" || !path.isAbsolute(snapshot.root) || !Array.isArray(snapshot.entries)) releaseError("INVALID_SNAPSHOT", "A frozen source snapshot is required.");
  const root = path.resolve(snapshot.root);
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(root); }
  catch { return releaseError("INVALID_SNAPSHOT", "Snapshot root is unavailable."); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return releaseError("UNSAFE_SNAPSHOT", "Snapshot root must be a no-follow directory.");
  const entries = new Map<string, SnapshotEntry>();
  const folded = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.path !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[0-7]{4}$/.test(entry.mode)) releaseError("INVALID_SNAPSHOT", "Snapshot ledger entry is invalid.");
    const relative = assertSnapshotRelativePath(entry.path);
    const foldedPath = relative.toLocaleLowerCase("en-US");
    if (entries.has(relative) || folded.has(foldedPath)) releaseError("CASE_COLLISION", "Snapshot entries may not duplicate or case-fold collide.");
    entries.set(relative, entry);
    folded.add(foldedPath);
  }
  return { root, entries };
}

function openBoundDirectory(directory: string): DirectoryBinding {
  let expected: fs.Stats;
  try { expected = fs.lstatSync(directory); } catch { return releaseError("UNSAFE_SNAPSHOT", "Snapshot ancestry is unavailable."); }
  if (!expected.isDirectory() || expected.isSymbolicLink()) return releaseError("UNSAFE_SNAPSHOT", "Snapshot ancestry must contain only no-follow directories.");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, flags);
    const actual = fs.fstatSync(descriptor);
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino || (actual.mode & 0o777) !== (expected.mode & 0o777)) return releaseError("UNSAFE_SNAPSHOT", "Snapshot ancestry changed while being opened.");
    return { path: directory, dev: actual.dev, ino: actual.ino, mode: actual.mode & 0o777, descriptor };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ELOOP") return releaseError("UNSAFE_SNAPSHOT", "Snapshot ancestry may not contain symbolic links.");
    if (error instanceof Error && error.name === "ReleaseIntegrityError") throw error;
    return releaseError("UNSAFE_SNAPSHOT", "Snapshot ancestry could not be opened without following links.");
  }
}

function verifyDirectoryBinding(binding: DirectoryBinding): void {
  const descriptorStat = fs.fstatSync(binding.descriptor);
  let pathStat: fs.Stats;
  try { pathStat = fs.lstatSync(binding.path); } catch { return releaseError("SNAPSHOT_DRIFT", "Snapshot ancestry changed while being read."); }
  if (!descriptorStat.isDirectory() || descriptorStat.dev !== binding.dev || descriptorStat.ino !== binding.ino || (descriptorStat.mode & 0o777) !== binding.mode || !pathStat.isDirectory() || pathStat.isSymbolicLink() || pathStat.dev !== binding.dev || pathStat.ino !== binding.ino || (pathStat.mode & 0o777) !== binding.mode) releaseError("SNAPSHOT_DRIFT", "Snapshot ancestry changed while being read.");
}

function openSnapshotAncestry(index: SnapshotIndex, relative: string): DirectoryBinding[] {
  const components = relative.split("/");
  const bindings: DirectoryBinding[] = [];
  let current = index.root;
  try {
    bindings.push(openBoundDirectory(current));
    for (const component of components.slice(0, -1)) {
      current = path.join(current, component);
      bindings.push(openBoundDirectory(current));
    }
    return bindings;
  } catch (error) {
    for (const binding of bindings) fs.closeSync(binding.descriptor);
    throw error;
  }
}

function closeSnapshotAncestry(bindings: readonly DirectoryBinding[]): void {
  for (const binding of bindings) fs.closeSync(binding.descriptor);
}

function readSnapshot(index: SnapshotIndex, relative: string): Buffer {
  const entry = index.entries.get(relative);
  if (!entry) return releaseError("SNAPSHOT_INPUT_MISSING", "The frozen snapshot lacks a required staged input.");
  const source = path.resolve(index.root, relative);
  if (!source.startsWith(`${index.root}${path.sep}`)) return releaseError("UNSAFE_SNAPSHOT", "Snapshot input escapes the snapshot root.");
  const ancestry = openSnapshotAncestry(index, relative);
  let expected: fs.Stats;
  try {
    try { expected = fs.lstatSync(source); } catch { return releaseError("SNAPSHOT_INPUT_MISSING", "A frozen snapshot input is absent."); }
    if (!expected.isFile() || expected.isSymbolicLink()) return releaseError("UNSAFE_SNAPSHOT", "Snapshot inputs must be no-follow regular files.");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(source, flags);
      const actual = fs.fstatSync(descriptor);
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size) return releaseError("SNAPSHOT_DRIFT", "A snapshot input changed while being read.");
      for (const binding of ancestry) verifyDirectoryBinding(binding);
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      for (const binding of ancestry) verifyDirectoryBinding(binding);
      if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size) return releaseError("SNAPSHOT_DRIFT", "A snapshot input changed while being read.");
      if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) return releaseError("SNAPSHOT_DRIFT", "Snapshot input bytes do not match the frozen ledger.");
      return bytes;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  } finally {
    closeSnapshotAncestry(ancestry);
  }
}

function utf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return releaseError("INVALID_UTF8", `${label} must be UTF-8.`); }
}

function parsePackageTemplate(bytes: Buffer): void {
  let template: Record<string, unknown>;
  try { template = JSON.parse(utf8(bytes, "Package template")) as Record<string, unknown>; }
  catch { return releaseError("INVALID_PACKAGE_TEMPLATE", "Package template must be JSON."); }
  const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
    const keys = Object.keys(value).sort(samePathOrder);
    const sortedExpected = [...expected].sort(samePathOrder);
    return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
  };
  if (!template || Array.isArray(template) || !exactKeys(template, ["name", "version", "private", "type", "engines", "bin", "files"]) || template.name !== "@patternstatic/trajecta-beta" || template.version !== "0.1.0" || template.private !== true || template.type !== "module") return releaseError("INVALID_PACKAGE_TEMPLATE", "Package template identity is invalid.");
  const engines = template.engines as Record<string, unknown>;
  const bin = template.bin as Record<string, unknown>;
  if (!engines || Array.isArray(engines) || !exactKeys(engines, ["node"]) || engines.node !== ">=22.19 <23" || !bin || Array.isArray(bin) || !exactKeys(bin, ["trajecta-beta"]) || bin["trajecta-beta"] !== "bin/trajecta-beta") releaseError("INVALID_PACKAGE_TEMPLATE", "Package template runtime fields are invalid.");
  if (!Array.isArray(template.files) || template.files.length !== REQUIRED_TEMPLATE_FILES.length || template.files.some((value, index) => value !== REQUIRED_TEMPLATE_FILES[index])) releaseError("INVALID_PACKAGE_TEMPLATE", "Package template files list is invalid.");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "scripts"]) if (Object.hasOwn(template, field)) releaseError("INVALID_PACKAGE_TEMPLATE", "The staged package cannot declare dependencies or lifecycle scripts.");
}

function parseLicenseMap(bytes: Buffer): Map<string, LicenseMapEntry> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(utf8(bytes, "License map")) as Record<string, unknown>; }
  catch { return releaseError("INVALID_LICENSE_MAP", "License map must be JSON."); }
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 2 || parsed.schema !== "trajecta.release-license-map/v1" || !Array.isArray(parsed.members)) releaseError("INVALID_LICENSE_MAP", "License map schema is invalid.");
  const entries = new Map<string, LicenseMapEntry>();
  const folded = new Set<string>();
  let previous = "";
  for (const raw of parsed.members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) releaseError("INVALID_LICENSE_MAP", "License map member is invalid.");
    const candidate = raw as Record<string, unknown>;
    const memberPath = assertSafeArchivePath(candidate.path);
    const originalClass = candidate.originalClass;
    if (!ORIGINAL_LICENSE_CLASSES.includes(originalClass as OriginalLicenseClass)) releaseError("INVALID_LICENSE_MAP", "License map class is invalid.");
    const expectedKeys = originalClass === "apache-core" ? ["path", "originalClass", "modified"] : ["path", "originalClass"];
    if (Object.keys(candidate).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(candidate, key))) releaseError("INVALID_LICENSE_MAP", "License map member fields are invalid.");
    if (originalClass === "apache-core" && typeof candidate.modified !== "boolean") releaseError("MISSING_MODIFICATION_STATE", "Every Apache-derived member needs an explicit modification state.");
    if (memberPath <= previous || entries.has(memberPath) || folded.has(memberPath.toLocaleLowerCase("en-US"))) releaseError("CASE_COLLISION", "License map paths must be uniquely sorted without case collisions.");
    previous = memberPath;
    folded.add(memberPath.toLocaleLowerCase("en-US"));
    entries.set(memberPath, { path: memberPath, originalClass: originalClass as OriginalLicenseClass, modified: candidate.modified as boolean | undefined });
  }
  return entries;
}

function parseStagedPolicyPaths(bytes: Buffer): string[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(utf8(bytes, "Payload policy")) as Record<string, unknown>; }
  catch { return releaseError("INVALID_POLICY", "Payload policy must be JSON."); }
  if (!parsed || Array.isArray(parsed) || parsed.schema !== "trajecta.release-payload-policy/v1" || !Array.isArray(parsed.stagedPaths)) releaseError("INVALID_POLICY", "Payload policy staged paths are invalid.");
  const paths = parsed.stagedPaths.map((candidate) => {
    const value = assertSafeArchivePath(candidate);
    if (!value.startsWith("package/")) return releaseError("INVALID_POLICY", "Payload policy staged paths must be package-relative.");
    return value.slice("package/".length);
  });
  if (paths.length === 0 || paths.some((member, index) => index > 0 && member <= paths[index - 1])) releaseError("INVALID_POLICY", "Payload policy staged paths must be strictly sorted and unique.");
  return paths;
}

function moduleSpecifiers(source: string): string[] {
  // Dynamic loading can bypass the staged import boundary. This package has no
  // dynamic-import use case, so fail before attempting static import analysis.
  if (/\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/.test(source)) releaseError("DYNAMIC_IMPORT_FORBIDDEN", "Staged runtime source may not use dynamic imports.");
  const specifiers: string[] = [];
  const expression = /\b(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const matched of source.matchAll(expression)) specifiers.push(matched[1]);
  return specifiers;
}

function resolveRelativeModule(from: string, specifier: string, code: string): string {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (resolved === ".." || resolved.startsWith("../") || !resolved.endsWith(".ts")) return releaseError(code, "A staged relative module import is unsafe or unsupported.");
  return resolved;
}

function compileRuntimeSource(bytes: Buffer, label: string): Buffer {
  let compiled: string;
  try { compiled = stripTypeScriptTypes(utf8(bytes, label), { mode: "strip" }); }
  catch { return releaseError("RUNTIME_COMPILE_FAILED", "A staged runtime source could not be compiled to deterministic JavaScript."); }
  // Runtime source imports are already statically constrained above. Rewrite
  // only their explicit relative TypeScript module suffixes after stripping.
  return Buffer.from(compiled.replace(/(["'][A-Za-z0-9._/-]+)\.ts(["'])/g, "$1.js$2"), "utf8");
}

function collectCoreSources(index: SnapshotIndex): string[] {
  const pending = ["src/index.ts"];
  const selected = new Set<string>();
  while (pending.length > 0) {
    const relative = pending.pop()!;
    if (selected.has(relative)) continue;
    if (!relative.startsWith(CORE_SOURCE_PREFIX)) releaseError("CORE_IMPORT_ESCAPE", "Core imports must stay within core/src.");
    const source = utf8(readSnapshot(index, relative), "Core source");
    selected.add(relative);
    for (const specifier of moduleSpecifiers(source)) {
      const resolved = resolveRelativeModule(relative, specifier, "CORE_IMPORT_ESCAPE");
      if (!resolved.startsWith(CORE_SOURCE_PREFIX)) releaseError("CORE_IMPORT_ESCAPE", "Core imports must stay within core/src.");
      pending.push(resolved);
    }
  }
  return [...selected].sort(samePathOrder);
}

function collectBetaSources(index: SnapshotIndex): string[] {
  const sources = [...index.entries.keys()].filter((relative) => relative.startsWith(BETA_SOURCE_PREFIX) && relative.endsWith(".ts")).sort(samePathOrder);
  if (sources.length === 0) releaseError("SNAPSHOT_INPUT_MISSING", "Snapshot lacks beta runtime source files.");
  for (const relative of sources) {
    const source = utf8(readSnapshot(index, relative), "Beta source");
    for (const specifier of moduleSpecifiers(source)) {
      if (relative.endsWith("/kernel-port.ts") && specifier === KERNEL_SPECIFIER) continue;
      const resolved = resolveRelativeModule(relative, specifier, "BETA_IMPORT_ESCAPE");
      if (!resolved.startsWith(BETA_SOURCE_PREFIX) || !index.entries.has(resolved)) releaseError("BETA_IMPORT_ESCAPE", "Beta relative imports must resolve inside beta/src.");
    }
  }
  return sources;
}

function renderCoreModificationsFromEntries(entries: readonly LicenseMapEntry[]): Buffer {
  const modified = entries.filter((entry) => entry.originalClass === "apache-core" && entry.modified === true).map((entry) => entry.path).sort(samePathOrder);
  const body = modified.length === 0
    ? "No staged Apache-derived members are marked modified by the release license policy.\n"
    : `The following staged Apache-derived members are marked modified by the release license policy:\n${modified.map((member) => `- ${member}\n`).join("")}`;
  return Buffer.from(`Trajecta Verified Resume SDK Beta — Apache-derived modification notice\n\n${body}`, "utf8");
}

/** Generates the exact notice bytes that must also be folded into outer CORE-NOTICE.txt. */
export function renderCoreModifications(entries: readonly LicenseMapEntry[]): Buffer {
  return renderCoreModificationsFromEntries(entries);
}

function assertNewStageDirectory(stageDirectory: string, snapshotRoot: string): string {
  if (!path.isAbsolute(stageDirectory)) return releaseError("INVALID_STAGE_DIRECTORY", "Stage directory must be absolute.");
  const resolved = path.resolve(stageDirectory);
  if (resolved === snapshotRoot || resolved.startsWith(`${snapshotRoot}${path.sep}`)) return releaseError("INVALID_STAGE_DIRECTORY", "Stage directory must be outside the snapshot.");
  if (fs.existsSync(resolved)) return releaseError("INVALID_STAGE_DIRECTORY", "Stage directory must not already exist.");
  // This staging area is a caller-owned temporary workspace. Its publishable
  // output is validated separately by Task 6; macOS itself exposes /var via a
  // system symlink, so ancestry is deliberately not treated as source input.
  try { if (!fs.statSync(path.dirname(resolved)).isDirectory()) return releaseError("INVALID_STAGE_DIRECTORY", "Stage directory parent must be a directory."); }
  catch { return releaseError("INVALID_STAGE_DIRECTORY", "Stage directory ancestor is unavailable."); }
  return resolved;
}

function writeMember(packageRoot: string, relative: string, bytes: Buffer, mode: "0644" | "0755", licenseMap: Map<string, LicenseMapEntry>, members: StagedMember[]): void {
  const memberPath = assertSafeArchivePath(relative);
  const classification = licenseMap.get(memberPath);
  if (!classification) releaseError("UNCLASSIFIED_MEMBER", "Every staged member must have one license-map classification.");
  const destination = path.resolve(packageRoot, memberPath);
  if (!destination.startsWith(`${packageRoot}${path.sep}`)) return releaseError("UNSAFE_STAGE_PATH", "A staged path escapes the package root.");
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.writeFileSync(destination, bytes, { mode: Number.parseInt(mode, 8), flag: "wx" });
  fs.chmodSync(destination, Number.parseInt(mode, 8));
  members.push(Object.freeze({ path: memberPath, bytes: bytes.length, sha256: sha256Hex(bytes), mode, originalClass: classification.originalClass }));
}

function assertStagedMapExact(licenseMap: Map<string, LicenseMapEntry>, members: readonly StagedMember[]): void {
  const paths = members.map((member) => member.path).sort(samePathOrder);
  const mapped = [...licenseMap.keys()].sort(samePathOrder);
  if (paths.length !== mapped.length || paths.some((member, index) => member !== mapped[index])) releaseError("UNCLASSIFIED_MEMBER", "License map must classify exactly the staged package members.");
  for (const member of members) {
    const mappedMember = licenseMap.get(member.path)!;
    if (mappedMember.originalClass !== member.originalClass) releaseError("UNCLASSIFIED_MEMBER", "Staged member classification disagrees with the license map.");
  }
}

function assertStagedPolicyExact(plannedPaths: readonly string[], members: readonly StagedMember[]): void {
  const stagedPaths = members.map((member) => member.path).sort(samePathOrder);
  if (plannedPaths.length !== stagedPaths.length || plannedPaths.some((member, index) => member !== stagedPaths[index])) releaseError("STAGED_LAYOUT_DRIFT", "Staged package members must exactly match release payload policy.");
}

function assertStagedImports(packageRoot: string, members: readonly StagedMember[]): void {
  const memberPaths = new Set(members.map((member) => member.path));
  for (const member of members.filter((candidate) => candidate.path.endsWith(".js"))) {
    const source = utf8(fs.readFileSync(path.join(packageRoot, member.path)), "Staged source");
    for (const specifier of moduleSpecifiers(source)) {
      if (member.path === "beta/src/kernel-port.js" && specifier === STAGED_KERNEL_SPECIFIER.replace(/\.ts$/, ".js")) continue;
      const resolved = resolveRelativeModule(member.path, specifier.replace(/\.js$/, ".ts"), "STAGED_IMPORT_ESCAPE").replace(/\.ts$/, ".js");
      const expectedPrefix = member.path.startsWith("beta/src/") ? "beta/src/" : "core/src/";
      if (!resolved.startsWith(expectedPrefix) || !memberPaths.has(resolved)) releaseError("STAGED_IMPORT_ESCAPE", "Staged relative import leaves its runtime boundary.");
    }
  }
  const bin = utf8(fs.readFileSync(path.join(packageRoot, "bin/trajecta-beta")), "Staged bin");
  if (bin !== "#!/usr/bin/env node\nimport { runCli } from \"../beta/src/cli.js\";\nprocess.exitCode = await runCli(process.argv.slice(2), process.cwd(), { stdout: bytes => { process.stdout.write(bytes); }, stderr: text => { process.stderr.write(text); } });\n") releaseError("INVALID_STAGED_BIN", "Staged binary must explicitly invoke the generated beta CLI entry.");
}

export function stagePackage(options: StagePackageOptions): StagedPackage {
  const index = indexSnapshot(options.snapshot);
  for (const required of SNAPSHOT_REQUIRED) if (!index.entries.has(required)) releaseError("SNAPSHOT_INPUT_MISSING", "Snapshot lacks a required package-staging input.");
  const releaseKind = resolveReleaseKind(options.releaseKind);
  const termsSource = releaseKind === "commercial-candidate" ? "release/commercial-candidate/LICENSES/BETA-COMMERCIAL-TERMS.txt" : "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt";
  const boundarySource = releaseKind === "commercial-candidate" ? "release/commercial-candidate/DEVELOPMENT-BOUNDARY.md" : "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md";
  if (!index.entries.has(termsSource) || !index.entries.has(boundarySource)) releaseError("SNAPSHOT_INPUT_MISSING", "Snapshot lacks the selected release terms or boundary.");
  const template = readSnapshot(index, "release/trajecta-beta.package.json");
  parsePackageTemplate(template);
  const plannedPaths = parseStagedPolicyPaths(readSnapshot(index, "release/payload-policy.json"));
  const licenseMap = parseLicenseMap(readSnapshot(index, "release/license-map.json"));
  const stageDirectory = assertNewStageDirectory(options.stageDirectory, index.root);
  const packageRoot = path.join(stageDirectory, "package");
  const members: StagedMember[] = [];
  try {
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o755 });
    writeMember(packageRoot, "package.json", template, "0644", licenseMap, members);
    writeMember(packageRoot, "bin/trajecta-beta", Buffer.from("#!/usr/bin/env node\nimport { runCli } from \"../beta/src/cli.js\";\nprocess.exitCode = await runCli(process.argv.slice(2), process.cwd(), { stdout: bytes => { process.stdout.write(bytes); }, stderr: text => { process.stderr.write(text); } });\n", "utf8"), "0755", licenseMap, members);
    writeMember(packageRoot, "beta/DEVELOPMENT-BOUNDARY.md", readSnapshot(index, boundarySource), "0644", licenseMap, members);
    for (const sourcePath of collectBetaSources(index)) {
      const destination = `beta/src/${sourcePath.slice(BETA_SOURCE_PREFIX.length).replace(/\.ts$/, ".js")}`;
      const original = readSnapshot(index, sourcePath);
      let bytes = original;
      if (sourcePath.endsWith("/kernel-port.ts")) {
        const source = utf8(original, "Kernel port");
        const occurrences = source.split(KERNEL_SPECIFIER).length - 1;
        if (occurrences !== 1) releaseError("KERNEL_PORT_DRIFT", "Kernel port must contain exactly one approved core module specifier.");
        bytes = Buffer.from(source.replace(KERNEL_SPECIFIER, STAGED_KERNEL_SPECIFIER), "utf8");
      }
      writeMember(packageRoot, destination, compileRuntimeSource(bytes, "Beta source"), "0644", licenseMap, members);
    }
    for (const sourcePath of collectCoreSources(index)) writeMember(packageRoot, `core/src/${sourcePath.slice(CORE_SOURCE_PREFIX.length).replace(/\.ts$/, ".js")}`, compileRuntimeSource(readSnapshot(index, sourcePath), "Core source"), "0644", licenseMap, members);
    writeMember(packageRoot, "LICENSE", readSnapshot(index, "LICENSE"), "0644", licenseMap, members);
    writeMember(packageRoot, "NOTICE", readSnapshot(index, "NOTICE"), "0644", licenseMap, members);
    writeMember(packageRoot, "BETA-COMMERCIAL-TERMS.txt", readSnapshot(index, termsSource), "0644", licenseMap, members);
    const modificationEntries = [...licenseMap.values()];
    writeMember(packageRoot, "LICENSES/CORE-MODIFICATIONS.txt", renderCoreModificationsFromEntries(modificationEntries), "0644", licenseMap, members);
    members.sort((left, right) => samePathOrder(left.path, right.path));
    assertStagedMapExact(licenseMap, members);
    assertStagedPolicyExact(plannedPaths, members);
    assertStagedImports(packageRoot, members);
    const modifiedApacheMembers = [...licenseMap.values()].filter((entry) => entry.originalClass === "apache-core" && entry.modified).map((entry) => entry.path).sort(samePathOrder);
    return Object.freeze({ stageDirectory, packageRoot, members: Object.freeze([...members]), modifiedApacheMembers: Object.freeze(modifiedApacheMembers) });
  } catch (error) {
    fs.rmSync(stageDirectory, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
}
