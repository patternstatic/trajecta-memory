import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { canonicalJsonLf, sha256Hex } from "./canonical.ts";
import { parseEvaluationReceipt } from "./contracts.ts";
import { releaseError } from "./errors.ts";
import { publicKeyFingerprint, type EvaluationReceipt } from "../../../packages/trajecta-beta/src/release/signature-verification.ts";
export { publicKeyFingerprint, verifySignedReceipt } from "../../../packages/trajecta-beta/src/release/signature-verification.ts";
export type { EvaluationReceipt } from "../../../packages/trajecta-beta/src/release/signature-verification.ts";

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PEM_BYTES = 16 * 1024;
const SUPPORT_ENVIRONMENT = Object.freeze({
  platform: "macOS", architecture: "Apple Silicon", node: ">=22.19 <23",
  workspace: "one local workspace and one active Trajecta writer", transport: "user-controlled JSON file", outputLanguage: "English",
});
const TEST_SCOPE_IDS = Object.freeze(["release-contracts-v1", "release-source-preflight-v1", "release-stage-layout-v1", "release-tgz-audit-v1", "release-offline-npm-v1", "release-archive-audit-v1", "release-reproducibility-v1"]);
const LIMITATIONS = Object.freeze(["Customer-0-not-run", "not-for-sale", "no-commercial-activation"]);
const SUPPORT_DEFINITION = "30 calendar days of bug-fix builds from purchase and one email thread for installation clarification";

export interface BuiltReceipt {
  value: EvaluationReceipt;
  bytes: Buffer;
  manifestSha256: string;
  publicKeyFingerprint: string;
  keyId: string;
}

function privateEd25519(pem: string): KeyObject {
  if (typeof pem !== "string" || Buffer.byteLength(pem, "utf8") === 0 || Buffer.byteLength(pem, "utf8") > MAX_PEM_BYTES) return releaseError("INVALID_PRIVATE_KEY", "Private signing key is invalid.");
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return releaseError("INVALID_PRIVATE_KEY", "Private signing key is invalid.");
    return key;
  } catch { return releaseError("INVALID_PRIVATE_KEY", "Private signing key is invalid."); }
}

/** Constructs the fixed-scope evaluation receipt from frozen inputs only. */
export function buildEvaluationReceipt(input: { buildCommit: string; manifestBytes: Buffer; releaseInstant: string; verificationInstant: string; publicKeyPem: string }): BuiltReceipt {
  if (!input || Object.keys(input).length !== 5 || !Buffer.isBuffer(input.manifestBytes)) return releaseError("INVALID_RECEIPT", "Receipt inputs are invalid.");
  const fingerprint = publicKeyFingerprint(input.publicKeyPem);
  const keyId = `ed25519:${fingerprint.slice(0, 16)}`;
  const value: EvaluationReceipt = Object.freeze({
    schema: "trajecta.release-integrity-evaluation/v1", product: "Trajecta Verified Resume SDK Beta", version: "0.1.0",
    buildCommit: input.buildCommit, manifestSha256: sha256Hex(input.manifestBytes), supportedEnvironment: SUPPORT_ENVIRONMENT,
    releaseInstant: input.releaseInstant, verificationInstant: input.verificationInstant, testScopeIds: TEST_SCOPE_IDS,
    highestProvenReceiptLevel: "production-local-sdk", limitations: LIMITATIONS, supportDefinition: SUPPORT_DEFINITION, keyId, publicKeyFingerprint: fingerprint,
  });
  parseEvaluationReceipt(value);
  const bytes = canonicalJsonLf(value);
  return Object.freeze({ value, bytes, manifestSha256: value.manifestSha256, publicKeyFingerprint: fingerprint, keyId });
}

export function signReceipt(input: { receiptBytes: Buffer; privateKeyPem: string }): Buffer {
  if (!input || Object.keys(input).length !== 2 || !Buffer.isBuffer(input.receiptBytes) || input.receiptBytes.length === 0 || input.receiptBytes.length > MAX_RECEIPT_BYTES) return releaseError("INVALID_RECEIPT", "Receipt bytes are invalid.");
  const value = parseCanonicalReceipt(input.receiptBytes);
  parseEvaluationReceipt(value);
  const key = privateEd25519(input.privateKeyPem);
  const fingerprint = publicKeyFingerprint(createPublicKey(key).export({ type: "spki", format: "pem" }).toString());
  if (value.publicKeyFingerprint !== fingerprint || value.keyId !== `ed25519:${fingerprint.slice(0, 16)}`) return releaseError("KEY_FINGERPRINT_MISMATCH", "Signing key does not match the receipt seller key.");
  try { return sign(null, input.receiptBytes, key); }
  catch { return releaseError("SIGNATURE_FAILED", "Receipt signature could not be created."); }
}

function parseCanonicalReceipt(bytes: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES || bytes.at(-1) !== 10) return releaseError("INVALID_RECEIPT", "Receipt bytes are invalid.");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { return releaseError("INVALID_RECEIPT", "Receipt bytes are not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !canonicalJsonLf(value).equals(bytes)) return releaseError("INVALID_RECEIPT", "Receipt bytes are not canonical.");
  return value as Record<string, unknown>;
}
