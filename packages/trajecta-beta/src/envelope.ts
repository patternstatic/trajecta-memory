import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { assertTransferPacket } from "../../../src/adapters/proof/attempt-contract.ts";
import type { TransferPacket } from "../../../src/types.ts";
import { canonicalSha256 } from "./canonical.ts";
import type { LocalResumeEnvelopeV1, LocalWorkspaceTargetCardV1 } from "./contracts.ts";
import { BetaError, betaError } from "./errors.ts";
import { MAX_ENVELOPE_BYTES, parseStrictJsonBytes } from "./strict-json.ts";

const OPAQUE_ID = /^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function unsupported(message: string): never {
  throw betaError("UNSUPPORTED_SCHEMA", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, label: string, keys: readonly string[]) {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    unsupported(`${label} has unsupported fields.`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    unsupported(`${label} is required and must not exceed ${maximum} characters.`);
  }
}

function opaqueId(value: unknown, label: string) {
  boundedString(value, label, 240);
  if (!OPAQUE_ID.test(value)) unsupported(`${label} must be a namespaced opaque ID.`);
}

function timestamp(value: unknown, label: string) {
  boundedString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    unsupported(`${label} must be a valid ISO timestamp.`);
  }
}

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw betaError("INTEGRITY_MISMATCH", `${label} must be exactly 64 lowercase hexadecimal characters.`);
  }
}

function assertTarget(target: unknown): asserts target is LocalWorkspaceTargetCardV1 {
  const candidate = record(target, "Target card");
  exactKeys(candidate, "Target card", ["schema", "targetId", "capability", "createdAt", "expiresAt", "registryFingerprint", "workspace"]);
  if (candidate.schema !== "trajecta.local-target/v1") unsupported("Unsupported local target schema.");
  opaqueId(candidate.targetId, "Target ID");
  opaqueId(candidate.capability, "Target capability");
  timestamp(candidate.createdAt, "Target creation timestamp");
  timestamp(candidate.expiresAt, "Target expiry timestamp");
  digest(candidate.registryFingerprint, "Target registry fingerprint");

  const workspace = record(candidate.workspace, "Target workspace");
  exactKeys(workspace, "Target workspace", ["repository", "repositoryFingerprint", "stateRootFingerprint", "branch"]);
  boundedString(workspace.repository, "Target repository", 240);
  digest(workspace.repositoryFingerprint, "Repository fingerprint");
  digest(workspace.stateRootFingerprint, "State-root fingerprint");
  boundedString(workspace.branch, "Target branch", 240);
}

