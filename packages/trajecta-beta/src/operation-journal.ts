import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { LocalOperationRecordV1, OperationState } from "./contracts.ts";
import { ensurePrivateDirectory, writeJsonAtomic, writeJsonExclusive } from "./durable-file.ts";
import { betaError } from "./errors.ts";
import { exactObject, readStoredBytes, validDigest, validLocalResumeReceipt, validOpaqueId, validTimestamp } from "./receipt-store.ts";
import { parseStrictJsonBytes } from "./strict-json.ts";
import { sha256 } from "./workspace.ts";
import { assertWriterLease, type WriterLease } from "./writer-lock.ts";

export type OperationIdentity = Pick<LocalOperationRecordV1, "operationId" | "attemptDigest" | "envelopeId" | "targetId">;
export type OperationUpdate = Partial<Pick<LocalOperationRecordV1, "acceptance" | "kernelResult" | "receipt" | "doubtReason">>;
const ADJACENT = new Set(["created:inspected", "inspected:reserved", "inspected:receipt-committed", "reserved:kernel-resumed", "kernel-resumed:receipt-committed", "receipt-committed:target-consumed"]);
function conflict(message: string): never { throw betaError("OPERATION_CONFLICT", message); }
function doubt(message: string): never { throw betaError("OPERATION_IN_DOUBT", message); }
// Match the kernel/packet text contract: bounded, nonblank ordinary work text may
// contain line breaks and tabs. Only the inspection reason is single-line text.
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function inspectionReason(value: unknown): value is string { return text(value, 512) && !/[\u0000-\u001f\u007f]/.test(value); }
function validIdentity(v: unknown): v is OperationIdentity { return !!v && typeof v === "object" && validOpaqueId((v as OperationIdentity).operationId, "operation") && validOpaqueId((v as OperationIdentity).envelopeId, "envelope") && validOpaqueId((v as OperationIdentity).targetId, "target") && validDigest((v as OperationIdentity).attemptDigest); }
function sameIdentity(left: OperationIdentity, right: OperationIdentity): boolean { return left.operationId === right.operationId && left.envelopeId === right.envelopeId && left.targetId === right.targetId && left.attemptDigest === right.attemptDigest; }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function nullableText(value: unknown, max: number): boolean { return value === null || text(value, max); }
function surface(value: unknown): boolean { return exactObject(value, ["kind", "name", "session"]) && (value.kind === "local" || value.kind === "cloud") && text(value.name, 120) && validOpaqueId(value.session); }
function branch(value: unknown): boolean {
  return exactObject(value, ["id", "label", "purpose", "cues", "returnPoint", "status", "updatedAt"]) && validOpaqueId(value.id) && text(value.label, 120) && text(value.purpose, 500) && text(value.returnPoint, 500)
    && Array.isArray(value.cues) && value.cues.length <= 20 && value.cues.every((v: unknown) => text(v, 500)) && ["exploring", "parked", "merged"].includes(value.status) && validTimestamp(value.updatedAt);
}
function validKernel(value: unknown, operationId: string): boolean {
  if (!exactObject(value, ["work", "delta"])) return false;
  const { work, delta } = value;
  if (!exactObject(work, ["id", "topic", "goal", "instruction", "status", "revision", "activeBranchId", "branches", "openLoops", "nextAction", "lastSurface", "createdAt", "updatedAt"])
    || !validOpaqueId(work.id) || !text(work.topic, 160) || !text(work.goal, 1000) || !nullableText(work.instruction, 1000) || !["active", "waiting", "blocked", "complete", "abandoned"].includes(work.status)
    || !revision(work.revision) || (work.activeBranchId !== null && !validOpaqueId(work.activeBranchId)) || !Array.isArray(work.branches) || work.branches.length > 100 || !work.branches.every(branch)
    || !Array.isArray(work.openLoops) || work.openLoops.length > 20 || !work.openLoops.every((v: unknown) => text(v, 500)) || !nullableText(work.nextAction, 1000) || !surface(work.lastSurface) || !validTimestamp(work.createdAt) || !validTimestamp(work.updatedAt)) return false;
  return exactObject(delta, ["id", "operationId", "workId", "revision", "kind", "summary", "surface", "branchId", "targetSurface", "provenance", "createdAt"])
    && validOpaqueId(delta.id) && delta.operationId === `${operationId}.kernel` && delta.workId === work.id && delta.revision === work.revision && delta.kind === "resume" && text(delta.summary, 1000)
    && surface(delta.surface) && canonicalJson(delta.surface) === canonicalJson(work.lastSurface) && delta.branchId === work.activeBranchId && (delta.targetSurface === null || delta.targetSurface === "local" || delta.targetSurface === "cloud")
    && Array.isArray(delta.provenance) && delta.provenance.length <= 20 && delta.provenance.every((v: unknown) => validOpaqueId(v)) && validTimestamp(delta.createdAt);
}

