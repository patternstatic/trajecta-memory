import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { sha256Hex } from "../src/canonical.ts";
import { createDeterministicTgz } from "../src/deterministic-tgz.ts";
import { buildManifest } from "../src/manifest.ts";
import { buildEvaluationReceipt, signReceipt, verifySignedReceipt } from "../src/signing.ts";

const firstKey = generateKeyPairSync("ed25519");
const secondKey = generateKeyPairSync("ed25519");
const firstPrivatePem = firstKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const firstPublicPem = firstKey.publicKey.export({ type: "spki", format: "pem" }).toString();
const secondPrivatePem = secondKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const secondPublicPem = secondKey.publicKey.export({ type: "spki", format: "pem" }).toString();

function payload(path: string, bytes: string, originalClass: "apache-core" | "commercial-beta" | "documentation" | "notice") {
  return { path, bytes: Buffer.from(bytes), originalClass };
}

const releaseInstant = "2026-09-05T00:00:00Z";

function packagePayload() {
  const memberLedger = [
    { path: "LICENSES/CORE-MODIFICATIONS.txt", bytes: 7, sha256: sha256Hex(Buffer.from("notice!")), mode: "0644" as const, originalClass: "notice" as const },
    { path: "beta/DEVELOPMENT-BOUNDARY.md", bytes: 8, sha256: sha256Hex(Buffer.from("boundary")), mode: "0644" as const, originalClass: "documentation" as const },
    { path: "beta/src/cli.ts", bytes: 3, sha256: sha256Hex(Buffer.from("cli")), mode: "0644" as const, originalClass: "commercial-beta" as const },
  ];
  return {
    path: "packages/trajecta-beta-0.1.0.tgz",
    bytes: createDeterministicTgz([{ path: "LICENSES/CORE-MODIFICATIONS.txt", bytes: Buffer.from("notice!"), mode: "0644" as const, originalClass: "notice" as const }, { path: "beta/DEVELOPMENT-BOUNDARY.md", bytes: Buffer.from("boundary"), mode: "0644" as const, originalClass: "documentation" as const }, { path: "beta/src/cli.ts", bytes: Buffer.from("cli"), mode: "0644" as const, originalClass: "commercial-beta" as const }], releaseInstant),
    memberLedger,
  };
}

function signedFixture() {
  const manifest = buildManifest({
    releaseInstant,
    payload: [payload("LICENSE", "Apache", "notice"), packagePayload(), payload("START-HERE.md", "placeholder", "documentation")],
  });
  const receipt = buildEvaluationReceipt({
    buildCommit: "a".repeat(40),
    manifestBytes: manifest.bytes,
    releaseInstant,
    verificationInstant: "2026-09-05T00:00:01Z",
    publicKeyPem: firstPublicPem,
  });
  const signature = signReceipt({ receiptBytes: receipt.bytes, privateKeyPem: firstPrivatePem });
  return { manifest, receipt, signature };
}

test("manifest inventories only payload bytes in canonical lexical order and binds the audited package ledger", () => {
  // Would fail if control files hash themselves, staging insertion order leaked into the receipt, or a tgz ledger could be invented.
  const first = buildManifest({ releaseInstant, payload: [packagePayload(), payload("START-HERE.md", "placeholder", "documentation"), payload("LICENSE", "Apache", "notice")] });
  const second = buildManifest({ releaseInstant, payload: [payload("LICENSE", "Apache", "notice"), payload("START-HERE.md", "placeholder", "documentation"), packagePayload()] });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.at(-1), 10);
  assert.deepEqual(first.value.members.map((member) => member.path), ["LICENSE", "START-HERE.md", "packages/trajecta-beta-0.1.0.tgz"]);
  assert.deepEqual((first.value.members[2].memberLedger as { path: string }[]).map((member) => member.path), packagePayload().memberLedger.map((member) => member.path));
  assert.throws(() => buildManifest({ releaseInstant, payload: [payload("MANIFEST.json", "x", "notice"), packagePayload()] }));
  assert.throws(() => buildManifest({ releaseInstant, payload: [payload("LICENSE", "x", "notice"), { ...packagePayload(), memberLedger: [{ ...packagePayload().memberLedger[0], sha256: "0".repeat(64) }] }] }));
  assert.throws(() => buildManifest({ releaseInstant, payload: [payload("LICENSE", "x", "notice"), { ...packagePayload(), path: "other.tgz" }] }));
});

test("Ed25519 signs exact canonical receipt bytes and independently binds manifest digest and public-key fingerprint", () => {
  // Would fail if verification trusted a receipt-supplied key fingerprint, parsed-but-noncanonical bytes, or an unrelated manifest.
  const { manifest, receipt, signature } = signedFixture();
  const verified = verifySignedReceipt({ receiptBytes: receipt.bytes, signature, manifestBytes: manifest.bytes, publicKeyPem: firstPublicPem, expectedPublicKeyFingerprint: receipt.publicKeyFingerprint });
  assert.equal(verified.manifestSha256, sha256Hex(manifest.bytes));
  assert.equal(receipt.keyId, `ed25519:${receipt.publicKeyFingerprint.slice(0, 16)}`);
  assert.equal(signature.length, 64);
  assert.throws(() => signReceipt({ receiptBytes: receipt.bytes, privateKeyPem: secondPrivatePem }));
  assert.throws(() => verifySignedReceipt({ receiptBytes: Buffer.concat([receipt.bytes.subarray(0, -1), Buffer.from(" ")]), signature, manifestBytes: manifest.bytes, publicKeyPem: firstPublicPem, expectedPublicKeyFingerprint: receipt.publicKeyFingerprint }));
  assert.throws(() => verifySignedReceipt({ receiptBytes: receipt.bytes, signature, manifestBytes: Buffer.from("changed\n"), publicKeyPem: firstPublicPem, expectedPublicKeyFingerprint: receipt.publicKeyFingerprint }));
  assert.throws(() => verifySignedReceipt({ receiptBytes: receipt.bytes, signature, manifestBytes: manifest.bytes, publicKeyPem: secondPublicPem, expectedPublicKeyFingerprint: receipt.publicKeyFingerprint }));
  assert.throws(() => verifySignedReceipt({ receiptBytes: receipt.bytes, signature: Buffer.from(signature.map((value, index) => index === 0 ? value ^ 1 : value)), manifestBytes: manifest.bytes, publicKeyPem: firstPublicPem, expectedPublicKeyFingerprint: receipt.publicKeyFingerprint }));
});

test("receipt has only fixed evaluation claims and signature diagnostics never expose private key bytes", () => {
  // Would fail if release pins, status/count assertions, customer claims, or sensitive PEM bytes could enter receipt/signature handling.
  const manifest = buildManifest({ releaseInstant, payload: [payload("LICENSE", "Apache", "notice"), packagePayload()] });
  assert.throws(() => buildEvaluationReceipt({ buildCommit: "a".repeat(40), manifestBytes: manifest.bytes, releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:01Z", publicKeyPem: firstPublicPem, releasePins: { archiveAudit: "passed" } } as never));
  assert.throws(() => signReceipt({ receiptBytes: Buffer.from("{}\n"), privateKeyPem: "PRIVATE-KEY-DO-NOT-LEAK" }), (error: unknown) => !String(error).includes("PRIVATE-KEY-DO-NOT-LEAK"));
});
