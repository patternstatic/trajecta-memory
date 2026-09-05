import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";
import { BetaError, betaError } from "./errors.ts";

export const MAX_ENVELOPE_BYTES = 16 * 1024;
export const MAX_JSON_DEPTH = 8;

const decoder = new TextDecoder("utf-8", { fatal: true });
const NUMBER = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

class JsonParser {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.invalid("Trailing data after the JSON value.");
    }
    return value;
  }

  private parseValue(depth: number): unknown {
    const character = this.text[this.index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === '"') return this.parseString();
    if (character === "t" && this.consumeLiteral("true")) return true;
    if (character === "f" && this.consumeLiteral("false")) return false;
    if (character === "n" && this.consumeLiteral("null")) return null;
    return this.parseNumber();
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.requireDepth(depth);
    this.index++;
    const object: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.take("}")) return object;

    while (true) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.invalid("Object keys must be JSON strings.");
      const key = this.parseString();
      if (keys.has(key)) {
        throw betaError("DUPLICATE_KEY", "Input contains duplicate object keys.");
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.take(":")) this.invalid("Expected ':' after an object key.");
      this.skipWhitespace();
      const value = this.parseValue(depth);
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      this.skipWhitespace();
      if (this.take("}")) return object;
      if (!this.take(",")) this.invalid("Expected ',' or '}' in an object.");
    }
  }

  private parseArray(depth: number): unknown[] {
    this.requireDepth(depth);
    this.index++;
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.take("]")) return array;

    while (true) {
      this.skipWhitespace();
      array.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.take("]")) return array;
      if (!this.take(",")) this.invalid("Expected ',' or ']' in an array.");
    }
  }

  private parseString(): string {
    if (!this.take('"')) this.invalid("Expected a JSON string.");
    let result = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') return result;
      if (character === "\\") {
        if (this.index >= this.text.length) this.invalid("Unterminated JSON escape.");
        const escape = this.text[this.index++];
        const escaped: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape === "u") {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.invalid("Invalid Unicode escape.");
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
        } else if (escape in escaped) {
          result += escaped[escape];
        } else {
          this.invalid("Invalid JSON escape.");
        }
      } else {
        if (character.charCodeAt(0) <= 0x1f) this.invalid("Control characters are not allowed in strings.");
        result += character;
      }
    }
    this.invalid("Unterminated JSON string.");
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (!match) this.invalid("Expected a JSON value.");
    this.index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) this.invalid("JSON numbers must be finite.");
    return number;
  }

  private consumeLiteral(literal: string): boolean {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) return false;
    this.index += literal.length;
    return true;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const character = this.text.charCodeAt(this.index);
      if (character === 0x20 || character === 0x09 || character === 0x0a || character === 0x0d) {
        this.index++;
      } else {
        break;
      }
    }
  }

  private take(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index++;
    return true;
  }

  private requireDepth(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw betaError("JSON_TOO_DEEP", "JSON nesting exceeds the maximum depth.");
  }

  private invalid(message: string): never {
    throw betaError("INVALID_JSON", message);
  }
}

export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw betaError("FILE_TOO_LARGE", `JSON input is ${bytes.byteLength} bytes; the maximum is ${MAX_ENVELOPE_BYTES}.`);
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw betaError("INVALID_UTF8", "JSON input is not valid UTF-8.");
  }
  return parseStrictJsonText(text);
}

export function parseStrictJsonText(text: string): unknown {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_ENVELOPE_BYTES) {
    throw betaError("FILE_TOO_LARGE", `JSON input is ${byteLength} bytes; the maximum is ${MAX_ENVELOPE_BYTES}.`);
  }
  try {
    return new JsonParser(text).parse();
  } catch (error) {
    if (error instanceof BetaError) throw error;
    throw betaError("INVALID_JSON", "Input is not valid JSON.");
  }
}

export function parseStrictJsonFile(file: string): unknown {
  let fd = -1;
  let value: unknown;
  let failure: unknown;
  try {
    fd = openSync(file, "r");
    const initial = fstatSync(fd);
    if (!initial.isFile()) throw betaError("INVALID_JSON", "The JSON input is not a regular file.");
    const size = initial.size;
    if (!Number.isSafeInteger(size) || size < 0) throw betaError("INVALID_JSON", "The JSON file size is invalid.");
    if (size > MAX_ENVELOPE_BYTES) {
      throw betaError("FILE_TOO_LARGE", `JSON input is ${size} bytes; the maximum is ${MAX_ENVELOPE_BYTES}.`);
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, null);
      if (count === 0) throw betaError("INVALID_JSON", "The JSON file ended before all bytes could be read.");
      offset += count;
    }
    const final = fstatSync(fd);
    if (final.size > MAX_ENVELOPE_BYTES) {
      throw betaError("FILE_TOO_LARGE", `JSON input is ${final.size} bytes; the maximum is ${MAX_ENVELOPE_BYTES}.`);
    }
    if (
      final.size !== initial.size ||
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.mode !== initial.mode ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw betaError("INVALID_JSON", "The JSON file changed while it was being read.");
    }
    value = parseStrictJsonBytes(bytes);
  } catch (error) {
    failure = error;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }
  if (failure !== undefined) {
    if (failure instanceof BetaError) throw failure;
    throw betaError("INVALID_JSON", "Unable to read the JSON file.");
  }
  return value;
}
