import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliUsageError, parseCliArgs, resolveStateRoot } from "./args.ts";
import { canonicalJson } from "./canonical.ts";
import { PRODUCT_NAME, PRODUCT_VERSION, runDoctor } from "./doctor.ts";
import { runDemo } from "./demo.ts";
import { BetaError, betaError } from "./errors.ts";
import { createLocalKernelPort } from "./kernel-port.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ReceiptStore } from "./receipt-store.ts";
import { LocalResumeService } from "./resume-service.ts";
import { TargetRegistry } from "./target-registry.ts";
import { gitEnvironment, observeWorkspace, type WorkspaceObservation } from "./workspace.ts";

export interface CliIO { stdout(bytes: string | Uint8Array): void; stderr(text: string): void }

// Display the approved projection only; never interpolate raw argv or thrown internals.
function display(value: unknown): string {
  return `${JSON.stringify(value, (_key, item) => typeof item === "string" ? item
    .replace(/capability:[A-Za-z0-9._-]+/g, "[redacted capability]")
    .replace(/\/(?:Users|home)\/[^\s"'<>]+/g, "[redacted home path]")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, "$1[redacted]@") : item)}\n`;
}

function workspace(cwd: string, configured: string | null): WorkspaceObservation {
  let root: string;
  try {
    root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, env: gitEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { throw betaError("CAPABILITY_UNAVAILABLE", "An exact attached Git workspace is required."); }
  return observeWorkspace(cwd, resolveStateRoot(cwd, root, configured));
}

function service(cwd: string, stateRoot: string): LocalResumeService {
  return new LocalResumeService({ cwd, stateRoot, kernel: createLocalKernelPort(stateRoot),
    registry: new TargetRegistry({ stateRoot }), journal: new OperationJournal({ stateRoot }), receipts: new ReceiptStore({ stateRoot }) });
}

function hostInit(observation: WorkspaceObservation, cwd: string, out: string | null): void {
  const file = path.resolve(cwd, out ?? "trajecta-target.traj.json"), directory = path.dirname(file);
  // Refuse symlink ancestors without applying private-state directory modes to a user's workspace.
  let parent = directory;
  while (true) {
    let stat;
    try { stat = lstatSync(parent); }
    catch { throw betaError("TARGET_MISMATCH", "The target card requires an existing output directory.", "Choose an existing directory with --out and retry."); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw betaError("TARGET_MISMATCH", "The target card requires an existing directory without symbolic links.");
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  let descriptor: number;
  try { descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw betaError("TARGET_MISMATCH", "The target card cannot be created without overwriting an existing path.", "Choose a new output file with --out and retry."); }
  try {
    if ((fstatSync(descriptor).mode & 0o777) !== 0o600) throw betaError("TARGET_MISMATCH", "The target card requires private file permissions.");
    const card = new TargetRegistry({ stateRoot: observation.stateRoot }).issue(observation);
    const bytes = Buffer.from(`${canonicalJson(card)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw betaError("OPERATION_IN_DOUBT", "The target card write did not complete.");
      offset += written;
    }
    fsyncSync(descriptor);
    const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally { closeSync(descriptor); }
}

/** Execute one already bounded invocation. Receipt output remains the exact stored bytes. */
export async function runCli(argv: readonly string[], cwd: string, io: CliIO): Promise<0 | 1 | 2> {
  try {
    const invocation = parseCliArgs(argv);
    if (invocation.kind === "version") { io.stdout(`${PRODUCT_NAME} ${PRODUCT_VERSION}\n`); return 0; }
    if (invocation.kind === "doctor") {
      const result = runDoctor({ cwd, stateRoot: invocation.stateRoot });
      if (result.exitCode !== 0) throw betaError(result.code as "UNSUPPORTED_ENVIRONMENT" | "OPERATION_IN_DOUBT", result.code === "OPERATION_IN_DOUBT" ? "Writer evidence requires inspection." : "The supported environment checks did not pass.");
      io.stdout(display(result)); return 0;
    }
    if (invocation.kind === "demo") {
      await runDemo({ ...(invocation.stateRoot === null ? {} : { stateRoot: path.resolve(cwd, invocation.stateRoot) }), output: text => io.stdout(text) });
      return 0;
    }
    const observed = workspace(cwd, invocation.stateRoot);
    if (invocation.kind === "host-init") {
      hostInit(observed, cwd, invocation.out);
      io.stdout(display({ repository: observed.repository, branch: observed.branch, targetCard: "created", expiresInMinutes: 30 })); return 0;
    }
    const local = service(cwd, observed.stateRoot);
    if (invocation.kind === "inspect") { io.stdout(display(local.inspectFile(path.resolve(cwd, invocation.file)))); return 0; }
    if (invocation.kind === "resume") {
      const bytes = await local.resumeFile(path.resolve(cwd, invocation.file), { accepted: invocation.accept });
      const receipt = JSON.parse(bytes.toString("utf8"));
      io.stdout(bytes);
      if (receipt.outcome === "rejected") throw betaError(receipt.code, receipt.code === "REVISION_CONFLICT" ? "The packet revision is no longer current." : "The active work branch differs from the packet branch.");
      return 0;
    }
    io.stdout(local.receiptBytes(invocation.operationId)); return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr("USAGE: Use one supported command with its documented arguments.\nNext: Choose version, doctor, demo, host init, inspect <file>, resume <file> --accept, or receipt <operation-id>.\n"); return 2;
    }
    if (error instanceof BetaError) {
      const safeError = JSON.parse(display({ explanation: error.message, next: error.nextAction }));
      io.stderr(`${error.code}: ${safeError.explanation.replace(/[\r\n]/g, " ")}\nNext: ${safeError.next.replace(/[\r\n]/g, " ")}\n`); return 2;
    }
    io.stderr("INTERNAL_ERROR: The local command could not complete safely.\nNext: Inspect local state before retrying and report this failure.\n"); return 1;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
const launcher = fileURLToPath(new URL("../bin/trajecta-beta", import.meta.url));
if (invoked === launcher || invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), process.cwd(), { stdout: bytes => { process.stdout.write(bytes); }, stderr: text => { process.stderr.write(text); } });
}
