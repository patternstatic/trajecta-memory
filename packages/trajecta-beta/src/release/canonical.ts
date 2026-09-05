import { createHash } from "node:crypto";
import { releaseError } from "./errors.ts";

function compareCodeUnits(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function serialize(value: unknown, active: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return releaseError("INVALID_CANONICAL_JSON", "Canonical JSON does not support non-finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return releaseError("INVALID_CANONICAL_JSON", `Canonical JSON does not support ${typeof value}.`);
  if (active.has(value)) return releaseError("INVALID_CANONICAL_JSON", "Canonical JSON cannot serialize cycles.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const rendered: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) return releaseError("INVALID_CANONICAL_JSON", "Canonical JSON arrays cannot have holes.");
        rendered.push(serialize(value[index], active));
      }
      return `[${rendered.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return releaseError("INVALID_CANONICAL_JSON", "Canonical JSON requires plain objects.");
    const keys = Object.keys(value).sort(compareCodeUnits);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key], active)}`).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJsonLf(value: unknown): Buffer {
  return Buffer.from(`${serialize(value, new WeakSet<object>())}\n`, "utf8");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
