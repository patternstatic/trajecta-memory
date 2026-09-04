import { randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import type { LocalWorkspaceTargetCardV1 } from "./contracts.ts";
import {
  acquirePrivateLock,
  assertPrivateDirectory,
  ensurePrivateDirectory,
  readJsonFile,
  writeJsonAtomic,
  writeJsonExclusive,
} from "./durable-file.ts";
import { betaError } from "./errors.ts";
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
}

const SHA256 = /^[a-f0-9]{64}$/;

function opaqueId(value: string, label: string): void {
  if (!/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.length > 240) {
    throw betaError("OPERATION_CONFLICT", `${label} must be a bounded opaque ID.`);
  }
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
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) return false;
  if (record.schema !== "trajecta.local-target-record/v1" || typeof record.targetId !== "string" || typeof record.capabilityHash !== "string" || !SHA256.test(record.capabilityHash) || typeof record.registryFingerprint !== "string" || !SHA256.test(record.registryFingerprint)) return false;
  if (record.state !== "issued" && record.state !== "reserved" && record.state !== "consumed") return false;
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt)) || typeof record.expiresAt !== "string" || Number.isNaN(Date.parse(record.expiresAt))) return false;
  if (record.operationId !== null && typeof record.operationId !== "string") return false;
  if (record.attemptDigest !== null && (typeof record.attemptDigest !== "string" || !SHA256.test(record.attemptDigest))) return false;
  if (record.receiptId !== null && typeof record.receiptId !== "string") return false;
  const stateFieldsAreConsistent = record.state === "issued"
    ? record.operationId === null && record.attemptDigest === null && record.receiptId === null
    : record.state === "reserved"
      ? typeof record.operationId === "string" && typeof record.attemptDigest === "string" && record.receiptId === null
      : typeof record.operationId === "string" && typeof record.attemptDigest === "string" && typeof record.receiptId === "string";
  const workspace = record.workspace as Record<string, unknown>;
  return stateFieldsAreConsistent && !!workspace && typeof workspace === "object" && !Array.isArray(workspace)
    && typeof workspace.repository === "string"
    && typeof workspace.repositoryFingerprint === "string" && SHA256.test(workspace.repositoryFingerprint)
    && typeof workspace.stateRootFingerprint === "string" && SHA256.test(workspace.stateRootFingerprint)
    && typeof workspace.branch === "string";
}

export class TargetRegistry {
  private readonly stateRoot: string;
  private readonly clock: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly stateRootFingerprint: string;
  private readonly registryFingerprint: string;
  private readonly onTargetLockAcquired: ((transition: "reserve" | "consume", targetId: string) => void) | undefined;

  constructor(options: TargetRegistryOptions) {
    this.stateRoot = path.resolve(options.stateRoot);
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? systemRandomBytes;
    this.stateRootFingerprint = sha256(this.stateRoot);
    this.registryFingerprint = sha256(`trajecta.local-registry/v1\0${this.stateRootFingerprint}`);
    this.onTargetLockAcquired = options.onTargetLockAcquired;
  }

  issue(observation: WorkspaceObservation, now = this.clock()): LocalWorkspaceTargetCardV1 {
    if (observation.stateRoot !== this.stateRoot || observation.stateRootFingerprint !== this.stateRootFingerprint) {
      throw betaError("WORKSPACE_MISMATCH", "The target registry is configured for a different state root.");
    }
    const createdAt = checkedTime(now);
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const targetId = targetIdFromRandom(this.randomBytes(16));
    const randomCapability = this.randomBytes(32);
    if (randomCapability.byteLength !== 32) throw betaError("CAPABILITY_UNAVAILABLE", "The configured random source did not return capability bytes.");
    const capability = `capability:${Buffer.from(randomCapability).toString("base64url")}`;
    const card: LocalWorkspaceTargetCardV1 = {
      schema: "trajecta.local-target/v1",
      targetId,
      capability,
      createdAt,
      expiresAt,
      registryFingerprint: this.registryFingerprint,
      workspace: {
        repository: observation.repository,
        repositoryFingerprint: observation.repositoryFingerprint,
        stateRootFingerprint: observation.stateRootFingerprint,
        branch: observation.branch,
      },
    };
    const record: TargetRecordV1 = {
      schema: "trajecta.local-target-record/v1",
      targetId,
      capabilityHash: sha256(capability),
      registryFingerprint: this.registryFingerprint,
      workspace: structuredClone(card.workspace),
      createdAt,
      expiresAt,
      state: "issued",
      operationId: null,
      attemptDigest: null,
      receiptId: null,
    };
    this.ensureRegistryDirectories();
    writeJsonExclusive(this.recordFile(targetId), record);
    return card;
  }

  lookup(card: LocalWorkspaceTargetCardV1, now = this.clock()): void {
    const record = this.readVerified(card);
    this.requireFresh(record, now);
    if (record.state !== "issued") throw betaError("TARGET_CONSUMED", "The local target has already been reserved or consumed.");
  }

