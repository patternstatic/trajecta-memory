import { createHash } from "node:crypto";
import { betaError } from "./errors.ts";

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function unsupported(message: string): never {
  throw betaError("UNSUPPORTED_SCHEMA", message);
}

function serialize(value: unknown, active: WeakSet<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) unsupported("Canonical JSON does not support non-finite numbers.");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      unsupported(`Canonical JSON does not support ${typeof value}.`);
  }

  if (active.has(value)) throw betaError("UNSUPPORTED_SCHEMA", "Canonical JSON cannot serialize cyclic values.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol" || (key !== "length" && !/^\d+$/.test(key))) {
          unsupported("Canonical JSON arrays may contain indexed values only.");
        }
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          unsupported("Canonical JSON arrays may not contain holes.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) unsupported("Canonical JSON requires data properties.");
        items.push(serialize(descriptor.value, active));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      unsupported("Canonical JSON objects must use the default object prototype.");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") unsupported("Canonical JSON objects may not contain symbol keys.");
    }
    const keys = Object.keys(value).sort(compareCodeUnits);
    const properties = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) unsupported("Canonical JSON requires data properties.");
      return `${JSON.stringify(key)}:${serialize(descriptor.value, active)}`;
    });
    return `{${properties.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}
