import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Branch,
  CaptureDeltaInput,
  Delta,
  OpenWorkInput,
  RouteMatch,
  Surface,
  TransferPacket,
  WorkItem,
} from "./types.ts";

interface StateFile {
  schema: "trajecta.state/v1";
  work: WorkItem[];
}

interface OperationRecord {
  operationId: string;
  digest: string;
  state: "reserved" | "committed";
  deltaId?: string;
  result?: { work: WorkItem; delta: Delta };
}

export class RevisionConflict extends Error {
  readonly latest: WorkItem;
  constructor(latest: WorkItem) {
    super(`Revision conflict: expected current revision ${latest.revision}`);
    this.name = "RevisionConflict";
    this.latest = latest;
  }
}

export class OperationConflict extends Error {
  constructor() {
    super("Operation ID was reused with different input");
    this.name = "OperationConflict";
  }
}

function assertText(value: string, label: string, max = 1_000) {
  if (!value?.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
}

function assertId(value: string, label: string) {
  if (!/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a namespaced opaque ID`);
  }
}

function assertSurface(surface: Surface) {
  if (!surface || !["cloud", "local"].includes(surface.kind)) throw new Error("Surface kind must be cloud or local");
  assertText(surface.name, "Surface name", 120);
  assertText(surface.session, "Surface session", 200);
}

function digest(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tokenize(value: string) {
  return [...new Set(value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter((token) => token.length > 1))];
}

function appendJsonl(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

export class TrajectaStore {
  readonly root: string;
  private readonly stateFile: string;
  private readonly deltaFile: string;
  private readonly operationFile: string;
  private readonly clock: () => Date;

  constructor(root = path.resolve(".trajecta"), clock: () => Date = () => new Date()) {
    this.root = root;
    this.stateFile = path.join(root, "state.json");
    this.deltaFile = path.join(root, "deltas.jsonl");
    this.operationFile = path.join(root, "operations.jsonl");
    this.clock = clock;
  }

  private readState(): StateFile {
    if (!fs.existsSync(this.stateFile)) return { schema: "trajecta.state/v1", work: [] };
    const value = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    if (value?.schema !== "trajecta.state/v1" || !Array.isArray(value.work)) throw new Error("Trajecta state is corrupt");
    return value;
  }

  private commit(state: StateFile, delta: Delta, input: unknown) {
    const inputDigest = digest(input);
    appendJsonl(this.operationFile, { operationId: delta.operationId, digest: inputDigest, state: "reserved" });
    appendJsonl(this.deltaFile, delta);
    writeAtomic(this.stateFile, state);
    const result = { work: structuredClone(state.work.find((item) => item.id === delta.workId)!), delta };
    appendJsonl(this.operationFile, { operationId: delta.operationId, digest: inputDigest, state: "committed", deltaId: delta.id, result });
    return result;
  }

  private replay(operationId: string, input: unknown) {
    assertId(operationId, "Operation ID");
    const matching = readJsonl<OperationRecord>(this.operationFile).filter((item) => item.operationId === operationId);
    if (!matching.length) return null;
    if (matching.some((item) => item.digest !== digest(input))) throw new OperationConflict();
    const committed = [...matching].reverse().find((item) => item.state === "committed");
    if (!committed?.result) throw new Error("Operation is reserved without a committed outcome; inspect state before retrying");
    return structuredClone(committed.result);
  }

  open(input: OpenWorkInput) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    assertText(input.topic, "Topic", 160);
    assertText(input.goal, "Goal", 1_000);
    if (input.instruction) assertText(input.instruction, "Instruction", 1_000);
    assertSurface(input.surface);
    const now = this.clock().toISOString();
    const workId = `work:${crypto.randomUUID()}`;
    const branch = input.initialBranch ? this.makeBranch(input.initialBranch, now) : null;
    const work: WorkItem = {
      id: workId,
      topic: input.topic.trim(),
      goal: input.goal.trim(),
      instruction: input.instruction?.trim() ?? null,
      status: "active",
      revision: 1,
      activeBranchId: branch?.id ?? null,
      branches: branch ? [branch] : [],
      openLoops: [],
      nextAction: null,
      lastSurface: structuredClone(input.surface),
      createdAt: now,
      updatedAt: now,
    };
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId,
      revision: 1,
      kind: "open",
      summary: input.goal.trim(),
      surface: structuredClone(input.surface),
      branchId: branch?.id ?? null,
      targetSurface: null,
      provenance: [],
      createdAt: now,
    };
    const state = this.readState();
    state.work.push(work);
    return this.commit(state, delta, input);
  }

  capture(input: CaptureDeltaInput) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    assertText(input.summary, "Delta summary", input.kind === "contract_anchor" ? 8_000 : 1_000);
    assertSurface(input.surface);
    const state = this.readState();
    const index = state.work.findIndex((item) => item.id === input.workId);
    if (index < 0) throw new Error("Work item not found");
    const current = state.work[index];
    if (current.revision !== input.expectedRevision) throw new RevisionConflict(current);
    if (["complete", "abandoned"].includes(current.status)) throw new Error("Terminal work cannot accept new deltas");
    if (input.kind === "contract_anchor" && !(input.provenance?.length)) throw new Error("Contract anchors require provenance");
    if (input.kind === "outcome" && (input.openLoops === undefined || !("nextAction" in input) || !(input.provenance?.length))) {
      throw new Error("Outcome requires provenance, openLoops, and nextAction");
    }
    const now = this.clock().toISOString();
    const next = structuredClone(current);
    const revision = current.revision + 1;
    let branchId = input.branchId ?? next.activeBranchId;
    if (input.kind === "branch_open") {
      if (!input.branch) throw new Error("branch_open requires a branch descriptor");
      const branch = this.makeBranch(input.branch, now);
      next.branches.push(branch);
      next.activeBranchId = branch.id;
      branchId = branch.id;
    }
    if (branchId && !next.branches.some((branch) => branch.id === branchId)) throw new Error("Branch not found");
    if (input.kind === "branch_park") {
      if (!branchId) throw new Error("branch_park requires a branch");
      next.branches.find((branch) => branch.id === branchId)!.status = "parked";
      if (next.activeBranchId === branchId) next.activeBranchId = null;
    }
    if (input.kind === "instruction") next.instruction = input.summary.trim();
    if (input.openLoops !== undefined) next.openLoops = [...input.openLoops];
    if ("nextAction" in input) next.nextAction = input.nextAction ?? null;
    if (input.kind === "blocker") next.status = "blocked";
    else if (input.kind === "outcome" || input.kind === "handoff") next.status = "waiting";
    else next.status = "active";
    next.revision = revision;
    next.updatedAt = now;
    next.lastSurface = structuredClone(input.surface);

    const allDeltas = readJsonl<Delta>(this.deltaFile);
    const anchors = allDeltas.filter((item) => item.workId === input.workId && item.kind === "contract_anchor");
    const previousAnchor = anchors.at(-1);
    if (input.kind === "contract_anchor" && previousAnchor && !input.provenance?.includes(previousAnchor.id)) {
      throw new Error("A revised contract anchor must cite the previous contract delta ID");
    }
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId: input.workId,
      revision,
      kind: input.kind,
      summary: input.summary.trim(),
      surface: structuredClone(input.surface),
      branchId: branchId ?? null,
      targetSurface: input.targetSurface ?? null,
      provenance: [...(input.provenance ?? [])],
      createdAt: now,
      ...(input.kind === "contract_anchor" ? {
        contractVersion: anchors.length + 1,
        previousContractId: previousAnchor?.id ?? null,
      } : {}),
    };
    state.work[index] = next;
    return this.commit(state, delta, input);
  }

  resume(input: { operationId: string; workId: string; expectedRevision: number; surface: Surface; instruction?: string }) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    assertSurface(input.surface);
    const state = this.readState();
    const index = state.work.findIndex((item) => item.id === input.workId);
    if (index < 0) throw new Error("Work item not found");
    const current = state.work[index];
    if (current.revision !== input.expectedRevision) throw new RevisionConflict(current);
    if (["complete", "abandoned"].includes(current.status)) throw new Error("Terminal work cannot be resumed");
    const now = this.clock().toISOString();
    const next = structuredClone(current);
    next.revision += 1;
    next.status = "active";
    next.lastSurface = structuredClone(input.surface);
    next.updatedAt = now;
    if (input.instruction) next.instruction = input.instruction.trim();
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId: input.workId,
      revision: next.revision,
      kind: "resume",
      summary: input.instruction?.trim() ?? `Resumed on ${input.surface.kind}:${input.surface.name}`,
      surface: structuredClone(input.surface),
      branchId: next.activeBranchId,
      targetSurface: null,
      provenance: [],
      createdAt: now,
    };
    state.work[index] = next;
    return this.commit(state, delta, input);
  }

  route(cue: string, limit = 3): RouteMatch[] {
    assertText(cue, "Cue", 500);
    const cueTokens = tokenize(cue);
    return this.readState().work
      .filter((item) => !["complete", "abandoned"].includes(item.status))
      .map((item) => {
        const candidates = [item.topic, item.goal, item.instruction ?? "", ...item.branches.flatMap((branch) => [branch.label, branch.purpose, ...branch.cues])];
        const candidateTokens = new Set(candidates.flatMap(tokenize));
        const matchedCues = cueTokens.filter((token) => candidateTokens.has(token));
        const phraseBoost = candidates.some((candidate) => candidate.toLocaleLowerCase().includes(cue.toLocaleLowerCase())) ? 5 : 0;
        return { workId: item.id, topic: item.topic, score: matchedCues.length + phraseBoost, matchedCues, revision: item.revision, updatedAt: item.updatedAt };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  transfer(workId: string, cue: string, intendedFor: "cloud" | "local", maxBytes = 6_000, includeContract = false): TransferPacket {
    if (maxBytes < 900) throw new Error("Transfer budget must be at least 900 bytes");
    const work = this.getWork(workId);
    const activeBranch = work.branches.find((branch) => branch.id === work.activeBranchId) ?? null;
    const deltas = readJsonl<Delta>(this.deltaFile).filter((item) => item.workId === workId && item.kind !== "contract_anchor");
    const latestAnchor = includeContract
      ? readJsonl<Delta>(this.deltaFile).filter((item) => item.workId === workId && item.kind === "contract_anchor").at(-1)
      : undefined;
    const packetBase = {
      schema: "trajecta.transfer/v1" as const,
      packetId: `packet:${crypto.randomUUID()}`,
      createdAt: this.clock().toISOString(),
      cue,
      from: structuredClone(work.lastSurface),
      intendedFor,
      work: {
        id: work.id,
        topic: work.topic,
        goal: work.goal,
        instruction: work.instruction,
        status: work.status,
        revision: work.revision,
        openLoops: [...work.openLoops],
        nextAction: work.nextAction,
      },
      activeBranch: activeBranch ? structuredClone(activeBranch) : null,
      recentDeltas: [] as TransferPacket["recentDeltas"],
      ...(latestAnchor ? { contractAnchor: {
        id: latestAnchor.id,
        contractVersion: latestAnchor.contractVersion,
        summary: latestAnchor.summary,
        provenance: [...latestAnchor.provenance],
        createdAt: latestAnchor.createdAt,
      }} : {}),
      resume: {
        expectedRevision: work.revision,
        rule: "Resume only this exact work ID with revision compare-and-swap; memory is context, not authority.",
      },
    };
    const selected: TransferPacket["recentDeltas"] = [];
    let truncated = false;
    for (const item of [...deltas].reverse()) {
      const candidate = [{ id: item.id, revision: item.revision, kind: item.kind, summary: item.summary, provenance: [...item.provenance], createdAt: item.createdAt }, ...selected];
      const probe = { ...packetBase, recentDeltas: candidate, budget: { maxBytes, usedBytes: 0, truncated: false } };
      if (Buffer.byteLength(JSON.stringify(probe), "utf8") > maxBytes) {
        truncated = true;
        break;
      }
      selected.unshift(candidate[0]);
    }
    const withoutBudget = { ...packetBase, recentDeltas: selected };
    const budget = { maxBytes, usedBytes: Buffer.byteLength(JSON.stringify(withoutBudget), "utf8"), truncated };
    const packet = { ...withoutBudget, budget };
    packet.budget.usedBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
    if (packet.budget.usedBytes > maxBytes) throw new Error("Core work state exceeds the transfer budget");
    return packet;
  }

  getWork(workId: string) {
    const item = this.readState().work.find((candidate) => candidate.id === workId);
    if (!item) throw new Error("Work item not found");
    return structuredClone(item);
  }

  list() {
    return this.readState().work.map((item) => structuredClone(item));
  }

  history(workId: string) {
    this.getWork(workId);
    return readJsonl<Delta>(this.deltaFile).filter((item) => item.workId === workId);
  }

  private makeBranch(input: { label: string; purpose: string; cues: string[]; returnPoint: string }, now: string): Branch {
    assertText(input.label, "Branch label", 120);
    assertText(input.purpose, "Branch purpose", 500);
    assertText(input.returnPoint, "Branch return point", 500);
    if (!input.cues?.length) throw new Error("A branch requires at least one cue");
    return { id: `branch:${crypto.randomUUID()}`, label: input.label.trim(), purpose: input.purpose.trim(), cues: [...input.cues], returnPoint: input.returnPoint.trim(), status: "exploring", updatedAt: now };
  }
}
