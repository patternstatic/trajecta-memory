import type { WorkItem } from "../../../src/types.ts";
import { canonicalJson } from "./canonical.ts";
import type { LocalResumeEnvelopeV1, LocalResumeInspectionV1, LocalResumeReceiptV1 } from "./contracts.ts";
import { assertEnvelopeFresh, captureLocalResumeEnvelopeFile, deriveLocalResumeReceiptReferences, readLocalResumeEnvelopeBytes } from "./envelope.ts";
import { betaError } from "./errors.ts";
import type { LocalKernelPort } from "./kernel-port.ts";
import type { OperationJournal } from "./operation-journal.ts";
import type { ReceiptStore } from "./receipt-store.ts";
import type { TargetRegistry } from "./target-registry.ts";
import { observeWorkspace, sha256, type WorkspaceObservation } from "./workspace.ts";
import { withWriterLock, type WriterLease } from "./writer-lock.ts";

export interface LocalResumeServiceOptions {
  stateRoot: string;
  cwd: string;
  kernel: LocalKernelPort;
  registry: TargetRegistry;
  journal: OperationJournal;
  receipts: ReceiptStore;
  clock?: () => Date;
  observe?: (cwd: string, stateRoot: string) => WorkspaceObservation;
}

export class LocalResumeService {
  private readonly options: LocalResumeServiceOptions;
  private readonly clock: () => Date;
  private readonly observe: (cwd: string, stateRoot: string) => WorkspaceObservation;

  constructor(options: LocalResumeServiceOptions) {
    this.options = { ...options };
    this.clock = options.clock ?? (() => new Date());
    this.observe = options.observe ?? observeWorkspace;
  }

  inspectFile(file: string): LocalResumeInspectionV1 {
    const { envelope } = captureLocalResumeEnvelopeFile(file);
    const work = this.authorizedWork(envelope);
    if (work.activeBranchId !== envelope.packet.activeBranch!.id) throw betaError("BRANCH_MISMATCH", "The active work branch differs from the packet branch.");
    return {
      schema: "trajecta.local-resume-inspection/v1",
      envelopeId: envelope.envelopeId,
      operationId: envelope.operationId,
      targetId: envelope.target.targetId,
      repository: envelope.target.workspace.repository,
      workId: work.id,
      branchId: work.activeBranchId,
      expectedRevision: envelope.packet.resume.expectedRevision,
      currentRevision: work.revision,
      nextAction: envelope.packet.work.nextAction,
      provenance: deriveLocalResumeReceiptReferences(envelope.packet).provenance,
    };
  }

  // Await the writer lease's full lifetime, including durable release evidence.
  async resumeFile(file: string, runtime: { accepted: boolean }): Promise<Buffer> {
    const captured = captureLocalResumeEnvelopeFile(file);
    const { envelope } = captured;
    const attemptDigest = envelope.integrity.canonicalPayloadDigest;
    return withWriterLock({ stateRoot: this.options.stateRoot, operationId: envelope.operationId, clock: this.clock }, (writer) => {
      const prior = this.options.journal.lookup(envelope.operationId);
      if (prior) {
        if (prior.attemptDigest !== attemptDigest || prior.envelopeId !== envelope.envelopeId || prior.targetId !== envelope.target.targetId) {
          throw betaError("OPERATION_CONFLICT", "Operation ID is bound to a different captured attempt.");
        }
        if (prior.state === "receipt-committed" && prior.receipt?.outcome === "rejected") {
          const bytes = this.receiptBytes(envelope.operationId);
          if (!bytes.equals(Buffer.from(`${canonicalJson(prior.receipt)}\n`))) throw betaError("OPERATION_IN_DOUBT", "Operation evidence and committed receipt disagree.");
          return bytes;
        }
        throw betaError("OPERATION_IN_DOUBT", "The existing operation requires inspection before further work.");
      }

      // Revalidate the one retained bounded capture under the lease; never reopen file.
      const verified = readLocalResumeEnvelopeBytes(captured.bytes);
      const work = this.authorizedWork(verified);
      if (work.activeBranchId !== verified.packet.activeBranch!.id) return this.reject(verified, work, "BRANCH_MISMATCH", writer);
      if (work.revision !== verified.packet.resume.expectedRevision) return this.reject(verified, work, "REVISION_CONFLICT", writer);
      if (runtime.accepted !== true) throw betaError("USER_ACCEPTANCE_REQUIRED", "Explicit runtime acceptance is required for this current packet.");
      throw betaError("CAPABILITY_UNAVAILABLE", "Accepted kernel resume is not enabled in this SDK stage.");
    });
  }

  receiptBytes(operationId: string): Buffer {
    const bytes = this.options.receipts.readBytes(operationId);
    if (!bytes) throw betaError("OPERATION_IN_DOUBT", "No committed receipt is available for this operation.");
    return bytes;
  }

  private authorizedWork(envelope: LocalResumeEnvelopeV1): WorkItem {
    const now = this.clock();
    assertEnvelopeFresh(envelope, now);
    this.options.registry.lookup(envelope.target, now, { operationId: envelope.operationId, attemptDigest: envelope.integrity.canonicalPayloadDigest });
    const observation = this.observe(this.options.cwd, this.options.stateRoot);
    const target = envelope.target.workspace;
    if (observation.repository !== target.repository || observation.repositoryFingerprint !== target.repositoryFingerprint || observation.stateRootFingerprint !== target.stateRootFingerprint) {
      throw betaError("WORKSPACE_MISMATCH", "The observed repository or state root differs from the authorized target.");
    }
    if (observation.branch !== target.branch) throw betaError("BRANCH_MISMATCH", "The observed workspace branch differs from the authorized target.");
    const work = this.options.kernel.getWork(envelope.packet.work.id);
    if (work.id !== envelope.packet.work.id) throw betaError("TARGET_MISMATCH", "The kernel did not return the exact requested work.");
    return work;
  }

  private reject(envelope: LocalResumeEnvelopeV1, work: WorkItem, code: "REVISION_CONFLICT" | "BRANCH_MISMATCH", writer: WriterLease): Buffer {
    const attemptDigest = envelope.integrity.canonicalPayloadDigest;
    this.options.journal.open({ operationId: envelope.operationId, attemptDigest, envelopeId: envelope.envelopeId, targetId: envelope.target.targetId }, writer);
    const inspected = this.options.journal.transition(envelope.operationId, "inspected", {}, writer);
    const receipt: LocalResumeReceiptV1 = {
      schema: "trajecta.local-resume-receipt/v1",
      receiptId: `receipt:${sha256(`${envelope.operationId}:${attemptDigest}:rejected:${code}`).slice(0, 32)}`,
      envelopeId: envelope.envelopeId,
      operationId: envelope.operationId,
      attemptDigest,
      outcome: "rejected",
      code,
      targetId: envelope.target.targetId,
      repositoryFingerprint: envelope.target.workspace.repositoryFingerprint,
      stateRootFingerprint: envelope.target.workspace.stateRootFingerprint,
      workId: work.id,
      branchId: envelope.packet.activeBranch!.id,
      packetId: envelope.packet.packetId,
      expectedRevision: envelope.packet.resume.expectedRevision,
      observedRevisionBefore: work.revision,
      observedRevisionAfter: work.revision,
      ...deriveLocalResumeReceiptReferences(envelope.packet),
      createdAt: inspected.transitions.at(-1)!.observedAt,
    };
    const bytes = this.options.receipts.commit(receipt, writer);
    this.options.journal.transition(envelope.operationId, "receipt-committed", { receipt }, writer);
    return bytes;
  }
}