function assertPacket(packet: unknown): asserts packet is TransferPacket {
  if (packet && typeof packet === "object" && !Array.isArray(packet) && (packet as { activeBranch?: unknown }).activeBranch == null) {
    throw betaError("BRANCH_MISMATCH", "Local resume envelopes require an active branch.");
  }
  try {
    assertTransferPacket(packet);
  } catch {
    unsupported("Transfer packet does not satisfy the bounded proof contract.");
  }
  if (packet.intendedFor !== "local") throw betaError("TARGET_MISMATCH", "Local resume envelopes require a packet intended for local use.");
  if (packet.activeBranch === null) throw betaError("BRANCH_MISMATCH", "Local resume envelopes require an active branch.");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function assertReceiptReferences(values: readonly string[], label: string) {
  if (values.length > 20) unsupported(`${label} must contain at most 20 unique values.`);
  values.forEach((value, index) => opaqueId(value, `${label} ${index + 1}`));
}

export function deriveLocalResumeReceiptReferences(packet: Pick<TransferPacket, "recentDeltas">): {
  provenance: string[];
  evidence: string[];
} {
  const references = {
    provenance: sortedUnique(packet.recentDeltas.flatMap((delta) => delta.provenance)),
    evidence: sortedUnique(packet.recentDeltas.map((delta) => delta.id)),
  };
  assertReceiptReferences(references.provenance, "Receipt provenance");
  assertReceiptReferences(references.evidence, "Receipt evidence");
  return references;
}

export function envelopePayload(envelope: LocalResumeEnvelopeV1): Omit<LocalResumeEnvelopeV1, "integrity"> {
  const { integrity: _integrity, ...payload } = envelope;
  return payload;
}

export function buildLocalResumeEnvelope(
  input: Omit<LocalResumeEnvelopeV1, "integrity">,
): LocalResumeEnvelopeV1 {
  return {
    ...structuredClone(input),
    integrity: {
      algorithm: "sha256",
      canonicalPayloadDigest: canonicalSha256(input),
    },
  };
}

export function assertLocalResumeEnvelope(envelope: unknown): asserts envelope is LocalResumeEnvelopeV1 {
  const candidate = record(envelope, "Local resume envelope");
  exactKeys(candidate, "Local resume envelope", ["schema", "envelopeId", "operationId", "createdAt", "expiresAt", "target", "packet", "integrity"]);
  if (candidate.schema !== "trajecta.local-resume-envelope/v1") unsupported("Unsupported local resume envelope schema.");
  opaqueId(candidate.envelopeId, "Envelope ID");
  opaqueId(candidate.operationId, "Operation ID");
  timestamp(candidate.createdAt, "Envelope creation timestamp");
  timestamp(candidate.expiresAt, "Envelope expiry timestamp");
  assertTarget(candidate.target);

  const integrity = record(candidate.integrity, "Envelope integrity");
  exactKeys(integrity, "Envelope integrity", ["algorithm", "canonicalPayloadDigest"]);
  if (integrity.algorithm !== "sha256") throw betaError("INTEGRITY_MISMATCH", "Envelope integrity algorithm must be sha256.");
  digest(integrity.canonicalPayloadDigest, "Envelope canonical payload digest");

  const expected = Buffer.from(canonicalSha256(envelopePayload(candidate as LocalResumeEnvelopeV1)), "utf8");
  const actual = Buffer.from(integrity.canonicalPayloadDigest, "utf8");
  if (!timingSafeEqual(actual, expected)) throw betaError("INTEGRITY_MISMATCH", "Envelope canonical payload digest does not match the captured payload.");
  assertPacket(candidate.packet);
  deriveLocalResumeReceiptReferences(candidate.packet);
}

export function assertEnvelopeFresh(envelope: LocalResumeEnvelopeV1, now: Date): void {
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds) || Date.parse(envelope.expiresAt) <= nowMilliseconds || Date.parse(envelope.target.expiresAt) <= nowMilliseconds) {
    throw betaError("TARGET_EXPIRED", "The local resume envelope or target card has expired.");
  }
}

export function attemptDigest(envelope: LocalResumeEnvelopeV1): string {
  return envelope.integrity.canonicalPayloadDigest;
}

export function readLocalResumeEnvelopeBytes(bytes: Uint8Array): LocalResumeEnvelopeV1 {
  const parsed = parseStrictJsonBytes(bytes);
  assertLocalResumeEnvelope(parsed);
  return structuredClone(parsed);
}

export function captureLocalResumeEnvelopeFile(file: string): { bytes: Buffer; envelope: LocalResumeEnvelopeV1 } {
  let descriptor = -1;
  let failure: unknown;
  let bytes: Buffer | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) throw betaError("INVALID_JSON", "The envelope input is not a regular file.");
    const buffer = Buffer.allocUnsafe(MAX_ENVELOPE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_ENVELOPE_BYTES) throw betaError("FILE_TOO_LARGE", `JSON input exceeds the ${MAX_ENVELOPE_BYTES}-byte maximum.`);
    bytes = Buffer.from(buffer.subarray(0, offset));
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }
  if (failure !== undefined || !bytes) {
    if (failure instanceof BetaError) throw failure;
    throw betaError("INVALID_JSON", "Unable to read the local resume envelope file.");
  }
  return { bytes, envelope: readLocalResumeEnvelopeBytes(bytes) };
}
