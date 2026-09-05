import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { canonicalJsonLf, sha256Hex } from "./canonical.ts";
import { parseReleaseReceipt } from "./contracts.ts";
import { releaseError } from "./errors.ts";

const MAX_RECEIPT_BYTES = 64 * 1024;
export const MAX_PUBLIC_KEY_BYTES = 16 * 1024;

export interface EvaluationReceipt {
  schema: "trajecta.release-integrity-evaluation/v1";
  product: "Trajecta Verified Resume SDK Beta";
  version: "0.1.0";
  buildCommit: string;
  manifestSha256: string;
  supportedEnvironment: {
    platform: "macOS";
    architecture: "Apple Silicon";
    node: ">=22.19 <23";
    workspace: "one local workspace and one active Trajecta writer";
    transport: "user-controlled JSON file";
    outputLanguage: "English";
  };
  releaseInstant: string;
  verificationInstant: string;
  testScopeIds: readonly string[];
  highestProvenReceiptLevel: "production-local-sdk";
  limitations: readonly string[];
  supportDefinition: string;
  keyId: string;
  publicKeyFingerprint: string;
}

export type CommercialCandidateReceipt = Omit<EvaluationReceipt, "schema"> & {
  schema: "trajecta.release-integrity-commercial-candidate/v1";
};
export type ReleaseReceipt = EvaluationReceipt | CommercialCandidateReceipt;

function publicEd25519(pem: string): KeyObject {
  if (typeof pem !== "string" || Buffer.byteLength(pem, "utf8") === 0 || Buffer.byteLength(pem, "utf8") > MAX_PUBLIC_KEY_BYTES) return releaseError("INVALID_PUBLIC_KEY", "Public key input is invalid.");
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return releaseError("INVALID_PUBLIC_KEY", "Public key must be Ed25519.");
    return key;
  } catch { return releaseError("INVALID_PUBLIC_KEY", "Public key input is invalid."); }
}

function fingerprintKey(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  return fingerprintKey(publicEd25519(publicKeyPem));
}

function parseCanonicalReceipt(bytes: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES || bytes.at(-1) !== 10) return releaseError("INVALID_RECEIPT", "Receipt bytes are invalid.");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { return releaseError("INVALID_RECEIPT", "Receipt bytes are not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !canonicalJsonLf(value).equals(bytes)) return releaseError("INVALID_RECEIPT", "Receipt bytes are not canonical.");
  return value as Record<string, unknown>;
}

/** Validates exact signed receipt bytes against independently supplied trust and manifest inputs. */
export function verifySignedReceipt(input: { receiptBytes: Buffer; signature: Buffer; manifestBytes: Buffer; publicKeyPem: string; expectedPublicKeyFingerprint: string }): ReleaseReceipt {
  if (!input || Object.keys(input).length !== 5 || !Buffer.isBuffer(input.signature) || input.signature.length !== 64 || !Buffer.isBuffer(input.manifestBytes)) return releaseError("INVALID_SIGNATURE", "Signature verification inputs are invalid.");
  const receipt = parseCanonicalReceipt(input.receiptBytes);
  parseReleaseReceipt(receipt);
  const fingerprint = publicKeyFingerprint(input.publicKeyPem);
  if (typeof input.expectedPublicKeyFingerprint !== "string" || input.expectedPublicKeyFingerprint !== fingerprint || receipt.publicKeyFingerprint !== fingerprint || receipt.keyId !== `ed25519:${fingerprint.slice(0, 16)}`) return releaseError("KEY_FINGERPRINT_MISMATCH", "Supplied seller key does not match the pinned fingerprint.");
  if (receipt.manifestSha256 !== sha256Hex(input.manifestBytes)) return releaseError("MANIFEST_MISMATCH", "Receipt does not bind the supplied manifest.");
  try {
    if (!verify(null, input.receiptBytes, publicEd25519(input.publicKeyPem), input.signature)) return releaseError("SIGNATURE_INVALID", "Receipt signature is invalid.");
  } catch (error) {
    if (error instanceof Error && error.name === "ReleaseIntegrityError") throw error;
    return releaseError("SIGNATURE_INVALID", "Receipt signature is invalid.");
  }
  return Object.freeze(receipt as unknown as ReleaseReceipt);
}
