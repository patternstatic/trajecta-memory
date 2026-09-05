import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { WriterLockV1 } from "./contracts.ts";
import { O_NOFOLLOW_ANY, assertPrivateDirectory, ensurePrivateDirectory, readOptionalPrivateBytes, syncPrivateDirectory, writeBytesExclusive } from "./durable-file.ts";
import { BetaError, betaError } from "./errors.ts";
import { parseStrictJsonBytes } from "./strict-json.ts";
import { sha256 } from "./workspace.ts";

const O_EXLOCK = 0x20;
const MAX_EPOCH_BYTES = 1024 * 1024;
// Only this module can issue a live lease. The nominal type discourages accidental
// construction; the private WeakMap enforces it even across casts or plain JS.
declare const leaseBrand: unique symbol;
export interface WriterLease { readonly [leaseBrand]: true }
interface HeldWriter { stateRoot: string; operationId: string; descriptor: number; bytes: Buffer }
const held = new WeakMap<object, HeldWriter>();

export interface WriterLockOptions { stateRoot: string; operationId: string; clock?: () => Date }
function doubt(message: string): never { throw betaError("OPERATION_IN_DOUBT", message); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function operationId(value: unknown): value is string { return bounded(value, 240) && /^operation:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }
function validOwner(value: unknown): value is WriterLockV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as WriterLockV1;
  return Object.keys(v).sort().join() === "acquiredAt,hostname,operationId,pid,processStartToken,schema"
    && v.schema === "trajecta.writer-lock/v1" && operationId(v.operationId) && Number.isSafeInteger(v.pid) && v.pid > 0
    && bounded(v.hostname, 255) && bounded(v.processStartToken, 128) && bounded(v.acquiredAt, 64)
    && !Number.isNaN(Date.parse(v.acquiredAt)) && new Date(v.acquiredAt).toISOString() === v.acquiredAt;
}

/** Fixed executable/argv; failed inspection is never interpreted as a dead PID. */
function processToken(pid: number): string | null {
  try {
    const token = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!bounded(token, 128)) doubt("Process identity could not be verified.");
    return token;
  } catch (error) {
    if (error instanceof BetaError) throw error;
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    if (failed.status === 1 && String(failed.stdout ?? "").trim() === "" && String(failed.stderr ?? "").trim() === "") {
      try { process.kill(pid, 0); } catch (probe) {
        if ((probe as { code?: string }).code === "ESRCH") return null;
      }
    }
    doubt("Process identity could not be verified.");
  }
}

function lockFile(root: string) { return path.join(root, "locks/writer.lock"); }
function assertBound(root: string, fd: number): void {
  try {
    assertPrivateDirectory(root); assertPrivateDirectory(path.join(root, "locks"));
    const opened = fstatSync(fd), named = lstatSync(lockFile(root));
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || !named.isFile() || named.isSymbolicLink() || (named.mode & 0o777) !== 0o600 || opened.dev !== named.dev || opened.ino !== named.ino) doubt("The persistent writer lock changed identity or permissions.");
  } catch (error) {
    if (error instanceof BetaError) throw error;
    doubt("The persistent writer lock is no longer available at its bound path.");
  }
}

function acquire(root: string): number {
  ensurePrivateDirectory(root); ensurePrivateDirectory(path.join(root, "locks"));
  let fd = -1;
  try {
    try { fd = openSync(lockFile(root), constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK | O_NOFOLLOW_ANY); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      const before = lstatSync(path.join(root, "locks"));
      // macOS rejects O_NOFOLLOW_ANY with O_CREAT. Same first-create boundary as TargetRegistry.
      fd = openSync(lockFile(root), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_EXLOCK, 0o600);
      assertBound(root, fd);
      const after = lstatSync(path.join(root, "locks"));
      if (before.dev !== after.dev || before.ino !== after.ino) doubt("Writer lock parent changed during creation.");
      fsyncSync(fd); syncPrivateDirectory(path.join(root, "locks"));
    }
    assertBound(root, fd);
    return fd;
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    if (error instanceof BetaError) throw error;
    doubt("Unable to acquire the persistent writer lock.");
  }
}

function readEpochs(fd: number): Buffer {
  const before = fstatSync(fd);
  if (before.size < 0 || before.size > MAX_EPOCH_BYTES) doubt("Writer epoch journal exceeds its inspection bound.");
  const bytes = Buffer.alloc(before.size);
  for (let offset = 0; offset < bytes.length;) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) doubt("Writer epoch journal is torn.");
    offset += count;
  }
  const after = fstatSync(fd);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) doubt("Writer epoch journal changed during read.");
  return bytes;
}

function unmatchedOwner(bytes: Buffer): { owner: WriterLockV1; bytes: Buffer } | null {
  if (!bytes.length) return null;
  if (bytes.at(-1) !== 10) doubt("Writer epoch journal is torn.");
  let current: { owner: WriterLockV1; bytes: Buffer } | null = null;
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10) continue;
    const line = bytes.subarray(start, index + 1); start = index + 1;
    let event: any;
    try { event = parseStrictJsonBytes(line); } catch { doubt("Writer epoch is unreadable."); }
    if (event?.event === "acquired" && Object.keys(event).sort().join() === "event,owner" && validOwner(event.owner) && current === null) current = { owner: event.owner, bytes: line };
    else if ((event?.event === "released" || event?.event === "recovered") && Object.keys(event).sort().join() === "event,ownerDigest" && current && event.ownerDigest === sha256(current.bytes)) current = null;
    else doubt("Writer epoch history is unverifiable.");
  }
  return current;
}

