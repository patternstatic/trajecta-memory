import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJsonLf, sha256Hex } from "./canonical.ts";
import { parseEvaluationReceipt } from "./contracts.ts";
import { releaseError } from "./errors.ts";

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PEM_BYTES = 16 * 1024;
const SUPPORT_ENVIRONMENT = Object.freeze({
  platform: "macOS", architecture: "Apple Silicon", node: ">=22.19 <23",
  workspace: "one local workspace and one active Trajecta writer", transport: "user-controlled JSON file", outputLanguage: "English",
});
const TEST_SCOPE_IDS = Object.freeze(["release-contracts-v1", "release-source-preflight-v1", "release-stage-layout-v1", "release-tgz-audit-v1", "release-offline-npm-v1", "release-archive-audit-v1", "release-reproducibility-v1"]);
const LIMITATIONS = Object.freeze(["Customer-0-not-run", "not-for-sale", "no-commercial-activation"]);
const SUPPORT_DEFINITION = "30 calendar days of bug-fix builds from purchase and one email thread for installation clarification";

export interface EvaluationReceipt {
  schema: "trajecta.release-integrity-evaluation/v1";
  product: "Trajecta Verified Resume SDK Beta";
  version: "0.1.0";
  buildCommit: string;
  manifestSha256: string;
  supportedEnvironment: typeof SUPPORT_ENVIRONMENT;
  releaseInstant: string;
  verificationInstant: string;
  testScopeIds: readonly string[];
  highestProvenReceiptLevel: "production-local-sdk";
  limitations: readonly string[];
  supportDefinition: typeof SUPPORT_DEFINITION;
  keyId: string;
  publicKeyFingerprint: string;
}

export interface BuiltReceipt {
  value: EvaluationReceipt;
  bytes: Buffer;
  manifestSha256: string;
  publicKeyFingerprint: string;
  keyId: string;
}

function publicEd25519(pem: string): KeyObject {
  if (typeof pem !== "string" || Buffer.byteLength(pem, "utf8") === 0 || Buffer.byteLength(pem, "utf8") > MAX_PEM_BYTES) return releaseError("INVALID_PUBLIC_KEY", "Public key input is invalid.");
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return releaseError("INVALID_PUBLIC_KEY", "Public key must be Ed25519.");
    return key;
  } catch { return releaseError("INVALID_PUBLIC_KEY", "Public key input is invalid."); }
}

function privateEd25519(pem: string): KeyObject {
  if (typeof pem !== "string" || Buffer.byteLength(pem, "utf8") === 0 || Buffer.byteLength(pem, "utf8") > MAX_PEM_BYTES) return releaseError("INVALID_PRIVATE_KEY", "Private signing key is invalid.");
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return releaseError("INVALID_PRIVATE_KEY", "Private signing key is invalid.");
    return key;
  } catch { return releaseError("INVALID_PRIVATE_KEY", "Private signing key is invalid."); }
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  const key = publicEd25519(publicKeyPem);
  return fingerprintKey(key);
}

function fingerprintKey(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
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
  const fingerprint = fingerprintKey(createPublicKey(key));
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

/** Validates an exact signed receipt against independently supplied trust and manifest inputs. */
export function verifySignedReceipt(input: { receiptBytes: Buffer; signature: Buffer; manifestBytes: Buffer; publicKeyPem: string; expectedPublicKeyFingerprint: string }): EvaluationReceipt {
  if (!input || Object.keys(input).length !== 5 || !Buffer.isBuffer(input.signature) || input.signature.length !== 64 || !Buffer.isBuffer(input.manifestBytes)) return releaseError("INVALID_SIGNATURE", "Signature verification inputs are invalid.");
  const receipt = parseCanonicalReceipt(input.receiptBytes);
  parseEvaluationReceipt(receipt);
  const fingerprint = publicKeyFingerprint(input.publicKeyPem);
  if (typeof input.expectedPublicKeyFingerprint !== "string" || input.expectedPublicKeyFingerprint !== fingerprint || receipt.publicKeyFingerprint !== fingerprint || receipt.keyId !== `ed25519:${fingerprint.slice(0, 16)}`) return releaseError("KEY_FINGERPRINT_MISMATCH", "Supplied seller key does not match the pinned fingerprint.");
  if (receipt.manifestSha256 !== sha256Hex(input.manifestBytes)) return releaseError("MANIFEST_MISMATCH", "Receipt does not bind the supplied manifest.");
  try {
    if (!verify(null, input.receiptBytes, publicEd25519(input.publicKeyPem), input.signature)) return releaseError("SIGNATURE_INVALID", "Receipt signature is invalid.");
  } catch (error) {
    if (error instanceof Error && error.name === "ReleaseIntegrityError") throw error;
    return releaseError("SIGNATURE_INVALID", "Receipt signature is invalid.");
  }
  return Object.freeze(receipt as EvaluationReceipt);
}
