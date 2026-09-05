import { execFileSync } from "node:child_process";
import { randomUUID as systemRandomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalResumeReceiptV1 } from "./contracts.ts";
import { assertPrivateDirectory, ensurePrivateDirectory, writeJsonExclusive } from "./durable-file.ts";
import { buildLocalResumeEnvelope } from "./envelope.ts";
import { betaError } from "./errors.ts";
import { createLocalKernelPort, TrajectaStore, type TransferPacket } from "./kernel-port.ts";
import { OperationJournal } from "./operation-journal.ts";
import { ReceiptStore } from "./receipt-store.ts";
import { LocalResumeService } from "./resume-service.ts";
import { TargetRegistry } from "./target-registry.ts";
import { observeWorkspace } from "./workspace.ts";
import { withWriterLock } from "./writer-lock.ts";

export interface DemoOptions {
  stateRoot?: string;
  output?: (text: string) => void;
  /** Starting instant for this isolated fixture; replay advances beyond expiry. */
  clock?: () => Date;
  randomUUID?: () => string;
}

export interface DemoResult {
  stale: LocalResumeReceiptV1;
  current: LocalResumeReceiptV1;
  targetAfterStale: "issued";
  targetAfterCurrent: "consumed";
  retryReceiptId: string;
  revision: number;
}

function requireProof(condition: boolean): asserts condition {
  if (!condition) throw betaError("OPERATION_IN_DOUBT", "The isolated local proof did not satisfy its receipt invariants.");
}

function prepareStateRoot(configured: string): string {
  const root = path.resolve(configured);
  // An explicit root must not implicitly create durable ancestors elsewhere.
  try { if (!lstatSync(path.dirname(root)).isDirectory()) throw new Error(); }
  catch { throw betaError("OPERATION_IN_DOUBT", "Choose an empty state directory with an existing parent."); }
  let exists = true;
  try { lstatSync(root); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; exists = false; }
  if (exists) {
    assertPrivateDirectory(root);
    if (readdirSync(root).length !== 0) throw betaError("OPERATION_IN_DOUBT", "The isolated demo requires a new or empty private state directory.");
  } else ensurePrivateDirectory(root);
  return root;
}

