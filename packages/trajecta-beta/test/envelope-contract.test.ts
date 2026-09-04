import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEnvelopeFresh,
  assertLocalResumeEnvelope,
  attemptDigest,
  buildLocalResumeEnvelope,
  captureLocalResumeEnvelopeFile,
  deriveLocalResumeReceiptReferences,
  readLocalResumeEnvelopeBytes,
} from "../src/index.ts";
import { assertTransferPacket } from "../../../src/index.ts";
import { stableSerialize } from "../../../src/adapters/proof/attempt-contract.ts";
import { errorCode, finalizePacketBudget, validEnvelopeInput } from "./helpers.ts";

test("one material envelope byte change fails integrity", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  const changed = structuredClone(envelope);
  changed.packet.work.goal = "altered";
  assert.throws(() => assertLocalResumeEnvelope(changed), errorCode("INTEGRITY_MISMATCH"));
});

test("attempt digest is exactly the verified canonical payload digest", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  assertLocalResumeEnvelope(envelope);
  assert.equal(attemptDigest(envelope), envelope.integrity.canonicalPayloadDigest);
});

test("envelope parser returns a defensive clone from one captured byte buffer", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  const parsed = readLocalResumeEnvelopeBytes(bytes);
  parsed.packet.work.goal = "mutated caller copy";
  assert.equal(envelope.packet.work.goal, "Validate the local resume envelope");
  assert.equal(parsed.integrity.canonicalPayloadDigest, envelope.integrity.canonicalPayloadDigest);
});

test("capture reads a regular envelope file once and returns its exact captured bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-envelope-"));
  const file = path.join(root, "resume.json");
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  const expected = Buffer.from(JSON.stringify(envelope), "utf8");
  fs.writeFileSync(file, expected);
  try {
    const captured = captureLocalResumeEnvelopeFile(file);
    assert.deepEqual(captured.bytes, expected);
    assert.deepEqual(captured.envelope, envelope);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("envelope validation rejects unsupported schemas, malformed digests, and unbounded outer strings", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  assert.throws(
    () => assertLocalResumeEnvelope({ ...envelope, schema: "wrong" } as never),
    errorCode("UNSUPPORTED_SCHEMA"),
  );
  assert.throws(
    () => assertLocalResumeEnvelope({ ...envelope, integrity: { ...envelope.integrity, canonicalPayloadDigest: "A".repeat(64) } }),
    errorCode("INTEGRITY_MISMATCH"),
  );
  const unbounded = structuredClone(envelope);
  unbounded.target.targetId = `target:${"x".repeat(241)}`;
  unbounded.integrity.canonicalPayloadDigest = "0".repeat(64);
  assert.throws(() => assertLocalResumeEnvelope(unbounded), errorCode("UNSUPPORTED_SCHEMA"));
});

test("envelope validation rejects non-local and missing-branch packets before integrity acceptance", () => {
  const nonLocalInput = validEnvelopeInput();
  nonLocalInput.packet.intendedFor = "cloud";
  finalizePacketBudget(nonLocalInput.packet);
  assert.throws(
    () => assertLocalResumeEnvelope(buildLocalResumeEnvelope(nonLocalInput)),
    errorCode("TARGET_MISMATCH"),
  );

  const branchlessInput = validEnvelopeInput();
  delete (branchlessInput.packet as unknown as Record<string, unknown>).activeBranch;
  finalizePacketBudget(branchlessInput.packet);
  assert.throws(
    () => assertLocalResumeEnvelope(buildLocalResumeEnvelope(branchlessInput)),
    errorCode("BRANCH_MISMATCH"),
  );
});

test("envelope validation rejects packet evidence bounds and a packet over 6000 bytes", () => {
  const tooManyProvenance = validEnvelopeInput();
  tooManyProvenance.packet.recentDeltas[0]!.provenance = Array.from({ length: 21 }, (_, index) => `artifact:${index}`);
  finalizePacketBudget(tooManyProvenance.packet);
  assert.throws(
    () => assertLocalResumeEnvelope(buildLocalResumeEnvelope(tooManyProvenance)),
    errorCode("UNSUPPORTED_SCHEMA"),
  );

  const overBudget = validEnvelopeInput();
  (overBudget.packet as unknown as Record<string, unknown>).padding = "x".repeat(6_000);
  finalizePacketBudget(overBudget.packet);
  assert.throws(
    () => assertLocalResumeEnvelope(buildLocalResumeEnvelope(overBudget)),
    errorCode("UNSUPPORTED_SCHEMA"),
  );
});

test("envelope validation rejects aggregate receipt provenance above twenty unique IDs", () => {
  const input = validEnvelopeInput();
  const first = structuredClone(input.packet.recentDeltas[0]!);
  first.id = "delta:aggregate-one";
  first.provenance = Array.from({ length: 11 }, (_, index) => `artifact:aggregate-${index}`);
  const second = structuredClone(first);
  second.id = "delta:aggregate-two";
  second.provenance = Array.from({ length: 11 }, (_, index) => `artifact:aggregate-${index + 11}`);
  input.packet.recentDeltas = [first, second];
  finalizePacketBudget(input.packet);

  assert.throws(
    () => deriveLocalResumeReceiptReferences(input.packet),
    errorCode("UNSUPPORTED_SCHEMA"),
  );
  assert.throws(
    () => assertLocalResumeEnvelope(buildLocalResumeEnvelope(input)),
    errorCode("UNSUPPORTED_SCHEMA"),
  );
});

test("receipt-reference derivation rejects aggregate evidence above twenty unique IDs", () => {
  const packet = validEnvelopeInput().packet;
  const delta = structuredClone(packet.recentDeltas[0]!);
  packet.recentDeltas = Array.from({ length: 21 }, (_, index) => ({
    ...structuredClone(delta),
    id: `delta:evidence-${index}`,
  }));
  assert.throws(
    () => deriveLocalResumeReceiptReferences(packet),
    errorCode("UNSUPPORTED_SCHEMA"),
  );
});

test("expiry is a separate live check after committed-envelope validation", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  assertLocalResumeEnvelope(envelope);
  assert.throws(
    () => assertEnvelopeFresh(envelope, new Date("2026-09-06T00:00:00.000Z")),
    errorCode("TARGET_EXPIRED"),
  );
});

test("legacy proof serialization uses code-unit key ordering", () => {
  assert.equal(stableSerialize({ "ä": 1, z: 2 }), '{"z":2,"ä":1}');
});

test("main SDK exports the reusable transfer-packet validator", () => {
  assert.doesNotThrow(() => assertTransferPacket(validEnvelopeInput().packet));
});