function validRecord(value: unknown): value is LocalOperationRecordV1 {
  if (!exactObject(value, ["schema", "operationId", "attemptDigest", "envelopeId", "targetId", "state", "transitions", "acceptance", "kernelResult", "receipt", "doubtReason"]) || value.schema !== "trajecta.local-operation/v1" || !validIdentity(value)) return false;
  const record = value as LocalOperationRecordV1;
  if (!Array.isArray(record.transitions) || record.transitions.length < 1 || record.transitions.length > 7) return false;
  const states: OperationState[] = [];
  for (const entry of record.transitions) {
    if (!exactObject(entry, ["state", "observedAt"]) || !validTimestamp(entry.observedAt)) return false;
    const previous = states.at(-1);
    if (previous === undefined ? entry.state !== "created" : !ADJACENT.has(`${previous}:${entry.state}`) && !(entry.state === "inspection-required" && previous !== "inspection-required")) return false;
    states.push(entry.state);
  }
  if (states.at(-1) !== record.state) return false;
  const reserved = states.includes("reserved"), resumed = states.includes("kernel-resumed"), committed = states.includes("receipt-committed");
  if (reserved ? !exactObject(record.acceptance, ["source", "observedAt"]) || record.acceptance.source !== "runtime-flag" || !validTimestamp(record.acceptance.observedAt) : record.acceptance !== null) return false;
  if (resumed ? !validKernel(record.kernelResult, record.operationId) : record.kernelResult !== null) return false;
  if (committed) {
    if (!validLocalResumeReceipt(record.receipt) || !sameIdentity(record.receipt, record) || (record.receipt.outcome === "accepted") !== resumed) return false;
    if (resumed && record.kernelResult && (record.receipt.workId !== record.kernelResult.work.id || record.receipt.branchId !== record.kernelResult.work.activeBranchId || record.receipt.observedRevisionAfter !== record.kernelResult.work.revision)) return false;
    if (!resumed && states.includes("target-consumed")) return false;
  } else if (record.receipt !== null) return false;
  return record.state === "inspection-required" ? inspectionReason(record.doubtReason) : record.doubtReason === null;
}

export class OperationJournal {
  private readonly stateRoot: string;
  private readonly clock: () => Date;
  constructor(options: { stateRoot: string; clock?: () => Date }) { this.stateRoot = path.resolve(options.stateRoot); this.clock = options.clock ?? (() => new Date()); }
  private file(id: string): string { return path.join(this.stateRoot, "operations", `${sha256(id)}.json`); }

  lookup(operationId: string): LocalOperationRecordV1 | null {
    const bytes = readStoredBytes(this.stateRoot, "operations", operationId);
    if (bytes === null) return null;
    let record: unknown;
    try { record = parseStrictJsonBytes(bytes); } catch { doubt("Operation snapshot is torn or malformed."); }
    if (!validRecord(record) || record.operationId !== operationId) doubt("Operation snapshot has invalid identity or state.");
    return structuredClone(record);
  }

  open(input: OperationIdentity, writer: WriterLease): LocalOperationRecordV1 {
    assertWriterLease(writer, this.stateRoot, input?.operationId);
    if (!exactObject(input, ["operationId", "attemptDigest", "envelopeId", "targetId"]) || !validIdentity(input)) conflict("Operation identity is invalid.");
    const prior = this.lookup(input.operationId);
    if (prior) { if (!sameIdentity(prior, input)) conflict("Operation ID is bound to a different attempt."); return prior; }
    const record: LocalOperationRecordV1 = { schema: "trajecta.local-operation/v1", ...input, state: "created", transitions: [{ state: "created", observedAt: this.clock().toISOString() }], acceptance: null, kernelResult: null, receipt: null, doubtReason: null };
    this.validateWrite(record);
    ensurePrivateDirectory(path.join(this.stateRoot, "operations"));
    assertWriterLease(writer, this.stateRoot, input.operationId);
    writeJsonExclusive(this.file(input.operationId), record);
    return this.verifyWrite(record, writer);
  }