/**
 * Read-only doctor probe for the permanent writer inode. It deliberately never
 * runs recovery or appends an epoch: any live, unmatched, malformed, or
 * unbound evidence needs explicit inspection rather than a diagnostic repair.
 */
export function inspectWriterLock(stateRoot: string): { state: "absent" | "released" } {
  if (process.platform !== "darwin") doubt("Writer lock inspection requires supported macOS kernel flags.");
  const root = path.resolve(stateRoot);
  try {
    try { lstatSync(root); } catch (error) {
      if (missing(error)) return { state: "absent" };
      throw error;
    }
    assertPrivateDirectory(root);
    const locks = path.join(root, "locks");
    try { lstatSync(locks); } catch (error) {
      if (missing(error)) return { state: "absent" };
      throw error;
    }
    assertPrivateDirectory(locks);
    try { lstatSync(lockFile(root)); } catch (error) {
      if (missing(error)) return { state: "absent" };
      throw error;
    }
    let descriptor = -1;
    try {
      descriptor = openSync(lockFile(root), constants.O_RDONLY | constants.O_NONBLOCK | O_EXLOCK | O_NOFOLLOW_ANY);
      assertBound(root, descriptor);
      const bytes = readEpochs(descriptor);
      if (unmatchedOwner(bytes) !== null) doubt("Persistent writer ownership requires inspection.");
      assertBound(root, descriptor);
      return { state: "released" };
    } finally {
      if (descriptor >= 0) closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof BetaError) throw error;
    doubt("Unable to verify the persistent writer lock without mutation.");
  }
}

function append(root: string, fd: number, prior: Buffer, line: Buffer): Buffer {
  assertBound(root, fd);
  if (!readEpochs(fd).equals(prior)) doubt("Writer epoch bytes changed while held.");
  if (prior.length + line.length > MAX_EPOCH_BYTES) doubt("Writer epoch journal requires inspection before further writes.");
  for (let offset = 0; offset < line.length;) {
    const count = writeSync(fd, line, offset, line.length - offset, prior.length + offset);
    if (count <= 0) doubt("Writer epoch append made no progress.");
    offset += count;
  }
  fsyncSync(fd); assertBound(root, fd);
  return Buffer.concat([prior, line]);
}

export function assertWriterLease(lease: WriterLease, stateRoot: string, id: string): void {
  const owner = lease && typeof lease === "object" ? held.get(lease) : undefined;
  if (!owner || owner.stateRoot !== path.resolve(stateRoot) || owner.operationId !== id) doubt("A live writer lease for this exact operation and state root is required.");
  assertBound(owner.stateRoot, owner.descriptor);
  if (!readEpochs(owner.descriptor).equals(owner.bytes)) doubt("Writer owner bytes changed while held.");
}

/**
 * The kernel lock is authority; owner epochs are evidence. Never unlink or rename
 * writer.lock: append acquire/release events on its permanent inode. A proven-dead
 * unmatched acquire event is copied byte-for-byte into quarantine before recovery.
 * Await all work inside action: its opaque lease expires as the callback settles.
 */
export async function withWriterLock<T>(options: WriterLockOptions, action: (lease: WriterLease) => T | Promise<T>): Promise<T> {
  if (process.platform !== "darwin") throw betaError("CAPABILITY_UNAVAILABLE", "Writer locking requires supported macOS kernel flags.");
  if (!operationId(options.operationId)) throw betaError("OPERATION_CONFLICT", "A bounded operation ID is required.");
  const root = path.resolve(options.stateRoot), fd = acquire(root);
  const lease = Object.freeze({}) as WriterLease;
  let ownerBytes: Buffer | undefined;
  try {
    let bytes = readEpochs(fd);
    const prior = unmatchedOwner(bytes);
    if (prior) {
      if (prior.owner.hostname !== hostname()) doubt("Unmatched writer belongs to another host.");
      const token = processToken(prior.owner.pid);
      if (token === prior.owner.processStartToken) doubt("Unmatched writer still identifies a live process.");
      const directory = path.join(root, "locks/quarantine"); ensurePrivateDirectory(directory);
      const audit = path.join(directory, `${sha256(prior.bytes)}.json`);
      const existing = readOptionalPrivateBytes(audit);
      if (existing && !existing.equals(prior.bytes)) doubt("Writer quarantine audit conflicts with its owner epoch.");
      if (!existing) writeBytesExclusive(audit, prior.bytes);
      bytes = append(root, fd, bytes, Buffer.from(`${canonicalJson({ event: "recovered", ownerDigest: sha256(prior.bytes) })}\n`));
    }
    const token = processToken(process.pid);
    const owner: WriterLockV1 = { schema: "trajecta.writer-lock/v1", operationId: options.operationId, pid: process.pid, hostname: hostname(), processStartToken: token!, acquiredAt: (options.clock?.() ?? new Date()).toISOString() };
    if (!validOwner(owner)) doubt("Current process identity is unverifiable.");
    ownerBytes = Buffer.from(`${canonicalJson({ event: "acquired", owner })}\n`);
    bytes = append(root, fd, bytes, ownerBytes);
    held.set(lease, { stateRoot: root, operationId: options.operationId, descriptor: fd, bytes });
    return await action(lease);
  } finally {
    const owner = held.get(lease); held.delete(lease);
    try {
      if (owner && ownerBytes) append(root, fd, owner.bytes, Buffer.from(`${canonicalJson({ event: "released", ownerDigest: sha256(ownerBytes) })}\n`));
    } finally { closeSync(fd); }
  }
}
