import { randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import type { LocalWorkspaceTargetCardV1 } from "./contracts.ts";
import { O_NOFOLLOW_ANY, assertPrivateDirectory, ensurePrivateDirectory, syncPrivateDirectory } from "./durable-file.ts";
import { BetaError, betaError } from "./errors.ts";
import { parseStrictJsonBytes } from "./strict-json.ts";
import { sha256, type WorkspaceObservation } from "./workspace.ts";

type TargetState = "issued" | "reserved" | "consumed";

interface TargetRecordV1 {
  schema: "trajecta.local-target-record/v1";
  targetId: string;
  capabilityHash: string;
  registryFingerprint: string;
  workspace: LocalWorkspaceTargetCardV1["workspace"];
  createdAt: string;
  expiresAt: string;
  state: TargetState;
  operationId: string | null;
  attemptDigest: string | null;
  receiptId: string | null;
}

export interface TargetRegistryOptions {
  stateRoot: string;
  clock?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  onTargetLockAcquired?: (transition: "reserve" | "consume", targetId: string) => void;
  onBeforeTargetOpen?: (kind: "lock" | "journal", file: string) => void;
  onTargetDescriptorsAcquired?: (targetId: string) => void;
  onAfterJournalAppend?: (targetId: string) => void;
}

const SHA256 = /^[a-f0-9]{64}$/;
const O_EXLOCK = 0x20;
const LOCK_ATTEMPTS = 80;
const LOCK_WAIT_MS = 5;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function inDoubt(message: string): never {
  throw betaError("OPERATION_IN_DOUBT", message);
}

function lockBusy(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK");
}

function opaqueId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && value.length > prefix.length && value.length <= 240
    && new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9._-]*$`).test(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function timestamp(value: unknown): value is string {
  return boundedText(value, 64) && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function sameHash(left: string, right: string): boolean {
  return SHA256.test(left) && SHA256.test(right) && timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactWorkspace(left: LocalWorkspaceTargetCardV1["workspace"], right: LocalWorkspaceTargetCardV1["workspace"]): boolean {
  return left.repository === right.repository
    && left.repositoryFingerprint === right.repositoryFingerprint
    && left.stateRootFingerprint === right.stateRootFingerprint
    && left.branch === right.branch;
}

function targetIdFromRandom(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw betaError("CAPABILITY_UNAVAILABLE", "The configured random source did not return UUID bytes.");
  const value = Buffer.from(bytes);
  value[6] = (value[6]! & 0x0f) | 0x40;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `target:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validRecord(value: unknown): value is TargetRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["schema", "targetId", "capabilityHash", "registryFingerprint", "workspace", "createdAt", "expiresAt", "state", "operationId", "attemptDigest", "receiptId"];
  if (!exactKeys(record, keys)) return false;
  if (record.schema !== "trajecta.local-target-record/v1" || !opaqueId(record.targetId, "target:") || typeof record.capabilityHash !== "string" || !SHA256.test(record.capabilityHash) || typeof record.registryFingerprint !== "string" || !SHA256.test(record.registryFingerprint) || !timestamp(record.createdAt) || !timestamp(record.expiresAt)) return false;
  const workspace = record.workspace as Record<string, unknown>;
  if (Date.parse(record.createdAt) >= Date.parse(record.expiresAt)) return false;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace) || !exactKeys(workspace, ["repository", "repositoryFingerprint", "stateRootFingerprint", "branch"])
    || !boundedText(workspace.repository, 240)
    || typeof workspace.repositoryFingerprint !== "string" || !SHA256.test(workspace.repositoryFingerprint)
    || typeof workspace.stateRootFingerprint !== "string" || !SHA256.test(workspace.stateRootFingerprint)
    || !boundedText(workspace.branch, 240)) return false;
  if (record.state === "issued") return record.operationId === null && record.attemptDigest === null && record.receiptId === null;
  if (record.state === "reserved") return opaqueId(record.operationId, "operation:") && typeof record.attemptDigest === "string" && SHA256.test(record.attemptDigest) && record.receiptId === null;
  if (record.state === "consumed") return opaqueId(record.operationId, "operation:") && typeof record.attemptDigest === "string" && SHA256.test(record.attemptDigest) && opaqueId(record.receiptId, "receipt:");
  return false;
}

function sameIdentity(left: TargetRecordV1, right: TargetRecordV1): boolean {
  return left.targetId === right.targetId && left.capabilityHash === right.capabilityHash
    && left.registryFingerprint === right.registryFingerprint && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt && exactWorkspace(left.workspace, right.workspace);
}

