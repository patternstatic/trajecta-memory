export type BetaErrorCode =
  | "UNSUPPORTED_ENVIRONMENT"
  | "ARCHIVE_INCOMPLETE"
  | "MANIFEST_MISMATCH"
  | "TARGET_EXPIRED"
  | "TARGET_CONSUMED"
  | "TARGET_MISMATCH"
  | "INTEGRITY_MISMATCH"
  | "BRANCH_MISMATCH"
  | "REVISION_CONFLICT"
  | "WORKSPACE_MISMATCH"
  | "REVISION_MISMATCH"
  | "USER_ACCEPTANCE_REQUIRED"
  | "OPERATION_IN_DOUBT"
  | "CAPABILITY_UNAVAILABLE"
  | "FILE_TOO_LARGE"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "DUPLICATE_KEY"
  | "JSON_TOO_DEEP"
  | "UNSUPPORTED_SCHEMA"
  | "OPERATION_CONFLICT";

export class BetaError extends Error {
  readonly code: BetaErrorCode;
  readonly nextAction: string;

  constructor(
    code: BetaErrorCode,
    message: string,
    nextAction: string,
  ) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
    this.name = "BetaError";
  }
}

export const defaultNextAction: Record<BetaErrorCode, string> = {
  UNSUPPORTED_ENVIRONMENT: "Use the supported macOS and Node.js combination.",
  ARCHIVE_INCOMPLETE: "Download the release again.",
  MANIFEST_MISMATCH: "Stop and obtain a verified archive.",
  TARGET_EXPIRED: "Create a new target card.",
  TARGET_CONSUMED: "Create a new target card.",
  TARGET_MISMATCH: "Use the exact target and work identifiers from the card.",
  INTEGRITY_MISMATCH: "Regenerate the handoff file.",
  BRANCH_MISMATCH: "Return to the exact paired branch.",
  REVISION_CONFLICT: "Inspect current work and export a fresh packet.",
  WORKSPACE_MISMATCH: "Use the workspace named by the target card.",
  REVISION_MISMATCH: "Refresh the target and review the current revision.",
  USER_ACCEPTANCE_REQUIRED: "Explicitly confirm before retrying; no mutation occurred.",
  OPERATION_IN_DOUBT: "Inspect durable operation state before retrying.",
  CAPABILITY_UNAVAILABLE: "Use the supported local-workspace host or stop.",
  FILE_TOO_LARGE: "Provide a JSON file no larger than 16 KiB.",
  INVALID_UTF8: "Save the file as valid UTF-8 and try again.",
  INVALID_JSON: "Correct the JSON syntax and try again.",
  DUPLICATE_KEY: "Remove duplicate object keys and try again.",
  JSON_TOO_DEEP: "Reduce JSON nesting to eight levels or fewer.",
  UNSUPPORTED_SCHEMA: "Provide a JSON value using only supported types.",
  OPERATION_CONFLICT: "Inspect the existing operation before retrying.",
};

export function betaError(
  code: BetaErrorCode,
  message: string,
  nextAction = defaultNextAction[code],
): BetaError {
  return new BetaError(code, message, nextAction);
}
