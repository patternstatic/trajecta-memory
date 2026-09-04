import type { BetaErrorCode } from "../src/errors.ts";
import { BetaError } from "../src/errors.ts";
import type { LocalResumeEnvelopeV1, LocalWorkspaceTargetCardV1 } from "../src/contracts.ts";
import type { TransferPacket } from "../../../src/types.ts";

const fixedCreatedAt = "2026-09-05T00:00:00.000Z";
const fixedExpiresAt = "2026-09-06T00:00:00.000Z";

export function errorCode(code: BetaErrorCode) {
  return (error: unknown) => error instanceof BetaError && error.code === code;
}

export function finalizePacketBudget(packet: TransferPacket): TransferPacket {
  let previous = -1;
  packet.budget.usedBytes = 0;
  while (packet.budget.usedBytes !== previous) {
    previous = packet.budget.usedBytes;
    packet.budget.usedBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  }
  return packet;
}

export function validTransferPacket(): TransferPacket {
  return finalizePacketBudget({
    schema: "trajecta.transfer/v1",
    packetId: "packet:fixture",
    createdAt: fixedCreatedAt,
    cue: "resume the fixture work locally",
    from: { kind: "cloud", name: "ChatGPT fixture", session: "cloud:fixture" },
    intendedFor: "local",
    work: {
      id: "work:fixture",
      topic: "Fixture handoff",
      goal: "Validate the local resume envelope",
      instruction: "Inspect the packet before resuming.",
      status: "active",
      revision: 7,
      openLoops: ["Run envelope validation"],
      nextAction: "Verify the exact local target.",
    },
    activeBranch: {
      id: "branch:fixture",
      label: "local-envelope",
      purpose: "Prove one bounded local resume contract.",
      cues: ["local", "envelope"],
      returnPoint: "Return with an inspection receipt.",
      status: "exploring",
      updatedAt: fixedCreatedAt,
    },
    recentDeltas: [{
      id: "delta:fixture",
      revision: 7,
      kind: "handoff",
      summary: "Prepared the local resume envelope fixture.",
      provenance: ["artifact:fixture", "decision:fixture"],
      createdAt: fixedCreatedAt,
    }],
    contractAnchor: {
      id: "anchor:fixture",
      contractVersion: 1,
      summary: "Fixture transfer contract anchor.",
      provenance: ["artifact:fixture"],
      createdAt: fixedCreatedAt,
    },
    resume: { expectedRevision: 7, rule: "Resume only if the revision still matches." },
    budget: { maxBytes: 6_000, usedBytes: 0, truncated: false },
  });
}

export function validTargetCard(): LocalWorkspaceTargetCardV1 {
  return {
    schema: "trajecta.local-target/v1",
    targetId: "target:fixture",
    capability: "capability:fixture",
    createdAt: fixedCreatedAt,
    expiresAt: fixedExpiresAt,
    registryFingerprint: "a".repeat(64),
    workspace: {
      repository: "example.invalid/patternstatic/trajecta-memory",
      repositoryFingerprint: "b".repeat(64),
      stateRootFingerprint: "c".repeat(64),
      branch: "main",
    },
  };
}

export function validEnvelopeInput(): Omit<LocalResumeEnvelopeV1, "integrity"> {
  return {
    schema: "trajecta.local-resume-envelope/v1",
    envelopeId: "envelope:fixture",
    operationId: "operation:fixture",
    createdAt: fixedCreatedAt,
    expiresAt: fixedExpiresAt,
    target: validTargetCard(),
    packet: validTransferPacket(),
  };
}