function validateJournal(records: TargetRecordV1[]): TargetRecordV1 {
  if (records.length < 1 || records.length > 3 || !validRecord(records[0]) || records[0].state !== "issued") inDoubt("Target journal does not begin with one issued state.");
  const issued = records[0];
  if (records.length === 1) return issued;
  const reserved = records[1];
  if (!validRecord(reserved) || !sameIdentity(issued, reserved) || reserved.state !== "reserved") inDoubt("Target journal has an illegal reservation transition.");
  if (records.length === 2) return reserved;
  const consumed = records[2];
  if (!validRecord(consumed) || !sameIdentity(reserved, consumed) || consumed.state !== "consumed" || consumed.operationId !== reserved.operationId || consumed.attemptDigest !== reserved.attemptDigest) inDoubt("Target journal has an illegal consumption transition.");
  return consumed;
}

function writeAllAt(descriptor: number, bytes: Uint8Array, position: number): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, position + offset);
    if (count <= 0) inDoubt("Target journal write made no progress.");
    offset += count;
  }
}

export class TargetRegistry {
  private readonly stateRoot: string;
  private readonly clock: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly stateRootFingerprint: string;
  private readonly registryFingerprint: string;
  private readonly onTargetLockAcquired: ((transition: "reserve" | "consume", targetId: string) => void) | undefined;
  private readonly onBeforeTargetOpen: ((kind: "lock" | "journal", file: string) => void) | undefined;
  private readonly onTargetDescriptorsAcquired: ((targetId: string) => void) | undefined;
  private readonly onAfterJournalAppend: ((targetId: string) => void) | undefined;

  constructor(options: TargetRegistryOptions) {
    if (process.platform !== "darwin") throw betaError("CAPABILITY_UNAVAILABLE", "Target journaling requires supported macOS kernel flags.");
    this.stateRoot = path.resolve(options.stateRoot);
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? systemRandomBytes;
    this.stateRootFingerprint = sha256(this.stateRoot);
    this.registryFingerprint = sha256(`trajecta.local-registry/v1\0${this.stateRootFingerprint}`);
    this.onTargetLockAcquired = options.onTargetLockAcquired;
    this.onBeforeTargetOpen = options.onBeforeTargetOpen;
    this.onTargetDescriptorsAcquired = options.onTargetDescriptorsAcquired;
    this.onAfterJournalAppend = options.onAfterJournalAppend;
  }

  issue(observation: WorkspaceObservation, now = this.clock()): LocalWorkspaceTargetCardV1 {
    if (observation.stateRoot !== this.stateRoot || observation.stateRootFingerprint !== this.stateRootFingerprint) throw betaError("WORKSPACE_MISMATCH", "The target registry is configured for a different state root.");
    const createdAt = checkedTime(now);
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const targetId = targetIdFromRandom(this.randomBytes(16));
    const randomCapability = this.randomBytes(32);
    if (randomCapability.byteLength !== 32) throw betaError("CAPABILITY_UNAVAILABLE", "The configured random source did not return capability bytes.");
    const capability = `capability:${Buffer.from(randomCapability).toString("base64url")}`;
    const card: LocalWorkspaceTargetCardV1 = {
      schema: "trajecta.local-target/v1", targetId, capability, createdAt, expiresAt, registryFingerprint: this.registryFingerprint,
      workspace: { repository: observation.repository, repositoryFingerprint: observation.repositoryFingerprint, stateRootFingerprint: observation.stateRootFingerprint, branch: observation.branch },
    };
    const issued: TargetRecordV1 = {
      schema: "trajecta.local-target-record/v1", targetId, capabilityHash: sha256(capability), registryFingerprint: this.registryFingerprint,
      workspace: structuredClone(card.workspace), createdAt, expiresAt, state: "issued", operationId: null, attemptDigest: null, receiptId: null,
    };
    this.ensureRegistryDirectories();
    const lock = this.createTargetFile(this.lockFile(targetId));
    let journal = -1;
    try {
      journal = this.createTargetFile(this.journalFile(targetId));
      writeAllAt(journal, Buffer.from(`${JSON.stringify(issued)}\n`, "utf8"), 0);
      fsyncSync(journal);
      syncPrivateDirectory(this.targetsDirectory());
    } finally {
      if (journal >= 0) closeSync(journal);
      closeSync(lock);
    }
    return card;
  }

  lookup(card: LocalWorkspaceTargetCardV1, now = this.clock()): void {
    this.withLockedRecord(card, undefined, (record) => {
      this.requireFresh(record, now);
      if (record.state !== "issued") throw betaError("TARGET_CONSUMED", "The local target has already been reserved or consumed.");
    });
  }

