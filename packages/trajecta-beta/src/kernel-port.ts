import path from "node:path";
import { lstatSync } from "node:fs";
import { TrajectaStore, assertTransferPacket, type Delta, type WorkItem, type TransferPacket } from "../../../src/index.ts";
import { canonicalSha256 } from "./canonical.ts";
import type { LocalResumeEnvelopeV1 } from "./contracts.ts";
import { assertPrivateDirectory } from "./durable-file.ts";
import { betaError } from "./errors.ts";

export { TrajectaStore, assertTransferPacket };
export type { Delta, WorkItem, TransferPacket };

export type ResumeInput = Parameters<TrajectaStore["resume"]>[0];
export interface KernelResumeResult { work: WorkItem; delta: Delta }

export interface LocalKernelPort {
  getWork(workId: string): WorkItem;
  history(workId: string): Delta[];
  resume(input: ResumeInput): KernelResumeResult;
}

export class TrajectaKernelPort implements LocalKernelPort {
  private readonly store: TrajectaStore;
  constructor(store: TrajectaStore) { this.store = store; }
  getWork(workId: string): WorkItem { return this.store.getWork(workId); }
  history(workId: string): Delta[] { return this.store.history(workId); }
  resume(input: ResumeInput): KernelResumeResult { return this.store.resume(input); }
}

/** Repo-local development boundary; construction does not create durable state. */
export function createLocalKernelPort(stateRoot: string, clock?: () => Date): LocalKernelPort {
  const root = path.resolve(stateRoot), kernelRoot = path.join(root, "kernel");
  const port = new TrajectaKernelPort(new TrajectaStore(kernelRoot, clock));
  function guard(): void {
    try {
      let ancestor = path.parse(root).root;
      for (const component of root.slice(ancestor.length).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, component);
        let stat;
        try { stat = lstatSync(ancestor); }
        catch (error) { if ((error as { code?: string }).code === "ENOENT") break; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe state ancestry");
      }
      for (const directory of [root, kernelRoot]) {
        try { lstatSync(directory); }
        catch (error) { if ((error as { code?: string }).code === "ENOENT") break; throw error; }
        assertPrivateDirectory(directory);
      }
      for (const name of ["state.json", "deltas.jsonl", "operations.jsonl"]) {
        let stat;
        try { stat = lstatSync(path.join(kernelRoot, name)); }
        catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("Unsafe kernel file");
      }
    } catch { throw betaError("OPERATION_IN_DOUBT", "Kernel state must use private regular files within the declared state root."); }
  }
  function checked<T>(action: () => T): T {
    guard();
    try { return action(); } finally { guard(); }
  }
  return {
    getWork(workId) { return checked(() => port.getWork(workId)); },
    history(workId) { return checked(() => port.history(workId)); },
    resume(input) { return checked(() => port.resume(input)); },
  };
}

/** These exact values are the SDK's kernel WAL identity, including during recovery. */
export function toKernelResumeInput(envelope: LocalResumeEnvelopeV1): ResumeInput {
  return {
    operationId: `${envelope.operationId}.kernel`,
    workId: envelope.packet.work.id,
    expectedRevision: envelope.packet.resume.expectedRevision,
    surface: {
      kind: "local",
      name: "Trajecta Verified Resume SDK Beta",
      session: `local:${canonicalSha256(envelope.target.targetId).slice(0, 32)}`,
    },
    instruction: envelope.packet.work.nextAction ?? undefined,
  };
}
