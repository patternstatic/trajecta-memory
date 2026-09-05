import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BetaError, betaError } from "./errors.ts";
import { parseStrictJsonBytes } from "./strict-json.ts";

export const O_NOFOLLOW_ANY = 0x20000000;

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function pathParts(directory: string): string[] {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  return resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
}

function assertPrivatePath(directory: string): void {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of pathParts(resolved)) {
    current = path.join(current, part);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw betaError("OPERATION_IN_DOUBT", "Unable to inspect a private state directory.");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw betaError("OPERATION_IN_DOUBT", "Private state directories must not be symbolic links.");
    }
  }
}

function assertMode(mode: number, expected: number, label: string): void {
  if ((mode & 0o777) !== expected) {
    throw betaError("OPERATION_IN_DOUBT", `${label} has insecure permissions.`);
  }
}

export function assertPrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  assertPrivatePath(resolved);
  let entry;
  try {
    entry = lstatSync(resolved);
  } catch (error) {
    if (isMissing(error)) throw betaError("OPERATION_IN_DOUBT", "A required private state directory is missing.");
    throw betaError("OPERATION_IN_DOUBT", "Unable to inspect a private state directory.");
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw betaError("OPERATION_IN_DOUBT", "Private state directories must not be symbolic links.");
  }
  assertMode(entry.mode, 0o700, "Private state directory");
}

function assertRegularFile(file: string): void {
  assertPrivatePath(path.dirname(file));
  let entry;
  try {
    entry = lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw betaError("OPERATION_IN_DOUBT", "Unable to inspect a private state file.");
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw betaError("OPERATION_IN_DOUBT", "Private state files must be regular files.");
  }
  assertMode(entry.mode, 0o600, "Private state file");
}

export function syncPrivateDirectory(directory: string): void {
  let descriptor = -1;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Error && error.name === "BetaError") throw error;
    throw betaError("OPERATION_IN_DOUBT", "Unable to durably synchronize the private state directory.");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw betaError("OPERATION_IN_DOUBT", "Private state write made no progress.");
    offset += written;
  }
}

function writeExclusive(file: string, bytes: Uint8Array): void {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  assertRegularFile(file);
  let descriptor = -1;
  try {
    descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Error && error.name === "BetaError") throw error;
    throw betaError("OPERATION_IN_DOUBT", "Unable to exclusively write private state.");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
  syncPrivateDirectory(directory);
}

export function ensurePrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  assertPrivatePath(resolved);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  try {
    for (const part of pathParts(resolved)) {
      current = path.join(current, part);
      try {
        const entry = lstatSync(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw betaError("OPERATION_IN_DOUBT", "Private state directories must not be symbolic links.");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        mkdirSync(current, { mode: 0o700 });
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "BetaError") throw error;
    throw betaError("OPERATION_IN_DOUBT", "Unable to create the private state directory.");
  }
  assertPrivateDirectory(resolved);
}

export function writeBytesExclusive(file: string, bytes: Uint8Array): void {
  writeExclusive(file, bytes);
}

export function writeJsonExclusive(file: string, value: unknown): void {
  writeExclusive(file, Buffer.from(JSON.stringify(value), "utf8"));
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  assertRegularFile(file);
  try {
    writeExclusive(temporary, Buffer.from(JSON.stringify(value), "utf8"));
    renameSync(temporary, file);
    syncPrivateDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) {
        throw betaError("OPERATION_IN_DOUBT", "Unable to clean up a private state replacement.");
      }
    }
    if (error instanceof Error && error.name === "BetaError") throw error;
    throw betaError("OPERATION_IN_DOUBT", "Unable to atomically replace private state.");
  }
}

export function readJsonFile(file: string): unknown {
  const { bytes } = readPrivateBytes(file);
  try {
    return parseStrictJsonBytes(bytes);
  } catch {
    throw betaError("OPERATION_IN_DOUBT", "Private state JSON is malformed or unavailable.");
  }
}

export function readPrivateBytes(file: string): { bytes: Buffer; dev: number; ino: number } {
  assertRegularFile(file);
  let descriptor = -1;
  try {
    // On macOS O_NOFOLLOW_ANY already includes the final component, and combining
    // it with O_NOFOLLOW returns EINVAL even for a regular existing file.
    descriptor = openSync(file, constants.O_RDONLY | O_NOFOLLOW_ANY);
    const initial = fstatSync(descriptor);
    assertMode(initial.mode, 0o600, "Private state file");
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 0 || initial.size > 64 * 1024) {
      throw betaError("OPERATION_IN_DOUBT", "Private state file is not a supported regular file.");
    }
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read <= 0) throw betaError("OPERATION_IN_DOUBT", "Private state file ended during read.");
      offset += read;
    }
    const final = fstatSync(descriptor);
    if (final.size !== initial.size || final.dev !== initial.dev || final.ino !== initial.ino || final.mode !== initial.mode || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) {
      throw betaError("OPERATION_IN_DOUBT", "Private state file changed during read.");
    }
    return { bytes, dev: final.dev, ino: final.ino };
  } catch (error) {
    if (error instanceof BetaError && error.code === "OPERATION_IN_DOUBT") throw error;
    throw betaError("OPERATION_IN_DOUBT", "Private state bytes are malformed or unavailable.");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

/** Absence is distinct from unreadable, insecure, symlinked, or malformed state. */
export function readOptionalPrivateBytes(file: string): Buffer | null {
  assertPrivatePath(path.dirname(file));
  try {
    lstatSync(path.dirname(file));
  } catch (error) {
    if (isMissing(error)) return null;
    throw betaError("OPERATION_IN_DOUBT", "Unable to inspect private state.");
  }
  assertPrivateDirectory(path.dirname(file));
  try { lstatSync(file); } catch (error) {
    if (isMissing(error)) return null;
    throw betaError("OPERATION_IN_DOUBT", "Unable to inspect private state.");
  }
  return readPrivateBytes(file).bytes;
}