  transition(operationId: string, state: OperationState, update: OperationUpdate, writer: WriterLease): LocalOperationRecordV1 {
    assertWriterLease(writer, this.stateRoot, operationId);
    const before = this.lookup(operationId);
    if (!before) doubt("Operation must be opened before transition.");
    const next = this.draftTransition(before, state, update);
    if (next === before) return before;
    assertWriterLease(writer, this.stateRoot, operationId);
    writeJsonAtomic(this.file(operationId), next);
    return this.verifyWrite(next, writer);
  }

  /** Prove every later accepted-operation snapshot fits before any new reservation or kernel mutation. */
  assertTransitionChainPersistable(operationId: string, transitions: ReadonlyArray<{ state: OperationState; update: OperationUpdate }>, writer: WriterLease): readonly number[] {
    assertWriterLease(writer, this.stateRoot, operationId);
    let record = this.lookup(operationId);
    if (!record) doubt("Operation must be opened before transition.");
    const bytes: number[] = [];
    for (const transition of transitions) {
      record = this.draftTransition(record, transition.state, transition.update);
      bytes.push(Buffer.byteLength(JSON.stringify(record), "utf8"));
    }
    return bytes;
  }

  private draftTransition(before: LocalOperationRecordV1, state: OperationState, update: OperationUpdate): LocalOperationRecordV1 {
    if (!update || typeof update !== "object" || Array.isArray(update) || Object.keys(update).some((key) => !["acceptance", "kernelResult", "receipt", "doubtReason"].includes(key))) conflict("Operation update has unsupported fields.");
    let next: LocalOperationRecordV1;
    try { next = structuredClone({ ...before, ...update, state }); } catch { conflict("Operation update is not serializable."); }
    if (state === before.state) {
      if (canonicalJson(next) !== canonicalJson(before)) conflict("Repeated transition changed the complete operation record.");
      return before;
    }
    if (before.state === "inspection-required" || (state !== "inspection-required" && (before.state === "target-consumed" || (before.state === "receipt-committed" && before.receipt?.outcome === "rejected")))) conflict("Terminal operations can only be quarantined for inspection.");
    if (!ADJACENT.has(`${before.state}:${state}`) && state !== "inspection-required") conflict("Operation transition must be adjacent.");
    for (const key of ["acceptance", "kernelResult", "receipt", "doubtReason"] as const) {
      if (!(key in update)) continue;
      const allowed = key === "acceptance" ? state === "reserved" : key === "kernelResult" ? state === "kernel-resumed" : key === "receipt" ? state === "receipt-committed" : state === "inspection-required";
      if (!allowed || before[key] !== null) conflict("Durable operation evidence cannot be moved or replaced.");
    }
    next.transitions.push({ state, observedAt: this.clock().toISOString() });
    this.validateWrite(next);
    return next;
  }

  markInspectionRequired(operationId: string, reason: string, writer: WriterLease): LocalOperationRecordV1 {
    if (!inspectionReason(reason)) conflict("Inspection reason must be bounded nonempty text.");
    return this.transition(operationId, "inspection-required", { doubtReason: reason }, writer);
  }

  private validateWrite(record: LocalOperationRecordV1): void {
    if (!validRecord(record)) conflict("Operation state and its durable evidence are inconsistent.");
    try { parseStrictJsonBytes(Buffer.from(canonicalJson(record))); } catch { conflict("Operation snapshot exceeds the supported durable JSON bounds."); }
  }

  private verifyWrite(record: LocalOperationRecordV1, writer: WriterLease): LocalOperationRecordV1 {
    assertWriterLease(writer, this.stateRoot, record.operationId);
    const stored = this.lookup(record.operationId);
    if (!stored || canonicalJson(stored) !== canonicalJson(record)) doubt("Operation snapshot changed during commit.");
    return stored;
  }
}
