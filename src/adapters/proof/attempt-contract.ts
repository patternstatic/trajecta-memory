import crypto from "node:crypto";
import type { TransferPacket } from "../../types.ts";

export type ResumeAttemptCode =
  | "REVISION_CONFLICT"
  | "TARGET_MISMATCH"
  | "BRANCH_MISMATCH"
  | "USER_ACCEPTANCE_REQUIRED"
  | "RESUMED";

export interface ResumeTargetV1 {
  surface: "local";
  name: string;
  session: string;
  capability: string;
}

export interface ResumeAttemptInputV1 {
  schema: "trajecta.resume-attempt/v1";
  operationId: string;
  packet: TransferPacket;
  target: ResumeTargetV1;
  expectedTarget: ResumeTargetV1;
  acceptedByUser: boolean;
}

export interface ResumeAttemptReceiptV1 {
  schema: "trajecta.resume-attempt-receipt/v1";
  receiptId: string;
  operationId: string;
  attemptDigest: string;
  outcome: "rejected" | "accepted";
  code: ResumeAttemptCode;
  workId: string;
  branchId: string | null;
  packetId: string;
  target: { surface: "local"; name: string; session: string };
  expectedRevision: number;
  observedRevisionBefore: number | null;
  observedRevisionAfter: number | null;
  provenance: string[];
  evidence: string[];
  createdAt: string;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Attempt contains a non-JSON value");
  }
  return value;
}

export function stableSerialize(value: unknown) {
  return JSON.stringify(normalize(value));
}

export function digestResumeAttempt(input: ResumeAttemptInputV1) {
  return crypto.createHash("sha256").update(stableSerialize(input)).digest("hex");
}

function bounded(value: string, label: string, max: number) {
  if (!value?.trim() || value.length > max) throw new Error(`${label} is required and must not exceed ${max} characters`);
}

export function assertResumeAttempt(input: ResumeAttemptInputV1) {
  if (input?.schema !== "trajecta.resume-attempt/v1") throw new Error("Unsupported resume attempt schema");
  if (input.packet?.schema !== "trajecta.transfer/v1") throw new Error("Unsupported transfer packet schema");
  bounded(input.operationId, "Operation ID", 240);
  if (!/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.operationId)) throw new Error("Operation ID must be namespaced");
  bounded(input.target?.name, "Target name", 120);
  bounded(input.target?.session, "Target session", 200);
  bounded(input.target?.capability, "Target capability", 240);
  bounded(input.expectedTarget?.name, "Expected target name", 120);
  bounded(input.expectedTarget?.session, "Expected target session", 200);
  bounded(input.expectedTarget?.capability, "Expected target capability", 240);
  if (input.target.surface !== "local" || input.expectedTarget.surface !== "local") throw new Error("Proof target must be local");
  if (typeof input.acceptedByUser !== "boolean") throw new Error("acceptedByUser must be boolean");
  stableSerialize(input);
}
