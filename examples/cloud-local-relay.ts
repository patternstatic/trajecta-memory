import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TrajectaRelay, TrajectaStore } from "../src/index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-demo-"));
const store = new TrajectaStore(root);
const cloud = { kind: "cloud" as const, name: "Cloud Chatbot", session: "cloud:product-room" };
const local = { kind: "local" as const, name: "Local Agent", session: "local:workspace" };

try {
  const opened = store.open({
    operationId: "operation:demo-open",
    topic: "Launch a tiny product",
    goal: "Research in cloud, implement locally, review in cloud",
    surface: cloud,
    initialBranch: {
      label: "first-slice",
      purpose: "Build the smallest verified slice",
      cues: ["launch", "product", "first slice"],
      returnPoint: "Return to cloud for product review after local tests pass",
    },
  });

  const cloudRelay = new TrajectaRelay(store, cloud);
  const localRelay = new TrajectaRelay(store, local);
  const planned = cloudRelay.handoff({
    operationId: "operation:demo-plan",
    workId: opened.work.id,
    expectedRevision: 1,
    summary: "The cloud chatbot selected the first slice and its acceptance criteria.",
    provenance: ["artifact:cloud-plan"],
    openLoops: ["Implement", "Run tests"],
    nextAction: "Build the first slice locally",
    target: "local",
    cue: "build first slice",
  });

  const toLocal = planned.packet;
  const resumed = localRelay.accept(toLocal, "operation:demo-local-resume");
  const built = store.capture({
    operationId: "operation:demo-local-result",
    workId: opened.work.id,
    expectedRevision: resumed.work.revision,
    surface: local,
    kind: "outcome",
    summary: "The local agent implemented the slice and its tests passed.",
    provenance: ["test:local-suite"],
    openLoops: ["Cloud review"],
    nextAction: "Review the verified slice in cloud",
    targetSurface: "cloud",
  });
  const toCloud = store.transfer(opened.work.id, "review verified first slice", "cloud");

  console.log(JSON.stringify({
    trajectory: `${opened.work.lastSurface.kind} → ${resumed.work.lastSurface.kind} → ${toCloud.intendedFor}`,
    revisions: [opened.work.revision, planned.work.revision, resumed.work.revision, built.work.revision],
    next: toCloud.work.nextAction,
    packetBytes: toCloud.budget.usedBytes,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
