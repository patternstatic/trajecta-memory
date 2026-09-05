import path from "node:path";

export type CliInvocation =
  | { kind: "doctor"; stateRoot: string | null }
  | { kind: "demo"; stateRoot: string | null }
  | { kind: "host-init"; stateRoot: string | null; out: string | null }
  | { kind: "inspect"; file: string; stateRoot: string | null }
  | { kind: "resume"; file: string; stateRoot: string | null; accept: boolean }
  | { kind: "receipt"; operationId: string; stateRoot: string | null }
  | { kind: "version" };

export class CliUsageError extends Error {
  constructor(message = "Use one supported trajecta-beta command with its documented arguments.") {
    super(message);
    this.name = "CliUsageError";
  }
}

interface ParsedTail { positionals: string[]; options: Map<string, string | true> }

function invalid(): never { throw new CliUsageError(); }

function nonEmpty(value: string | undefined): string {
  if (!value || !value.trim() || value.startsWith("-")) invalid();
  return value;
}

function parseTail(values: readonly string[], allowed: readonly string[]): ParsedTail {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value.startsWith("--")) {
      if (!allowed.includes(value) || options.has(value)) invalid();
      if (value === "--accept") options.set(value, true);
      else options.set(value, nonEmpty(values[++index]));
    } else {
      if (!value || !value.trim() || value.startsWith("-")) invalid();
      positionals.push(value);
    }
  }
  return { positionals, options };
}

function stateRoot(options: Map<string, string | true>): string | null {
  const value = options.get("--state-root");
  if (typeof value === "string" && value.split(path.sep).includes("..")) invalid();
  return typeof value === "string" ? value : null;
}

function exactPositionals(tail: ParsedTail, count: number): string[] {
  if (tail.positionals.length !== count) invalid();
  return tail.positionals;
}

/** Strictly parse argv after the executable name; no aliases or equals-style flags. */
export function parseCliArgs(argv: readonly string[]): CliInvocation {
  const [command, ...rest] = argv;
  if (!command) invalid();
  if (command === "doctor" || command === "demo") {
    const tail = parseTail(rest, ["--state-root"]);
    exactPositionals(tail, 0);
    return { kind: command, stateRoot: stateRoot(tail.options) };
  }
  if (command === "host") {
    if (rest[0] !== "init") invalid();
    const tail = parseTail(rest.slice(1), ["--state-root", "--out"]);
    exactPositionals(tail, 0);
    const out = tail.options.get("--out");
    return { kind: "host-init", stateRoot: stateRoot(tail.options), out: typeof out === "string" ? out : null };
  }
  if (command === "inspect") {
    const tail = parseTail(rest, ["--state-root"]);
    const [file] = exactPositionals(tail, 1);
    return { kind: "inspect", file: file!, stateRoot: stateRoot(tail.options) };
  }
  if (command === "resume") {
    const tail = parseTail(rest, ["--state-root", "--accept"]);
    const [file] = exactPositionals(tail, 1);
    return { kind: "resume", file: file!, stateRoot: stateRoot(tail.options), accept: tail.options.get("--accept") === true };
  }
  if (command === "receipt") {
    const tail = parseTail(rest, ["--state-root"]);
    const [operationId] = exactPositionals(tail, 1);
    return { kind: "receipt", operationId: operationId!, stateRoot: stateRoot(tail.options) };
  }
  if (command === "version") {
    const tail = parseTail(rest, []);
    exactPositionals(tail, 0);
    return { kind: "version" };
  }
  invalid();
}

/** Resolve state only after Git has identified the exact workspace root. */
export function resolveStateRoot(cwd: string, workspaceRoot: string, configured: string | null): string {
  return configured === null ? path.join(workspaceRoot, ".trajecta-beta") : path.resolve(cwd, configured);
}
