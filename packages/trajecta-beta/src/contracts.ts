import type { Delta, TransferPacket, WorkItem } from "../../../src/types.ts";

export interface LocalWorkspaceTargetCardV1 {
  schema: "trajecta.local-target/v1";
  targetId: string;
  capability: string;
  createdAt: string;
  expiresAt: string;
  registryFingerprint: string;
  workspace: {
    repository: string;
    repositoryFingerprint: string;
    stateRootFingerprint: string;
    branch: string;
  };
}

export interface LocalResumeEnvelopeV1 {
  schema: "trajecta.local-resume-envelope/v1";
  envelopeId: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  target: LocalWorkspaceTargetCardV1;
  packet: TransferPacket;
  integrity: {
    algorithm: "sha256";
    canonicalPayloadDigest: string;
  };
}

export interface LocalResumeInspectionV1 {
  schema: "trajecta.local-resume-inspection/v1";
  envelopeId: string;
  operationId: string;
  targetId: string;
  repository: string;
  workId: string;
  branchId: string;
  expectedRevision: number;
  currentRevision: number;
  nextAction: string | null;
  provenance: string[];
}

export type LocalResumeReceiptCode =
  | "REVISION_CONFLICT"
  | "BRANCH_MISMATCH"
  | "RESUMED";

export interface LocalResumeReceiptV1 {
  schema: "trajecta.local-resume-receipt/v1";
  receiptId: string;
  envelopeId: string;
  operationId: string;
  attemptDigest: string;
  outcome: "rejected" | "accepted";
  code: LocalResumeReceiptCode;
  targetId: string;
  repositoryFingerprint: string;
  stateRootFingerprint: string;
  workId: string;
  branchId: string | null;
  packetId: string;
  expectedRevision: number;
  observedRevisionBefore: number | null;
  observedRevisionAfter: number | null;
  provenance: string[];
  evidence: string[];
  createdAt: string;
}

export type OperationState = "created" | "inspected" | "reserved" | "kernel-resumed" | "receipt-committed" | "target-consumed" | "inspection-required";

export interface LocalOperationRecordV1 {
  schema: "trajecta.local-operation/v1";
  operationId: string;
  attemptDigest: string;
  envelopeId: string;
  targetId: string;
  state: OperationState;
  transitions: Array<{ state: OperationState; observedAt: string }>;
  acceptance: { source: "runtime-flag"; observedAt: string } | null;
  kernelResult: { work: WorkItem; delta: Delta } | null;
  receipt: LocalResumeReceiptV1 | null;
  doubtReason: string | null;
}

export interface WriterLockV1 {
  schema: "trajecta.writer-lock/v1";
  operationId: string;
  pid: number;
  hostname: string;
  processStartToken: string;
  acquiredAt: string;
}
