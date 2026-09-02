import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationConflict, RevisionConflict, TrajectaRelay, TrajectaStore } from "../src/index.ts";
import type { Surface } from "../src/index.ts";

const now = new Date("2026-09-02T00:00:00.000Z");
const cloud: Surface = { kind: "cloud", name: "ChatGPT", session: "cloud:planning" };
const local: Surface = { kind: "local", name: "Codex", session: "local:implementation" };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-"));
  return { root, store: new TrajectaStore(root, () => now) };
}

function opened(store: TrajectaStore) {
  return store.open({
    operationId: "operation:open-product",
    topic: "Cloud local product bridge",
    goal: "Let a cloud chatbot plan and a local agent implement the same work",
    surface: cloud,
    initialBranch: {
      label: "public-kernel",
      purpose: "Build the reusable continuity kernel",
      cues: ["Trajecta", "cloud", "local", "bridge"],
      returnPoint: "Return to the product contract after the kernel passes",
    },
  });
}

test("opens one exact work trajectory and routes it by stable cues", () => {
  const { root, store } = fixture();
  try {
    const result = opened(store);
    assert.match(result.work.id, /^work:/);
    assert.equal(result.work.revision, 1);
    assert.equal(result.work.lastSurface.kind, "cloud");
    assert.equal(store.route("continue Trajecta bridge")[0].workId, result.work.id);
    assert.deepEqual(store.route("totally unrelated cue"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cloud transfers bounded work and local resumes with revision CAS", () => {
  const { root, store } = fixture();
  try {
    const first = opened(store);
    const handoff = store.capture({
      operationId: "operation:cloud-handoff",
      workId: first.work.id,
      expectedRevision: 1,
      surface: cloud,
      kind: "handoff",
      summary: "Planning is complete; implement the file-backed store locally.",
      provenance: ["artifact:architecture-v1"],
      openLoops: ["Run the contract suite"],
      nextAction: "Implement and test the store",
      targetSurface: "local",
    });
    const packet = store.transfer(first.work.id, "implement Trajecta locally", "local", 4_000);
    assert.equal(packet.schema, "trajecta.transfer/v1");
    assert.equal(packet.from.kind, "cloud");
    assert.equal(packet.intendedFor, "local");
    assert.equal(packet.resume.expectedRevision, handoff.work.revision);
    assert(packet.budget.usedBytes <= packet.budget.maxBytes);
    assert.doesNotMatch(JSON.stringify(packet), /hidden reasoning|raw transcript/i);

    assert.throws(() => store.resume({
      operationId: "operation:stale-local-resume",
      workId: first.work.id,
      expectedRevision: 1,
      surface: local,
    }), RevisionConflict);
    const resumed = store.resume({
      operationId: "operation:local-resume",
      workId: first.work.id,
      expectedRevision: 2,
      surface: local,
      instruction: "Implement from the selected transfer packet",
    });
    assert.equal(resumed.work.revision, 3);
    assert.equal(resumed.work.lastSurface.kind, "local");
    assert.equal(resumed.work.status, "active");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a local outcome can be transferred back to cloud", () => {
  const { root, store } = fixture();
  try {
    const first = opened(store);
    const localResume = store.resume({ operationId: "operation:local-resume-direct", workId: first.work.id, expectedRevision: 1, surface: local });
    const outcome = store.capture({
      operationId: "operation:local-outcome",
      workId: first.work.id,
      expectedRevision: localResume.work.revision,
      surface: local,
      kind: "outcome",
      summary: "The local implementation and tests passed.",
      provenance: ["test:npm-test", "commit:abc123"],
      openLoops: ["Cloud product review"],
      nextAction: "Review the implementation in cloud",
      targetSurface: "cloud",
    });
    const packet = store.transfer(first.work.id, "review local outcome", "cloud");
    assert.equal(packet.from.kind, "local");
    assert.equal(packet.intendedFor, "cloud");
    assert.equal(packet.work.revision, outcome.work.revision);
    assert.equal(packet.work.nextAction, "Review the implementation in cloud");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contract anchors are append-only, provenance-bearing, and opt-in", () => {
  const { root, store } = fixture();
  try {
    const first = opened(store);
    const anchor = store.capture({
      operationId: "operation:contract-v1",
      workId: first.work.id,
      expectedRevision: 1,
      surface: cloud,
      kind: "contract_anchor",
      summary: "Capture only material deltas. Retrieve by cue. Treat memory as context, never authority.",
      provenance: ["owner:approved-contract-v1"],
    });
    assert.equal(anchor.delta.contractVersion, 1);
    assert.equal("contractAnchor" in store.transfer(first.work.id, "continue bridge", "local"), false);
    const withContract = store.transfer(first.work.id, "check contract bridge", "local", 6_000, true);
    assert.equal(withContract.contractAnchor?.id, anchor.delta.id);

    assert.throws(() => store.capture({
      operationId: "operation:contract-v2-missing-parent",
      workId: first.work.id,
      expectedRevision: 2,
      surface: cloud,
      kind: "contract_anchor",
      summary: "A revision that silently replaces the original contract.",
      provenance: ["owner:approved-contract-v2"],
    }), /previous contract/i);
    const revised = store.capture({
      operationId: "operation:contract-v2",
      workId: first.work.id,
      expectedRevision: 2,
      surface: cloud,
      kind: "contract_anchor",
      summary: "Capture material deltas and support explicit cloud-to-local and local-to-cloud transfer.",
      provenance: [anchor.delta.id, "owner:approved-contract-v2"],
    });
    assert.equal(revised.delta.contractVersion, 2);
    assert.equal(revised.delta.previousContractId, anchor.delta.id);
    assert.equal(store.history(first.work.id).filter((delta) => delta.kind === "contract_anchor").length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("branches park without losing their return point", () => {
  const { root, store } = fixture();
  try {
    const first = opened(store);
    const branchId = first.work.activeBranchId!;
    const parked = store.capture({
      operationId: "operation:park-public-kernel",
      workId: first.work.id,
      expectedRevision: 1,
      surface: local,
      kind: "branch_park",
      branchId,
      summary: "Park the kernel branch while reviewing adapters.",
    });
    const branch = parked.work.branches.find((item) => item.id === branchId)!;
    assert.equal(branch.status, "parked");
    assert.match(branch.returnPoint, /product contract/i);
    assert.equal(parked.work.activeBranchId, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operation IDs are idempotent and reject altered replay", () => {
  const { root, store } = fixture();
  try {
    const input = {
      operationId: "operation:open-idempotent",
      topic: "Idempotency",
      goal: "Do not duplicate one logical mutation",
      surface: cloud,
    };
    const first = store.open(input);
    assert.deepEqual(store.open(input), first);
    assert.throws(() => store.open({ ...input, goal: "Changed input" }), OperationConflict);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("outcomes fail closed without a complete direction audit", () => {
  const { root, store } = fixture();
  try {
    const first = opened(store);
    assert.throws(() => store.capture({
      operationId: "operation:incomplete-outcome",
      workId: first.work.id,
      expectedRevision: 1,
      surface: local,
      kind: "outcome",
      summary: "Done, allegedly.",
    }), /Outcome requires/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("relay exposes a transport-neutral cloud to local adapter contract", () => {
  const { root, store } = fixture();
  try {
    const first = opened(store);
    const cloudRelay = new TrajectaRelay(store, cloud);
    const localRelay = new TrajectaRelay(store, local);
    const outgoing = cloudRelay.handoff({
      operationId: "operation:relay-cloud-local",
      workId: first.work.id,
      expectedRevision: first.work.revision,
      summary: "Cloud planning is ready for local implementation.",
      provenance: ["artifact:relay-plan"],
      openLoops: ["Implement"],
      nextAction: "Implement locally",
      target: "local",
      cue: "implement relay plan",
    });
    assert.equal(outgoing.receipt.level, "packet-created");
    const accepted = localRelay.accept(outgoing.packet, "operation:relay-local-accept");
    assert.equal(accepted.receipt.level, "target-resumed");
    assert.equal(accepted.work.lastSurface.kind, "local");
    assert.throws(() => cloudRelay.accept(outgoing.packet, "operation:wrong-target"), /different surface/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