  reserve(card: LocalWorkspaceTargetCardV1, operationId: string, attemptDigest: string, now = this.clock()): void {
    opaqueId(operationId, "Operation ID");
    if (!SHA256.test(attemptDigest)) throw betaError("OPERATION_CONFLICT", "Attempt digest must be a SHA-256 digest.");
    this.withTargetTransition(card, "reserve", (record) => {
      if (record.state === "reserved") {
        if (record.operationId === operationId && record.attemptDigest === attemptDigest) return;
        if (record.operationId === operationId) throw betaError("OPERATION_CONFLICT", "A different attempt is already reserved for this operation.");
        throw betaError("TARGET_CONSUMED", "The local target is reserved by another operation.");
      }
      if (record.state === "consumed") throw betaError("TARGET_CONSUMED", "The local target has already been consumed.");
      this.requireFresh(record, now);
      writeJsonAtomic(this.recordFile(record.targetId), { ...record, state: "reserved", operationId, attemptDigest });
    });
  }

  consume(card: LocalWorkspaceTargetCardV1, operationId: string, receiptId: string): void {
    opaqueId(operationId, "Operation ID");
    opaqueId(receiptId, "Receipt ID");
    this.withTargetTransition(card, "consume", (record) => {
      if (record.state === "consumed") {
        if (record.operationId === operationId && record.receiptId === receiptId) return;
        if (record.operationId === operationId) throw betaError("OPERATION_CONFLICT", "A different receipt is already recorded for this operation.");
        throw betaError("TARGET_CONSUMED", "The local target has already been consumed.");
      }
      if (record.state !== "reserved" || record.operationId !== operationId) {
        throw betaError("TARGET_CONSUMED", "The local target is not reserved by this operation.");
      }
      writeJsonAtomic(this.recordFile(record.targetId), { ...record, state: "consumed", receiptId });
    });
  }

  private targetsDirectory(): string {
    return path.join(this.stateRoot, "targets");
  }

  private recordFile(targetId: string): string {
    return path.join(this.targetsDirectory(), `${sha256(targetId)}.json`);
  }

  private lockFile(targetId: string): string {
    return path.join(this.targetsDirectory(), `${sha256(targetId)}.lock`);
  }

  private ensureRegistryDirectories(): void {
    ensurePrivateDirectory(this.stateRoot);
    ensurePrivateDirectory(this.targetsDirectory());
  }

  private assertRegistryDirectories(): void {
    assertPrivateDirectory(this.stateRoot);
    assertPrivateDirectory(this.targetsDirectory());
  }

  private withTargetTransition(
    card: LocalWorkspaceTargetCardV1,
    transition: "reserve" | "consume",
    action: (record: TargetRecordV1) => void,
  ): void {
    this.assertCard(card);
    this.assertRegistryDirectories();
    const owner = this.randomBytes(32);
    if (owner.byteLength !== 32) throw betaError("CAPABILITY_UNAVAILABLE", "The configured random source did not return lock ownership bytes.");
    const lock = acquirePrivateLock(this.lockFile(card.targetId), owner);
    try {
      this.onTargetLockAcquired?.(transition, card.targetId);
      action(this.readVerified(card));
    } finally {
      lock.release();
    }
  }

  private readVerified(card: LocalWorkspaceTargetCardV1): TargetRecordV1 {
    this.assertCard(card);
    this.assertRegistryDirectories();
    const file = this.recordFile(card.targetId);
    if (!existsSync(file)) throw betaError("TARGET_MISMATCH", "The local target does not exist in this registry.");
    const entry = lstatSync(file);
    if (entry.isSymbolicLink()) throw betaError("OPERATION_IN_DOUBT", "The target record must not be a symbolic link.");
    const value = readJsonFile(file);
    if (!validRecord(value)) throw betaError("OPERATION_IN_DOUBT", "The target record is malformed.");
    const record = value as TargetRecordV1;
    if (record.targetId !== card.targetId || record.registryFingerprint !== this.registryFingerprint || card.registryFingerprint !== this.registryFingerprint || !sameHash(record.capabilityHash, sha256(card.capability)) || !exactWorkspace(record.workspace, card.workspace)) {
      throw betaError("TARGET_MISMATCH", "The target card does not match this local workspace.");
    }
    return record;
  }

  private assertCard(card: LocalWorkspaceTargetCardV1): void {
    if (!card || card.schema !== "trajecta.local-target/v1" || typeof card.targetId !== "string" || typeof card.capability !== "string" || !card.workspace || card.workspace.stateRootFingerprint !== this.stateRootFingerprint) {
      throw betaError("TARGET_MISMATCH", "The target card does not match this registry.");
    }
  }

  private requireFresh(record: TargetRecordV1, now: Date): void {
    if (!Number.isFinite(now.getTime()) || Date.parse(record.expiresAt) <= now.getTime()) {
      throw betaError("TARGET_EXPIRED", "The local target has expired.");
    }
  }
}

function checkedTime(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw betaError("CAPABILITY_UNAVAILABLE", "The configured clock did not return a valid time.");
  return value.toISOString();
}
