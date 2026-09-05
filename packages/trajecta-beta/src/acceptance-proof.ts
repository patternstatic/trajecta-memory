import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildLocalResumeEnvelope, envelopePayload } from "./envelope.ts";
import { betaError, BetaError } from "./errors.ts";
import { createLocalKernelPort, TrajectaStore, type TransferPacket } from "./kernel-port.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ReceiptStore } from "./receipt-store.ts";
import { LocalResumeService } from "./resume-service.ts";
import { TargetRegistry } from "./target-registry.ts";
import { observeWorkspace } from "./workspace.ts";
import { withWriterLock } from "./writer-lock.ts";
import type { LocalResumeEnvelopeV1, LocalResumeReceiptV1, LocalWorkspaceTargetCardV1 } from "./contracts.ts";

export interface AcceptanceProofInput { root: string; bin: string; }
export interface AcceptanceProofResult {
  checks: Record<string, boolean>;
  commands: Array<{argv: string[]; exitCode: number; stdout: string; stderr: string}>;
  semanticTrace: string[];
  stateInventory: Array<{path: string; sha256: string; bytes: number}>;
  receipts: {stale: string; accepted: string; retry: string; lookup: string};
  finalRevision: number;
}

export interface AcceptanceProofDetails {
  beforeAfterDigests: Record<string, { before: string; after: string }>;
  targetStatus: { afterStale: "issued"; afterAccepted: "consumed"; expiryCheck: "clock-controlled" };
}

function fail(message: string): never {
  throw betaError("OPERATION_IN_DOUBT", message, "Keep this proof directory and inspect its bounded evidence before retrying in a new directory.");
}

function requireProof(value: boolean, message: string): void { if (!value) fail(message); }
function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }

function assertNewRoot(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("The acceptance proof requires an absolute new root.");
  const root = path.resolve(value);
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; fail("The acceptance proof root cannot be inspected safely."); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("The acceptance proof root may not traverse symbolic links or files.");
  }
  if (fs.existsSync(root)) fail("The acceptance proof requires a new root.");
  if (!fs.statSync(path.dirname(root)).isDirectory()) fail("The acceptance proof root requires an existing parent directory.");
  fs.mkdirSync(root, { mode: 0o700 });
  return root;
}

function assertInstalledBin(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("The acceptance proof requires the installed package executable.");
  const bin = path.resolve(value);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(bin); } catch { return fail("The installed package executable is unavailable."); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) fail("The installed package executable must be a regular executable file.");
  return bin;
}

