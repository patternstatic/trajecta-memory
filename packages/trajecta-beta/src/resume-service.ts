import type { WorkItem } from "./kernel-port.ts";
import { canonicalJson } from "./canonical.ts";
import type { LocalOperationRecordV1, LocalResumeEnvelopeV1, LocalResumeInspectionV1, LocalResumeReceiptV1, ResumeFaultPoint } from "./contracts.ts";
import { assertEnvelopeFresh, captureLocalResumeEnvelopeFile, deriveLocalResumeReceiptReferences, readLocalResumeEnvelopeBytes } from "./envelope.ts";
import { betaError } from "./errors.ts";
import { toKernelResumeInput, type LocalKernelPort } from "./kernel-port.ts";
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
  fault?: (point: ResumeFaultPoint) => void;
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
    const preflight = this.options.journal.lookup(envelope.operationId);
    if (preflight) this.assertAttempt(preflight, envelope);
    if (preflight?.state === "inspection-required") throw betaError("OPERATION_IN_DOUBT", "The existing operation requires inspection before further work.");
    return withWriterLock({ stateRoot: this.options.stateRoot, operationId: envelope.operationId, clock: this.clock }, (writer) => {
      const prior = this.options.journal.lookup(envelope.operationId);
      if (prior) {
        this.assertAttempt(prior, envelope);
        if (prior.state === "inspection-required") throw betaError("OPERATION_IN_DOUBT", "The existing operation requires inspection before further work.");
        if (prior.state !== "created" && prior.state !== "inspected") return this.reconcile(envelope, prior, writer);
      }

      // Revalidate the one retained bounded capture under the lease; never reopen file.
      const verified = readLocalResumeEnvelopeBytes(captured.bytes);
      let pendingReceipt: Buffer | null;
      try { pendingReceipt = this.options.receipts.readBytes(envelope.operationId); }
      catch {
        this.options.journal.open({ operationId: envelope.operationId, attemptDigest, envelopeId: envelope.envelopeId, targetId: envelope.target.targetId }, writer);
        return this.quarantine(envelope.operationId, writer);
      }
      if (!prior && pendingReceipt) {
        this.options.journal.open({ operationId: envelope.operationId, attemptDigest, envelopeId: envelope.envelopeId, targetId: envelope.target.targetId }, writer);
        return this.quarantine(envelope.operationId, writer);
      }
      if (!prior && this.options.registry.hasReservation(envelope.target, envelope.operationId, attemptDigest)) {
        this.options.journal.open({ operationId: envelope.operationId, attemptDigest, envelopeId: envelope.envelopeId, targetId: envelope.target.targetId }, writer);
        return this.quarantine(envelope.operationId, writer);
      }
      let alreadyReserved = false;
      if (prior) {
        this.checked(envelope.operationId, writer, () => {
          try { this.options.registry.assertReservation(envelope.target, envelope.operationId, attemptDigest); alreadyReserved = true; }
          catch { this.options.registry.assertIssued(envelope.target); }
        });
      }
      let work: WorkItem;
      try { work = this.authorizedWork(verified, !!prior); }
      catch (error) {
        if (alreadyReserved || pendingReceipt) return this.quarantine(envelope.operationId, writer);
        throw error;
      }
      if (alreadyReserved && (work.activeBranchId !== verified.packet.activeBranch!.id || work.revision !== verified.packet.resume.expectedRevision || pendingReceipt)) return this.quarantine(envelope.operationId, writer);
      if (work.activeBranchId !== verified.packet.activeBranch!.id) return this.reject(verified, work, "BRANCH_MISMATCH", writer);
      if (work.revision !== verified.packet.resume.expectedRevision) return this.reject(verified, work, "REVISION_CONFLICT", writer);
      if (pendingReceipt) return this.quarantine(envelope.operationId, writer);
      if (runtime.accepted !== true) throw betaError("USER_ACCEPTANCE_REQUIRED", "Explicit runtime acceptance is required for this current packet.");
      this.options.journal.open({ operationId: envelope.operationId, attemptDigest, envelopeId: envelope.envelopeId, targetId: envelope.target.targetId }, writer);
      this.options.journal.transition(envelope.operationId, "inspected", {}, writer);
      if (alreadyReserved) {
        this.checked(envelope.operationId, writer, () => this.options.registry.assertFreshReservation(envelope.target, envelope.operationId, attemptDigest, this.clock, envelope.expiresAt));
      } else {
        this.options.registry.reserve(envelope.target, envelope.operationId, attemptDigest, this.clock, envelope.expiresAt);
      }
      const reserved = this.options.journal.transition(envelope.operationId, "reserved", { acceptance: { source: "runtime-flag", observedAt: this.clock().toISOString() } }, writer);
      this.options.fault?.("after-target-reserve");
      return this.reconcile(envelope, reserved, writer);
    });
  }

  receiptBytes(operationId: string): Buffer {
    const bytes = this.options.receipts.readBytes(operationId);
    if (!bytes) throw betaError("OPERATION_IN_DOUBT", "No committed receipt is available for this operation.");
    return bytes;
  }

  private assertAttempt(record: LocalOperationRecordV1, envelope: LocalResumeEnvelopeV1): void {
    if (record.operationId !== envelope.operationId || record.attemptDigest !== envelope.integrity.canonicalPayloadDigest || record.envelopeId !== envelope.envelopeId || record.targetId !== envelope.target.targetId) {
      throw betaError("OPERATION_CONFLICT", "Operation ID is bound to a different captured attempt.");
    }
  }

  private quarantine(operationId: string, writer: WriterLease): never {
    this.options.journal.markInspectionRequired(operationId, "Durable operation, target, kernel or receipt evidence disagrees.", writer);
    throw betaError("OPERATION_IN_DOUBT", "Durable operation evidence requires inspection before further work.");
  }

  private checked<T>(operationId: string, writer: WriterLease, check: () => T): T {
    try { return check(); } catch { return this.quarantine(operationId, writer); }
  }

  private reconcile(envelope: LocalResumeEnvelopeV1, initial: LocalOperationRecordV1, writer: WriterLease): Buffer {
    const { journal, registry, kernel, receipts } = this.options;
    const operationId = envelope.operationId, digest = envelope.integrity.canonicalPayloadDigest;
    let record = initial;
    if (record.state === "receipt-committed" && record.receipt?.outcome === "rejected") {
      return this.checked(operationId, writer, () => {
        const bytes = this.receiptBytes(operationId);
        const expected = this.makeReceipt(envelope, "rejected", record.receipt!.code, record.receipt!.observedRevisionBefore!, record.transitions.find(t => t.state === "inspected")!.observedAt);
        if (!bytes.equals(Buffer.from(`${canonicalJson(expected)}\n`)) || canonicalJson(expected) !== canonicalJson(record.receipt)) throw new Error("Rejection mismatch");
        return bytes;
      });
    }
    if (record.state === "reserved") {
      this.checked(operationId, writer, () => {
        if (record.acceptance?.source !== "runtime-flag") throw new Error("Acceptance missing");
        registry.assertReservation(envelope.target, operationId, digest);
        if (receipts.readBytes(operationId)) throw new Error("Premature receipt");
      });
      let result;
      try { result = kernel.resume(toKernelResumeInput(envelope)); }
      catch (error) {
        if (["OperationConflict", "OperationInDoubt", "RevisionConflict"].includes((error as Error)?.name)) return this.quarantine(operationId, writer);
        throw error; // An interrupted kernel WAL stays reserved for exact reconciliation.
      }
      record = this.checked(operationId, writer, () => journal.transition(operationId, "kernel-resumed", { kernelResult: result }, writer));
      this.options.fault?.("after-kernel-resume");
    }
    this.checked(operationId, writer, () => this.assertKernelEvidence(envelope, record));
    const expected = this.makeReceipt(envelope, "accepted", "RESUMED", envelope.packet.resume.expectedRevision,
      record.transitions.find(t => t.state === "kernel-resumed")!.observedAt);
    if (record.state === "kernel-resumed") {
      this.checked(operationId, writer, () => registry.assertReservation(envelope.target, operationId, digest));
      this.checked(operationId, writer, () => receipts.commit(expected, writer));
      record = journal.transition(operationId, "receipt-committed", { receipt: expected }, writer);
      this.options.fault?.("after-receipt-commit");
    }
    const bytes = this.checked(operationId, writer, () => {
      const stored = this.receiptBytes(operationId);
      if (canonicalJson(record.receipt) !== canonicalJson(expected) || !stored.equals(Buffer.from(`${canonicalJson(expected)}\n`))) throw new Error("Receipt mismatch");
      return stored;
    });
    if (record.state === "receipt-committed") {
      this.checked(operationId, writer, () => {
        // Consumption may already be durable when the last SDK transition was interrupted.
        try { registry.assertReservation(envelope.target, operationId, digest); }
        catch { registry.assertConsumed(envelope.target, operationId, digest, expected.receiptId); return; }
        registry.consume(envelope.target, operationId, expected.receiptId);
        registry.assertConsumed(envelope.target, operationId, digest, expected.receiptId);
      });
      this.options.fault?.("after-target-consume");
      record = journal.transition(operationId, "target-consumed", {}, writer);
    } else {
      this.checked(operationId, writer, () => registry.assertConsumed(envelope.target, operationId, digest, expected.receiptId));
    }
    return bytes;
  }

  private assertKernelEvidence(envelope: LocalResumeEnvelopeV1, record: LocalOperationRecordV1): void {
    const result = record.kernelResult, input = toKernelResumeInput(envelope);
    if (!result || result.work.id !== input.workId || result.work.revision !== input.expectedRevision + 1 || result.work.activeBranchId !== envelope.packet.activeBranch!.id
      || canonicalJson(result.work.lastSurface) !== canonicalJson(input.surface)
      || (input.instruction && result.work.instruction !== input.instruction.trim())
      || result.delta.operationId !== input.operationId || result.delta.workId !== input.workId || result.delta.revision !== input.expectedRevision + 1
      || result.delta.branchId !== envelope.packet.activeBranch!.id || canonicalJson(result.delta.surface) !== canonicalJson(input.surface)
      || result.delta.summary !== (input.instruction?.trim() ?? `Resumed on ${input.surface.kind}:${input.surface.name}`)) throw new Error("Kernel result does not match the exact packet");
    const deltas = this.options.kernel.history(input.workId).filter(delta => delta.operationId === input.operationId);
    if (deltas.length !== 1 || canonicalJson(deltas[0]) !== canonicalJson(result.delta)) throw new Error("Kernel delta evidence disagrees");
  }

  private authorizedWork(envelope: LocalResumeEnvelopeV1, allowReservation = true): WorkItem {
    const now = this.clock();
    assertEnvelopeFresh(envelope, now);
    this.options.registry.lookup(envelope.target, now, allowReservation ? { operationId: envelope.operationId, attemptDigest: envelope.integrity.canonicalPayloadDigest } : undefined);
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
    const receipt = this.makeReceipt(envelope, "rejected", code, work.revision, inspected.transitions.at(-1)!.observedAt);
    const bytes = this.checked(envelope.operationId, writer, () => this.options.receipts.commit(receipt, writer));
    this.options.journal.transition(envelope.operationId, "receipt-committed", { receipt }, writer);
    return bytes;
  }

  private makeReceipt(envelope: LocalResumeEnvelopeV1, outcome: "accepted" | "rejected", code: LocalResumeReceiptV1["code"], revision: number, createdAt: string): LocalResumeReceiptV1 {
    const attemptDigest = envelope.integrity.canonicalPayloadDigest;
    return {
      schema: "trajecta.local-resume-receipt/v1",
      receiptId: `receipt:${sha256(`${envelope.operationId}:${attemptDigest}:${outcome}:${code}`).slice(0, 32)}`,
      envelopeId: envelope.envelopeId,
      operationId: envelope.operationId,
      attemptDigest,
      outcome,
      code,
      targetId: envelope.target.targetId,
      repositoryFingerprint: envelope.target.workspace.repositoryFingerprint,
      stateRootFingerprint: envelope.target.workspace.stateRootFingerprint,
      workId: envelope.packet.work.id,
      branchId: envelope.packet.activeBranch!.id,
      packetId: envelope.packet.packetId,
      expectedRevision: envelope.packet.resume.expectedRevision,
      observedRevisionBefore: revision,
      observedRevisionAfter: outcome === "accepted" ? revision + 1 : revision,
      ...deriveLocalResumeReceiptReferences(envelope.packet),
      createdAt,
    };
  }
}
