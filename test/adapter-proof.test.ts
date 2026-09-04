import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertResumeAttempt,
  digestResumeAttempt,
  OperationConflict,
  ResumeAttemptLedger,
  stableSerialize,
} from "../src/index.ts";
import type { ResumeAttemptReceiptV1 } from "../src/index.ts";

test("proof digest is independent of object insertion order", () => {
  const left = { z: 1, nested: { b: true, a: "x" }, list: [2, 1] };
  const right = { list: [2, 1], nested: { a: "x", b: true }, z: 1 };
  assert.equal(stableSerialize(left), stableSerialize(right));
});

test("proof digest changes when a material attempt field changes", () => {
  const base = {
    schema: "trajecta.resume-attempt/v1" as const,
    operationId: "operation:proof-attempt",
    packet: { schema: "trajecta.transfer/v1" },
    target: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    expectedTarget: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    acceptedByUser: true,
  };
  assert.notEqual(digestResumeAttempt(base as never), digestResumeAttempt({ ...base, acceptedByUser: false } as never));
});

test("attempt validation rejects unsupported schemas and unbounded fields", () => {
  assert.throws(() => assertResumeAttempt({ schema: "wrong" } as never), /attempt schema/i);
  assert.throws(() => assertResumeAttempt({
    schema: "trajecta.resume-attempt/v1",
    operationId: `operation:${"x".repeat(300)}`,
    packet: { schema: "trajecta.transfer/v1" },
    target: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    expectedTarget: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    acceptedByUser: true,
  } as never), /operation/i);
});

function receipt(overrides: Partial<ResumeAttemptReceiptV1> = {}): ResumeAttemptReceiptV1 {
  return {
    schema: "trajecta.resume-attempt-receipt/v1",
    receiptId: "receipt:proof-one",
    operationId: "operation:proof-one",
    attemptDigest: "a".repeat(64),
    outcome: "rejected",
    code: "REVISION_CONFLICT",
    workId: "work:proof",
    branchId: "branch:proof",
    packetId: "packet:proof",
    target: { surface: "local", name: "Codex", session: "local:proof" },
    expectedRevision: 2,
    observedRevisionBefore: 3,
    observedRevisionAfter: 3,
    provenance: ["artifact:proof-contract-v1"],
    evidence: ["test:adapter-proof"],
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("attempt ledger returns one committed receipt for equivalent replay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-ledger-"));
  try {
    const ledger = new ResumeAttemptLedger(root);
    const first = receipt();
    assert.deepEqual(ledger.commit(first), first);
    assert.deepEqual(ledger.replay(first.operationId, first.attemptDigest), first);
    assert.deepEqual(ledger.commit(first), first);
    assert.equal(ledger.history().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("attempt ledger rejects altered operation reuse without appending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-ledger-"));
  try {
    const ledger = new ResumeAttemptLedger(root);
    ledger.commit(receipt());
    assert.throws(() => ledger.replay("operation:proof-one", "b".repeat(64)), OperationConflict);
    assert.equal(ledger.history().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