  reserve(card: LocalWorkspaceTargetCardV1, operationId: string, attemptDigest: string, now = this.clock()): void {
    if (!opaqueId(operationId, "operation:") || !SHA256.test(attemptDigest)) throw betaError("OPERATION_CONFLICT", "Operation ID and attempt digest are invalid.");
    this.withLockedRecord(card, "reserve", (record, journal) => {
      if (record.state === "reserved") {
        if (record.operationId === operationId && record.attemptDigest === attemptDigest) return;
        if (record.operationId === operationId) throw betaError("OPERATION_CONFLICT", "A different attempt is already reserved for this operation.");
        throw betaError("TARGET_CONSUMED", "The local target is reserved by another operation.");
      }
      if (record.state === "consumed") throw betaError("TARGET_CONSUMED", "The local target has already been consumed.");
      this.requireFresh(record, now);
      this.appendTransition(card.targetId, journal, { ...record, state: "reserved", operationId, attemptDigest });
    });
  }

  consume(card: LocalWorkspaceTargetCardV1, operationId: string, receiptId: string): void {
    if (!opaqueId(operationId, "operation:") || !opaqueId(receiptId, "receipt:")) throw betaError("OPERATION_CONFLICT", "Operation ID and receipt ID are invalid.");
    this.withLockedRecord(card, "consume", (record, journal) => {
      if (record.state === "consumed") {
        if (record.operationId === operationId && record.receiptId === receiptId) return;
        if (record.operationId === operationId) throw betaError("OPERATION_CONFLICT", "A different receipt is already recorded for this operation.");
        throw betaError("TARGET_CONSUMED", "The local target has already been consumed.");
      }
      if (record.state !== "reserved" || record.operationId !== operationId) throw betaError("TARGET_CONSUMED", "The local target is not reserved by this operation.");
      this.appendTransition(card.targetId, journal, { ...record, state: "consumed", receiptId });
    });
  }

  private targetsDirectory(): string { return path.join(this.stateRoot, "targets"); }
  private journalFile(targetId: string): string { return path.join(this.targetsDirectory(), `${sha256(targetId)}.journal`); }
  private lockFile(targetId: string): string { return path.join(this.targetsDirectory(), `${sha256(targetId)}.lock`); }

  private ensureRegistryDirectories(): void {
    ensurePrivateDirectory(this.stateRoot);
    ensurePrivateDirectory(this.targetsDirectory());
  }

  private assertRegistryDirectories(): void {
    assertPrivateDirectory(this.stateRoot);
    assertPrivateDirectory(this.targetsDirectory());
  }

  private withLockedRecord(card: LocalWorkspaceTargetCardV1, transition: "reserve" | "consume" | undefined, action: (record: TargetRecordV1, journal: number) => void): void {
    this.assertCard(card);
    this.assertRegistryDirectories();
    const lock = this.openLock(card.targetId);
    let journal = -1;
    try {
      if (transition) this.onTargetLockAcquired?.(transition, card.targetId);
      journal = this.openJournal(card.targetId);
      this.onTargetDescriptorsAcquired?.(card.targetId);
      this.assertBoundTargetDescriptor(lock, this.lockFile(card.targetId), "Target lock");
      this.assertBoundTargetDescriptor(journal, this.journalFile(card.targetId), "Target journal");
      action(this.readVerified(card, journal), journal);
      this.assertBoundTargetDescriptor(lock, this.lockFile(card.targetId), "Target lock");
      this.assertBoundTargetDescriptor(journal, this.journalFile(card.targetId), "Target journal");
    } finally {
      if (journal >= 0) closeSync(journal);
      closeSync(lock);
    }
  }

