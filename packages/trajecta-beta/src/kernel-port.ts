import type { TrajectaStore } from "../../../src/store.ts";
import type { Delta, WorkItem } from "../../../src/types.ts";
import { canonicalSha256 } from "./canonical.ts";
import type { LocalResumeEnvelopeV1 } from "./contracts.ts";

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
