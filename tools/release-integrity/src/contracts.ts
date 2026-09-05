export * from "../../../packages/trajecta-beta/src/release/contracts.ts";
import { releaseError } from "./errors.ts";

export type ReleaseKind = "evaluation" | "commercial-candidate";

export function resolveReleaseKind(value: ReleaseKind | undefined): ReleaseKind {
  if (value === undefined || value === "evaluation") return "evaluation";
  if (value === "commercial-candidate") return value;
  return releaseError("INVALID_RELEASE_KIND", "Release kind must be a closed supported value.");
}
