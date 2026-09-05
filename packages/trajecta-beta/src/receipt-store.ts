import { lstatSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { LocalResumeReceiptV1 } from "./contracts.ts";
import { assertPrivateDirectory, ensurePrivateDirectory, readOptionalPrivateBytes, writeBytesExclusive } from "./durable-file.ts";
import { betaError } from "./errors.ts";
import { parseStrictJsonBytes } from "./strict-json.ts";
import { sha256 } from "./workspace.ts";
import { assertWriterLease, type WriterLease } from "./writer-lock.ts";

export function validOpaqueId(value: unknown, prefix?: string): value is string {
  return typeof value === "string" && value.length <= 240 && /^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && (!prefix || value.startsWith(`${prefix}:`));
}
export function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function exactObject(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function references(value: unknown): boolean { return Array.isArray(value) && value.length <= 20 && value.every((item, i) => validOpaqueId(item) && (i === 0 || value[i - 1] < item)); }

export function validLocalResumeReceipt(value: unknown): value is LocalResumeReceiptV1 {
  if (!exactObject(value, ["schema", "receiptId", "envelopeId", "operationId", "attemptDigest", "outcome", "code", "targetId", "repositoryFingerprint", "stateRootFingerprint", "workId", "branchId", "packetId", "expectedRevision", "observedRevisionBefore", "observedRevisionAfter", "provenance", "evidence", "createdAt"])) return false;
  if (value.schema !== "trajecta.local-resume-receipt/v1" || !validOpaqueId(value.receiptId, "receipt") || !validOpaqueId(value.envelopeId, "envelope") || !validOpaqueId(value.operationId, "operation") || !validOpaqueId(value.targetId, "target") || !validOpaqueId(value.workId) || !validOpaqueId(value.packetId)
    || (value.branchId !== null && !validOpaqueId(value.branchId)) || !validDigest(value.attemptDigest) || !validDigest(value.repositoryFingerprint) || !validDigest(value.stateRootFingerprint)
    || !revision(value.expectedRevision) || (value.observedRevisionBefore !== null && !revision(value.observedRevisionBefore)) || (value.observedRevisionAfter !== null && !revision(value.observedRevisionAfter))
    || !references(value.provenance) || !references(value.evidence) || !validTimestamp(value.createdAt)) return false;
  if (value.outcome === "accepted") return value.code === "RESUMED" && value.branchId !== null && value.observedRevisionBefore === value.expectedRevision && value.observedRevisionAfter === value.expectedRevision + 1;
  return value.outcome === "rejected" && (value.code === "REVISION_CONFLICT" || value.code === "BRANCH_MISMATCH") && value.observedRevisionAfter === value.observedRevisionBefore;
}

/** Read-only even when the root or category is absent; never create state during inspection. */
export function readStoredBytes(root: string, category: "operations" | "receipts", id: string): Buffer | null {
  if (!validOpaqueId(id, "operation")) throw betaError("OPERATION_CONFLICT", "A bounded operation ID is required.");
  try { lstatSync(root); } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw betaError("OPERATION_IN_DOUBT", "Unable to inspect private state root.");
  }
  assertPrivateDirectory(root);
  return readOptionalPrivateBytes(path.join(root, category, `${sha256(id)}.json`));
}

function validateBytes(bytes: Buffer, id: string): void {
  try {
    const value = parseStrictJsonBytes(bytes);
    if (bytes.at(-1) !== 10 || !validLocalResumeReceipt(value) || value.operationId !== id || !bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) throw new Error("Invalid receipt");
  } catch { throw betaError("OPERATION_IN_DOUBT", "Durable receipt bytes are malformed or do not match the lookup operation."); }
}

export class ReceiptStore {
  private readonly stateRoot: string;
  constructor(options: { stateRoot: string }) { this.stateRoot = path.resolve(options.stateRoot); }

  readBytes(operationId: string): Buffer | null {
    const bytes = readStoredBytes(this.stateRoot, "receipts", operationId);
    if (bytes === null) return null;
    validateBytes(bytes, operationId);
    return Buffer.from(bytes);
  }

  commit(receipt: LocalResumeReceiptV1, writer: WriterLease): Buffer {
    assertWriterLease(writer, this.stateRoot, receipt?.operationId);
    if (!validLocalResumeReceipt(receipt)) throw betaError("OPERATION_CONFLICT", "Receipt does not satisfy the local resume contract.");
    const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
    // Bound and validate before creation, so a successful commit can always be read back.
    validateBytes(bytes, receipt.operationId);
    const existing = this.readBytes(receipt.operationId);
    if (existing) {
      if (!existing.equals(bytes)) throw betaError("OPERATION_CONFLICT", "Another receipt is already committed for this operation.");
      return existing;
    }
    const directory = path.join(this.stateRoot, "receipts"); ensurePrivateDirectory(directory);
    assertWriterLease(writer, this.stateRoot, receipt.operationId);
    writeBytesExclusive(path.join(directory, `${sha256(receipt.operationId)}.json`), bytes);
    assertWriterLease(writer, this.stateRoot, receipt.operationId);
    const committed = this.readBytes(receipt.operationId);
    if (!committed?.equals(bytes)) throw betaError("OPERATION_IN_DOUBT", "Receipt bytes changed during commit.");
    return committed;
  }
}
