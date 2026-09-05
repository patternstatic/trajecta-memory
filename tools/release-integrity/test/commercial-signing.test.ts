import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { canonicalJsonLf } from "../src/canonical.ts";
import { parseCommercialCandidateReceipt, parseEvaluationReceipt, parseReleaseReceipt } from "../src/contracts.ts";
import { buildCommercialCandidateReceipt, buildEvaluationReceipt, signReceipt, verifySignedReceipt } from "../src/signing.ts";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const input = { buildCommit: "a".repeat(40), manifestBytes: Buffer.from("{}\n"), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:01Z", publicKeyPem };

test("candidate receipt round-trips its original signed bytes without becoming evaluation", () => {
  // Catches schema normalization leaking into the signed bytes or evaluation acceptance.
  const built = buildCommercialCandidateReceipt(input);
  assert.equal(built.value.schema, "trajecta.release-integrity-commercial-candidate/v1");
  assert.deepEqual(built.value.limitations, ["Customer-0-not-run", "commercial-activation-pending", "no-remote-task-completion-claim"]);
  assert.throws(() => parseEvaluationReceipt(built.value));
  assert.doesNotThrow(() => parseCommercialCandidateReceipt(built.value));
  const before = canonicalJsonLf(built.value);
  parseReleaseReceipt(built.value);
  assert.deepEqual(canonicalJsonLf(built.value), before);
  const signature = signReceipt({ receiptBytes: built.bytes, privateKeyPem });
  assert.ok(verify(null, built.bytes, keys.publicKey, signature));
  assert.deepEqual(verifySignedReceipt({ receiptBytes: built.bytes, signature, manifestBytes: input.manifestBytes, publicKeyPem, expectedPublicKeyFingerprint: built.publicKeyFingerprint }), built.value);
  assert.deepEqual(buildCommercialCandidateReceipt(input).bytes, built.bytes);
});

test("candidate dispatcher rejects altered claims, unknown schemas and malformed inputs", () => {
  // Catches a dispatcher that relaxes candidate fields while normalizing validation.
  const built = buildCommercialCandidateReceipt(input);
  for (const patch of [
    { limitations: ["ready-for-sale"] }, { limitations: ["Customer-0-not-run", "no-remote-task-completion-claim", "commercial-activation-pending"] },
    { extra: true }, { schema: "unknown/v1" }, { supportDefinition: "lifetime support" },
    { highestProvenReceiptLevel: "remote-task-completion" }, { buildCommit: "unknown" },
    { testScopeIds: [] }, { supportedEnvironment: { ...built.value.supportedEnvironment, platform: "Linux" } },
    { releaseInstant: "2026-09-05T00:00:01Z" }, { verificationInstant: "yesterday" },
  ]) {
    const value = { ...built.value, ...patch };
    assert.throws(() => parseReleaseReceipt(value));
    assert.throws(() => signReceipt({ receiptBytes: canonicalJsonLf(value), privateKeyPem }));
  }
  for (const value of [null, undefined, [], "candidate", {}, { schema: "unknown/v1" }]) assert.throws(() => parseReleaseReceipt(value), { code: "INVALID_RECEIPT" });
  assert.throws(() => buildCommercialCandidateReceipt({ ...input, extra: true } as never));
});

test("candidate verification binds schema, manifest and independently pinned key", () => {
  // Catches signatures checked over a normalized copy or trust taken from the receipt.
  const built = buildCommercialCandidateReceipt(input);
  const signature = signReceipt({ receiptBytes: built.bytes, privateKeyPem });
  const verification = { receiptBytes: built.bytes, signature, manifestBytes: input.manifestBytes, publicKeyPem, expectedPublicKeyFingerprint: built.publicKeyFingerprint };
  const evaluation = buildEvaluationReceipt(input);
  assert.throws(() => verifySignedReceipt({ ...verification, receiptBytes: evaluation.bytes }), { code: "SIGNATURE_INVALID" });
  assert.throws(() => verifySignedReceipt({ ...verification, manifestBytes: Buffer.from("changed\n") }), { code: "MANIFEST_MISMATCH" });
  assert.throws(() => verifySignedReceipt({ ...verification, expectedPublicKeyFingerprint: "0".repeat(64) }), { code: "KEY_FINGERPRINT_MISMATCH" });
  const other = generateKeyPairSync("ed25519");
  assert.throws(() => verifySignedReceipt({ ...verification, publicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString() }), { code: "KEY_FINGERPRINT_MISMATCH" });
  assert.throws(() => signReceipt({ receiptBytes: built.bytes, privateKeyPem: other.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }), { code: "KEY_FINGERPRINT_MISMATCH" });
  assert.throws(() => verifySignedReceipt({ ...verification, receiptBytes: Buffer.concat([built.bytes, Buffer.from("\n")]) }), { code: "INVALID_RECEIPT" });
});

test("evaluation remains independently accepted with its original limitations", () => {
  // Catches candidate support widening or replacing the evaluation contract.
  const built = buildEvaluationReceipt(input);
  assert.deepEqual(built.value.limitations, ["Customer-0-not-run", "not-for-sale", "no-commercial-activation"]);
  assert.doesNotThrow(() => parseEvaluationReceipt(built.value));
  assert.doesNotThrow(() => parseReleaseReceipt(built.value));
  assert.throws(() => parseCommercialCandidateReceipt(built.value));
  const signature = signReceipt({ receiptBytes: built.bytes, privateKeyPem });
  assert.equal(verifySignedReceipt({ receiptBytes: built.bytes, signature, manifestBytes: input.manifestBytes, publicKeyPem, expectedPublicKeyFingerprint: built.publicKeyFingerprint }).schema, "trajecta.release-integrity-evaluation/v1");
});