/** Run the production service offline; only an explicit state root survives. */
export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trajecta-beta-demo-")));
  try {
    const cwd = path.join(temporary, "workspace"); mkdirSync(cwd, { mode: 0o700 });
    const stateRoot = prepareStateRoot(options.stateRoot ?? path.join(temporary, "state"));
    execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://example.invalid/patternstatic/trajecta-memory.git"], { stdio: "ignore" });
    let instant = (options.clock ?? (() => new Date()))().getTime();
    requireProof(Number.isFinite(instant));
    const clock = () => new Date(instant);
    const uuid = options.randomUUID ?? systemRandomUUID;
    const id = () => { const value = uuid(); requireProof(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)); return value; };
    const store = new TrajectaStore(path.join(stateRoot, "kernel"), clock);
    const surface = { kind: "cloud" as const, name: "External planner", session: "cloud:offline-demo" };
    const workId = await withWriterLock({ stateRoot, operationId: `operation:${id()}`, clock }, () => {
      const { work } = store.open({ operationId: `operation:${id()}`, topic: "Verified local handoff", goal: "Resume current work once", surface,
        initialBranch: { label: "main", purpose: "Verify local continuation", cues: ["resume"], returnPoint: "Read durable receipt" } });
      store.capture({ operationId: `operation:${id()}`, workId: work.id, expectedRevision: work.revision, surface,
        kind: "handoff", summary: "First handoff", targetSurface: "local", provenance: ["artifact:offline-demo"], nextAction: "Review the original plan" });
      return work.id;
    });
    const registry = new TargetRegistry({ stateRoot, clock }), target = registry.issue(observeWorkspace(cwd, stateRoot));
    const save = (packet: TransferPacket, name: string) => {
      const envelope = buildLocalResumeEnvelope({ schema: "trajecta.local-resume-envelope/v1", envelopeId: `envelope:${id()}`, operationId: `operation:${id()}`,
        createdAt: clock().toISOString(), expiresAt: target.expiresAt, target, packet });
      const file = path.join(cwd, name); writeJsonExclusive(file, envelope); return { file, envelope };
    };
    const stale = save(store.transfer(workId, "resume", "local"), "stale.json");
    await withWriterLock({ stateRoot, operationId: `operation:${id()}`, clock }, () => {
      store.capture({ operationId: `operation:${id()}`, workId, expectedRevision: store.getWork(workId).revision, surface,
        kind: "decision", summary: "Plan advanced", provenance: ["artifact:current-demo"], nextAction: "Review the current plan" });
    });
    const current = save(store.transfer(workId, "resume", "local"), "current.json");
    const kernel = createLocalKernelPort(stateRoot, clock);
    const service = new LocalResumeService({ cwd, stateRoot, clock, kernel, registry, journal: new OperationJournal({ stateRoot, clock }), receipts: new ReceiptStore({ stateRoot }) });
    service.inspectFile(stale.file);
    const rejectedBytes = await service.resumeFile(stale.file, { accepted: false });
    const staleReceipt = JSON.parse(service.receiptBytes(stale.envelope.operationId).toString("utf8")) as LocalResumeReceiptV1;
    requireProof(rejectedBytes.equals(service.receiptBytes(stale.envelope.operationId)) && staleReceipt.code === "REVISION_CONFLICT"
      && staleReceipt.outcome === "rejected" && staleReceipt.observedRevisionBefore === staleReceipt.observedRevisionAfter
      && kernel.getWork(workId).revision === staleReceipt.observedRevisionAfter);
    registry.assertIssued(target);
    service.inspectFile(current.file);
    const acceptedBytes = await service.resumeFile(current.file, { accepted: true });
    const currentReceipt = JSON.parse(service.receiptBytes(current.envelope.operationId).toString("utf8")) as LocalResumeReceiptV1;
    requireProof(acceptedBytes.equals(service.receiptBytes(current.envelope.operationId)) && currentReceipt.code === "RESUMED"
      && currentReceipt.outcome === "accepted" && currentReceipt.observedRevisionAfter === currentReceipt.expectedRevision + 1);
    registry.assertConsumed(target, current.envelope.operationId, current.envelope.integrity.canonicalPayloadDigest, currentReceipt.receiptId);
    // The same persisted operation must replay even after both deadlines have elapsed.
    instant = Date.parse(target.expiresAt) + 1;
    const replay = await service.resumeFile(current.file, { accepted: false });
    const revision = kernel.getWork(workId).revision;
    requireProof(replay.equals(acceptedBytes) && revision === currentReceipt.observedRevisionAfter
      && kernel.history(workId).filter(delta => delta.kind === "resume").length === 1);
    const retryReceiptId = (JSON.parse(replay.toString("utf8")) as LocalResumeReceiptV1).receiptId;
    options.output?.(`TARGET    issued for ${target.workspace.repository} · ${target.workspace.branch}\n`
      + `STALE     ${staleReceipt.outcome.toUpperCase()} ${staleReceipt.code} · revision ${staleReceipt.observedRevisionBefore} -> ${staleReceipt.observedRevisionAfter} · ${staleReceipt.receiptId}\n`
      + `CURRENT   ${currentReceipt.outcome.toUpperCase()} ${currentReceipt.code} · revision ${currentReceipt.observedRevisionBefore} -> ${currentReceipt.observedRevisionAfter} · ${currentReceipt.receiptId}\n`
      + `RETRY     same receipt bytes · revision remains ${revision} · ${retryReceiptId}\n`);
    return { stale: staleReceipt, current: currentReceipt, targetAfterStale: "issued", targetAfterCurrent: "consumed", retryReceiptId, revision };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