  private openLock(targetId: string): number {
    const file = this.lockFile(targetId);
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      this.onBeforeTargetOpen?.("lock", file);
      try {
        const descriptor = openSync(file, constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK | O_NOFOLLOW_ANY);
        this.assertOpenPrivateFile(descriptor, "Target lock");
        return descriptor;
      } catch (error) {
        if (lockBusy(error) && attempt + 1 < LOCK_ATTEMPTS) {
          Atomics.wait(waitCell, 0, 0, LOCK_WAIT_MS);
          continue;
        }
        if (error instanceof BetaError) throw error;
        inDoubt("Unable to acquire the persistent target lock.");
      }
    }
    inDoubt("Timed out acquiring the persistent target lock.");
  }

  private openJournal(targetId: string): number {
    const file = this.journalFile(targetId);
    this.onBeforeTargetOpen?.("journal", file);
    try {
      const descriptor = openSync(file, constants.O_RDWR | O_EXLOCK | O_NOFOLLOW_ANY);
      this.assertOpenPrivateFile(descriptor, "Target journal");
      return descriptor;
    } catch (error) {
      if (error instanceof BetaError) throw error;
      inDoubt("Unable to open the target journal.");
    }
  }

  private createTargetFile(file: string): number {
    const parent = path.dirname(file);
    this.assertRegistryDirectories();
    const parentBefore = lstatSync(parent);
    let descriptor = -1;
    try {
      descriptor = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | O_EXLOCK, 0o600);
      this.assertOpenPrivateFile(descriptor, "New target file");
      const opened = fstatSync(descriptor);
      const named = lstatSync(file);
      this.assertRegistryDirectories();
      const parentAfter = lstatSync(parent);
      if (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
        inDoubt("Target creation path changed before durable validation.");
      }
      fsyncSync(descriptor);
      syncPrivateDirectory(parent);
      return descriptor;
    } catch (error) {
      if (descriptor >= 0) closeSync(descriptor);
      if (error instanceof BetaError) throw error;
      inDoubt("Unable to create the private target file.");
    }
  }

  private assertOpenPrivateFile(descriptor: number, label: string): void {
    const state = fstatSync(descriptor);
    if (!state.isFile() || (state.mode & 0o777) !== 0o600) inDoubt(`${label} is not a private regular file.`);
  }

  private assertBoundTargetDescriptor(descriptor: number, file: string, label: string): void {
    this.assertRegistryDirectories();
    const opened = fstatSync(descriptor);
    this.assertOpenPrivateFile(descriptor, label);
    let named;
    try {
      named = lstatSync(file);
    } catch {
      inDoubt(`${label} disappeared after it was opened.`);
    }
    if (named.isSymbolicLink() || !named.isFile() || (named.mode & 0o777) !== 0o600 || named.dev !== opened.dev || named.ino !== opened.ino) {
      inDoubt(`${label} no longer matches its opened descriptor.`);
    }
  }

  private readVerified(card: LocalWorkspaceTargetCardV1, descriptor: number): TargetRecordV1 {
    const bytes = this.readJournalBytes(descriptor);
    const records: TargetRecordV1[] = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0x0a) continue;
      if (index === start) inDoubt("Target journal contains an empty transition.");
      try {
        records.push(parseStrictJsonBytes(bytes.subarray(start, index)) as TargetRecordV1);
      } catch {
        inDoubt("Target journal contains malformed JSON.");
      }
      start = index + 1;
    }
    if (start !== bytes.length) inDoubt("Target journal is torn or lacks its newline terminator.");
    const record = validateJournal(records);
    if (record.targetId !== card.targetId || record.registryFingerprint !== this.registryFingerprint || card.registryFingerprint !== this.registryFingerprint || !sameHash(record.capabilityHash, sha256(card.capability)) || !exactWorkspace(record.workspace, card.workspace)) throw betaError("TARGET_MISMATCH", "The target card does not match this local workspace.");
    return record;
  }

  private readJournalBytes(descriptor: number): Buffer {
    const initial = fstatSync(descriptor);
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 1 || initial.size > 64 * 1024) inDoubt("Target journal size is invalid.");
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) inDoubt("Target journal ended during read.");
      offset += count;
    }
    const final = fstatSync(descriptor);
    if (final.size !== initial.size || final.dev !== initial.dev || final.ino !== initial.ino) inDoubt("Target journal changed during read.");
    return bytes;
  }

  private appendTransition(targetId: string, descriptor: number, record: TargetRecordV1): void {
    const before = fstatSync(descriptor);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    writeAllAt(descriptor, bytes, before.size);
    fsyncSync(descriptor);
    this.onAfterJournalAppend?.(targetId);
  }

  private assertCard(card: LocalWorkspaceTargetCardV1): void {
    if (!card || card.schema !== "trajecta.local-target/v1" || !opaqueId(card.targetId, "target:") || !opaqueId(card.capability, "capability:") || !card.workspace || card.workspace.stateRootFingerprint !== this.stateRootFingerprint) throw betaError("TARGET_MISMATCH", "The target card does not match this registry.");
  }

  private requireFresh(record: TargetRecordV1, now: Date): void {
    if (!Number.isFinite(now.getTime()) || Date.parse(record.expiresAt) <= now.getTime()) throw betaError("TARGET_EXPIRED", "The local target has expired.");
  }
}

function checkedTime(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw betaError("CAPABILITY_UNAVAILABLE", "The configured clock did not return a valid time.");
  return value.toISOString();
}