function commandEnvironment(root: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const home = path.join(root, "home"), xdg = path.join(root, "xdg"), globalConfig = path.join(root, "global.gitconfig");
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(xdg, { mode: 0o700 });
  fs.writeFileSync(globalConfig, "", { mode: 0o600, flag: "wx" });
  return { ...environment, HOME: home, XDG_CONFIG_HOME: xdg, TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function git(args: string[], cwd: string, environment: NodeJS.ProcessEnv): void {
  try { execFileSync("git", args, { cwd, env: environment, stdio: "ignore" }); }
  catch { fail("The isolated acceptance Git workspace could not be prepared."); }
}

function run(commands: AcceptanceProofResult["commands"], bin: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  const argv = [bin, ...args];
  const result = spawnSync(bin, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) fail("An installed acceptance command could not be started.");
  const record = { argv, exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  commands.push(record);
  return record;
}

function inventory(root: string, relative = ""): AcceptanceProofResult["stateInventory"] {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  const result: AcceptanceProofResult["stateInventory"] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en-US"))) {
    const child = relative ? path.posix.join(relative.split(path.sep).join("/"), entry.name) : entry.name;
    const absolute = path.join(root, ...child.split("/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("Acceptance state contains an unsupported filesystem entry.");
    if (stat.isDirectory()) result.push(...inventory(root, child));
    else { const bytes = fs.readFileSync(absolute); result.push({ path: child, sha256: sha256(bytes), bytes: bytes.length }); }
  }
  return result;
}

function sameInventory(left: AcceptanceProofResult["stateInventory"], right: AcceptanceProofResult["stateInventory"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inventorySha256(value: AcceptanceProofResult["stateInventory"]): string { return sha256(JSON.stringify(value)); }

function finalizePacketBudget(packet: TransferPacket): TransferPacket {
  let previous = -1;
  packet.budget.usedBytes = 0;
  while (packet.budget.usedBytes !== previous) {
    previous = packet.budget.usedBytes;
    packet.budget.usedBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  }
  return packet;
}

function writeEnvelope(file: string, envelope: LocalResumeEnvelopeV1): void {
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o600 });
}

function changedEnvelope(original: LocalResumeEnvelopeV1, mutate: (value: Omit<LocalResumeEnvelopeV1, "integrity">) => void): LocalResumeEnvelopeV1 {
  const payload = structuredClone(envelopePayload(original));
  mutate(payload);
  finalizePacketBudget(payload.packet);
  return buildLocalResumeEnvelope(payload);
}

function receipt(stdout: string): LocalResumeReceiptV1 {
  try { return JSON.parse(stdout) as LocalResumeReceiptV1; }
  catch { return fail("An installed command did not return the expected receipt bytes."); }
}

function assertCode(error: unknown, code: string): boolean { return error instanceof BetaError && error.code === code; }

/** Execute the customer-visible installed CLI against one isolated committed workspace. */
export async function runAcceptanceProof(input: AcceptanceProofInput): Promise<AcceptanceProofResult & { evidence: AcceptanceProofDetails }> {
  const bin = assertInstalledBin(input.bin), root = assertNewRoot(input.root);
  const tmp = path.join(root, "tmp"), workspace = path.join(root, "workspace"), stateRoot = path.join(root, "state");
  for (const directory of [tmp, workspace, stateRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  const environment = commandEnvironment(root);
  fs.writeFileSync(path.join(workspace, "package.json"), "{\"name\":\"trajecta-acceptance-customer\",\"private\":true}\n", { mode: 0o600 });
  git(["init", "-b", "main"], workspace, environment);
  git(["add", "package.json"], workspace, environment);
  git(["-c", "user.name=Trajecta Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "Initial customer workspace"], workspace, environment);
  git(["remote", "add", "origin", "https://example.invalid/customer/workspace.git"], workspace, environment);

  const commands: AcceptanceProofResult["commands"] = [];
  const doctor = run(commands, bin, ["doctor", "--state-root", stateRoot], workspace, environment);
  const demo = run(commands, bin, ["demo", "--state-root", path.join(root, "demo-state")], workspace, environment);
  const targetFile = path.join(stateRoot, "target.json");
  const host = run(commands, bin, ["host", "init", "--state-root", stateRoot, "--out", targetFile], workspace, environment);
  requireProof(doctor.exitCode === 0 && /"code":"OK"/.test(doctor.stdout), "Installed doctor did not pass.");
  requireProof(demo.exitCode === 0 && demo.stdout.includes("RETRY     same receipt bytes"), "Installed demo did not complete its retry proof.");
  requireProof(host.exitCode === 0 && host.stdout.includes("example.invalid/customer/workspace"), "Installed host initialization did not bind the isolated customer workspace.");

  const target = JSON.parse(fs.readFileSync(targetFile, "utf8")) as LocalWorkspaceTargetCardV1;
  const store = new TrajectaStore(path.join(stateRoot, "kernel"));
  const surface = { kind: "cloud" as const, name: "Acceptance planner", session: "cloud:acceptance" };
  const { stalePacket, currentPacket, workId } = await withWriterLock({ stateRoot, operationId: "operation:acceptance-seed" }, () => {
    const opened = store.open({ operationId: "operation:acceptance-open", topic: "Prepare a customer proof", goal: "Resume the current plan exactly once", surface,
      initialBranch: { label: "main", purpose: "Verify the private beta delivery", cues: ["acceptance"], returnPoint: "Read the durable receipt" } });
    store.capture({ operationId: "operation:acceptance-handoff", workId: opened.work.id, expectedRevision: 1, surface, kind: "handoff", summary: "First draft", provenance: ["artifact:acceptance-stale"], nextAction: "Review the old draft", targetSurface: "local" });
    const stalePacket = store.transfer(opened.work.id, "resume", "local");
    store.capture({ operationId: "operation:acceptance-advance", workId: opened.work.id, expectedRevision: 2, surface, kind: "decision", summary: "Use the revised customer plan", provenance: ["artifact:acceptance-current"], nextAction: "Review the current plan" });
    return { stalePacket, currentPacket: store.transfer(opened.work.id, "resume", "local"), workId: opened.work.id };
  });
  const envelope = (packet: TransferPacket, suffix: string) => buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: `envelope:acceptance-${suffix}`, operationId: `operation:acceptance-${suffix}`,
    createdAt: new Date().toISOString(), expiresAt: target.expiresAt, target, packet });
  const staleEnvelope = envelope(stalePacket, "stale"), currentEnvelope = envelope(currentPacket, "current");
  const staleFile = path.join(stateRoot, "stale.json"), currentFile = path.join(stateRoot, "current.json");
  writeEnvelope(staleFile, staleEnvelope); writeEnvelope(currentFile, currentEnvelope);

  const beforeInspect = inventory(stateRoot);
  const staleInspect = run(commands, bin, ["inspect", staleFile, "--state-root", stateRoot], workspace, environment);
  const afterInspect = inventory(stateRoot);
  const kernelBeforeStale = inventory(path.join(stateRoot, "kernel"));
  const staleResume = run(commands, bin, ["resume", staleFile, "--state-root", stateRoot, "--accept"], workspace, environment);
  const kernelAfterStale = inventory(path.join(stateRoot, "kernel"));
  const staleReceipt = receipt(staleResume.stdout);
  let targetAfterStale = false;
  try { new TargetRegistry({ stateRoot }).assertIssued(target); targetAfterStale = true; } catch { targetAfterStale = false; }

  const wrongCapabilityFile = path.join(stateRoot, "wrong-capability.json");
  writeEnvelope(wrongCapabilityFile, changedEnvelope(currentEnvelope, payload => { payload.operationId = "operation:acceptance-wrong-capability"; payload.envelopeId = "envelope:acceptance-wrong-capability"; payload.target.capability = "capability:wrong"; }));
  const beforeWrong = inventory(path.join(stateRoot, "kernel"));
  const wrongCapability = run(commands, bin, ["inspect", wrongCapabilityFile, "--state-root", stateRoot], workspace, environment);
  const afterWrong = inventory(path.join(stateRoot, "kernel"));

  const branchlessFile = path.join(stateRoot, "branchless.json");
  writeEnvelope(branchlessFile, changedEnvelope(currentEnvelope, payload => { payload.operationId = "operation:acceptance-branchless"; payload.envelopeId = "envelope:acceptance-branchless"; payload.packet.activeBranch = null; }));
  const beforeBranchless = inventory(path.join(stateRoot, "kernel"));
  const branchless = run(commands, bin, ["inspect", branchlessFile, "--state-root", stateRoot], workspace, environment);
  const afterBranchless = inventory(path.join(stateRoot, "kernel"));

  const currentInspect = run(commands, bin, ["inspect", currentFile, "--state-root", stateRoot], workspace, environment);
  const accepted = run(commands, bin, ["resume", currentFile, "--state-root", stateRoot, "--accept"], workspace, environment);
  const retry = run(commands, bin, ["resume", currentFile, "--state-root", stateRoot], workspace, environment);
  const acceptedReceipt = receipt(accepted.stdout);
  let targetAfterAccepted = false;
  try { new TargetRegistry({ stateRoot }).assertConsumed(target, currentEnvelope.operationId, currentEnvelope.integrity.canonicalPayloadDigest, acceptedReceipt.receiptId); targetAfterAccepted = true; } catch { targetAfterAccepted = false; }
  const lookup = run(commands, bin, ["receipt", currentEnvelope.operationId, "--state-root", stateRoot], workspace, environment);

  const conflictFile = path.join(stateRoot, "conflict.json");
  writeEnvelope(conflictFile, changedEnvelope(currentEnvelope, payload => { payload.packet.cue = "Changed content for conflict proof"; }));
  const receiptsBeforeConflict = inventory(path.join(stateRoot, "receipts"));
  const conflict = run(commands, bin, ["resume", conflictFile, "--state-root", stateRoot, "--accept"], workspace, environment);
  const receiptsAfterConflict = inventory(path.join(stateRoot, "receipts"));
  const postConflictLookup = run(commands, bin, ["receipt", currentEnvelope.operationId, "--state-root", stateRoot], workspace, environment);

  const consumedFile = path.join(stateRoot, "consumed-target.json");
  writeEnvelope(consumedFile, changedEnvelope(currentEnvelope, payload => { payload.operationId = "operation:acceptance-consumed"; payload.envelopeId = "envelope:acceptance-consumed"; }));
  const consumed = run(commands, bin, ["resume", consumedFile, "--state-root", stateRoot, "--accept"], workspace, environment);

  const issuedAt = new Date("2026-09-05T00:00:00.000Z"), expiredAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
  const expiryRegistry = new TargetRegistry({ stateRoot, clock: () => issuedAt });
  const expiryTarget = expiryRegistry.issue(observeWorkspace(workspace, stateRoot), issuedAt);
  const expiryEnvelope = buildLocalResumeEnvelope({ ...envelopePayload(currentEnvelope), envelopeId: "envelope:acceptance-expiry", operationId: "operation:acceptance-expiry", createdAt: issuedAt.toISOString(), expiresAt: expiryTarget.expiresAt, target: expiryTarget });
  const expiryFile = path.join(stateRoot, "expiry.json"); writeEnvelope(expiryFile, expiryEnvelope);
  const expiryService = new LocalResumeService({ cwd: workspace, stateRoot, clock: () => expiredAt, kernel: createLocalKernelPort(stateRoot, () => expiredAt), registry: new TargetRegistry({ stateRoot, clock: () => expiredAt }), journal: new OperationJournal({ stateRoot, clock: () => expiredAt }), receipts: new ReceiptStore({ stateRoot }) });
  const kernelBeforeExpiry = inventory(path.join(stateRoot, "kernel"));
  let expiryRejected = false;
  try { expiryService.inspectFile(expiryFile); } catch (error) { expiryRejected = assertCode(error, "TARGET_EXPIRED"); }
  const kernelAfterExpiry = inventory(path.join(stateRoot, "kernel"));

  const finalKernel = createLocalKernelPort(stateRoot), finalRevision = finalKernel.getWork(workId).revision;
  const resumeDeltas = finalKernel.history(workId).filter(delta => delta.kind === "resume");
  const checks: Record<string, boolean> = {
    installedCommandsPassed: doctor.exitCode === 0 && demo.exitCode === 0 && host.exitCode === 0,
    staleInspectReadOnly: staleInspect.exitCode === 0 && sameInventory(beforeInspect, afterInspect),
    staleRejected: staleResume.exitCode === 2 && staleReceipt.code === "REVISION_CONFLICT" && staleReceipt.observedRevisionBefore === 3 && staleReceipt.observedRevisionAfter === 3 && targetAfterStale,
    staleKernelPreserved: sameInventory(kernelBeforeStale, kernelAfterStale),
    wrongCapabilityPrivate: wrongCapability.exitCode === 2 && wrongCapability.stderr.startsWith("TARGET_MISMATCH:") && !/revision|capability:/i.test(wrongCapability.stdout + wrongCapability.stderr) && sameInventory(beforeWrong, afterWrong),
    branchlessPrivate: branchless.exitCode === 2 && branchless.stderr.startsWith("BRANCH_MISMATCH:") && !/revision|capability:/i.test(branchless.stdout + branchless.stderr) && sameInventory(beforeBranchless, afterBranchless),
    currentInspected: currentInspect.exitCode === 0 && JSON.parse(currentInspect.stdout).expectedRevision === 3 && JSON.parse(currentInspect.stdout).currentRevision === 3,
    acceptedOnce: accepted.exitCode === 0 && acceptedReceipt.code === "RESUMED" && acceptedReceipt.observedRevisionBefore === 3 && acceptedReceipt.observedRevisionAfter === 4 && targetAfterAccepted,
    retryExact: retry.exitCode === 0 && retry.stdout === accepted.stdout,
    lookupExact: lookup.exitCode === 0 && lookup.stdout === accepted.stdout,
    conflictRefused: conflict.exitCode === 2 && conflict.stderr.startsWith("OPERATION_CONFLICT:"),
    conflictReceiptPreserved: sameInventory(receiptsBeforeConflict, receiptsAfterConflict) && postConflictLookup.exitCode === 0 && postConflictLookup.stdout === accepted.stdout,
    consumedRefused: consumed.exitCode === 2 && consumed.stderr.startsWith("TARGET_CONSUMED:"),
    expiryClockControlled: expiryRejected && sameInventory(kernelBeforeExpiry, kernelAfterExpiry),
    oneKernelResume: finalRevision === 4 && resumeDeltas.length === 1,
  };
  for (const [name, passed] of Object.entries(checks)) requireProof(passed, `Acceptance check ${name} failed.`);
  const semanticTrace = [
    "doctor:OK", "demo:stale-current-retry", "host:example.invalid/customer/workspace:main",
    "stale:inspect-read-only", "stale:REVISION_CONFLICT:3->3", "wrong-capability-private-rejection", "branchless:private-rejection",
    "current:inspect:3", "current:RESUMED:3->4", "retry:exact-bytes", "lookup:exact-bytes", "conflict:OPERATION_CONFLICT:receipt-preserved",
    "consumed:TARGET_CONSUMED", "expiry:clock-controlled:TARGET_EXPIRED", "kernel:one-resume:revision-4",
  ];
  const evidence: AcceptanceProofDetails = {
    beforeAfterDigests: {
      inspectState: { before: inventorySha256(beforeInspect), after: inventorySha256(afterInspect) },
      staleKernel: { before: inventorySha256(kernelBeforeStale), after: inventorySha256(kernelAfterStale) },
      wrongCapabilityKernel: { before: inventorySha256(beforeWrong), after: inventorySha256(afterWrong) },
      branchlessKernel: { before: inventorySha256(beforeBranchless), after: inventorySha256(afterBranchless) },
      expiryKernel: { before: inventorySha256(kernelBeforeExpiry), after: inventorySha256(kernelAfterExpiry) },
    },
    targetStatus: { afterStale: "issued", afterAccepted: "consumed", expiryCheck: "clock-controlled" },
  };
  return Object.freeze({ checks: Object.freeze(checks), commands, semanticTrace, stateInventory: inventory(stateRoot), receipts: { stale: staleResume.stdout, accepted: accepted.stdout, retry: retry.stdout, lookup: postConflictLookup.stdout }, finalRevision, evidence });
}
