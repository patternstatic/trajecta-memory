import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BetaError,
  normalizeRepositoryRemote,
  observeWorkspace,
  readJsonFile,
  TargetRegistry,
} from "../src/index.ts";

function errorCode(code: string) {
  return (error: unknown) => error instanceof BetaError && error.code === code;
}

function makeWorkspace(remote = "https://user:token@github.com/patternstatic/trajecta-memory.git") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "trajecta-workspace-"));
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["config", "user.name", "Trajecta Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root });
  execFileSync("git", ["config", "remote.origin.url", remote], { cwd: root });
  return { root, stateRoot: path.join(root, "..", `${path.basename(root)}-state`) };
}

function registryFor(stateRoot: string, now: Date) {
  let seed = 7;
  return new TargetRegistry({ stateRoot, clock: () => now, randomBytes: (size) => Buffer.alloc(size, seed++) });
}

function targetRecordFile(observation: { stateRoot: string }, targetId: string) {
  return path.join(observation.stateRoot, "targets", `${createHash("sha256").update(targetId).digest("hex")}.journal`);
}

function targetLockFile(observation: { stateRoot: string }, targetId: string) {
  return path.join(observation.stateRoot, "targets", `${createHash("sha256").update(targetId).digest("hex")}.lock`);
}

function journalRecords(file: string): Record<string, unknown>[] {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"));
  return text.trimEnd().split("\n").map((line) => JSON.parse(line));
}

function writeJournal(file: string, records: readonly Record<string, unknown>[]) {
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function waitForChildOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${expected}`)), 2_000);
    child.stdout?.on("data", (chunk) => {
      if (chunk.toString("utf8").includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Child exited before signaling: ${code}`));
      }
    });
  });
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Child exited: ${code}`))));
}

function spawnContendingConsume(stateRoot: string, card: unknown, operationId: string, receiptId: string) {
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const source = [
    `import { TargetRegistry } from ${JSON.stringify(moduleUrl)};`,
    "const [stateRoot, cardText, operationId, receiptId] = process.argv.slice(1);",
    "const registry = new TargetRegistry({ stateRoot, onTargetLockAcquired: () => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } });",
    "registry.consume(JSON.parse(cardText), operationId, receiptId);",
  ].join("\n");
  return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, stateRoot, JSON.stringify(card), operationId, receiptId], { stdio: ["ignore", "pipe", "pipe"] });
}

test("normalizes supported Git remote forms without preserving credentials", () => {
  assert.equal(normalizeRepositoryRemote("git@github.com:PatternStatic/trajecta-memory.git"), "github.com/PatternStatic/trajecta-memory");
  assert.equal(normalizeRepositoryRemote("https://user:token@github.com/patternstatic/trajecta-memory.git"), "github.com/patternstatic/trajecta-memory");
  assert.equal(normalizeRepositoryRemote("ssh://git@github.com/patternstatic/trajecta-memory.git"), "github.com/patternstatic/trajecta-memory");
});

test("workspace observation rejects detached HEAD and missing origin", () => {
  const detached = makeWorkspace();
  const missingOrigin = makeWorkspace();
  execFileSync("git", ["checkout", "--detach"], { cwd: detached.root });
  execFileSync("git", ["remote", "remove", "origin"], { cwd: missingOrigin.root });
  try {
    assert.throws(() => observeWorkspace(detached.root, detached.stateRoot), errorCode("CAPABILITY_UNAVAILABLE"));
    assert.throws(() => observeWorkspace(missingOrigin.root, missingOrigin.stateRoot), errorCode("CAPABILITY_UNAVAILABLE"));
  } finally {
    fs.rmSync(detached.root, { recursive: true, force: true });
    fs.rmSync(missingOrigin.root, { recursive: true, force: true });
  }
});

test("issued card binds normalized workspace fingerprints without serializing host paths or credentials", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const card = registryFor(observation.stateRoot, now).issue(observation);
    const rendered = JSON.stringify(card);
    assert.equal(card.workspace.repository, "github.com/patternstatic/trajecta-memory");
    assert.match(card.workspace.repositoryFingerprint, /^[a-f0-9]{64}$/);
    assert.match(card.workspace.stateRootFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(card.expiresAt, "2026-09-05T00:30:00.000Z");
    assert.ok(!rendered.includes(fixture.root));
    assert.ok(!rendered.includes(fixture.stateRoot));
    assert.ok(!rendered.includes("user:token"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("registry persists capability hash but never raw capability", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const card = registryFor(observation.stateRoot, now).issue(observation);
    const record = fs.readFileSync(targetRecordFile(observation, card.targetId), "utf8");
    assert.ok(record.includes(createHash("sha256").update(card.capability).digest("hex")));
    assert.ok(!record.includes(card.capability));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

for (const [byte, prefix] of [[0xf8, "-"], [0xfc, "_"]] as const) {
  test(`issued capability supports lookup and reservation when entropy starts with ${prefix}`, () => {
    const fixture = makeWorkspace();
    const now = new Date("2026-09-05T00:00:00.000Z");
    const entropy = Buffer.alloc(32, byte);
    const requests: number[] = [];
    try {
      const observation = observeWorkspace(fixture.root, fixture.stateRoot);
      const registry = new TargetRegistry({
        stateRoot: observation.stateRoot,
        clock: () => now,
        randomBytes: (size) => {
          requests.push(size);
          assert.ok(requests.length <= 2, "issuance must not retry entropy generation");
          return Buffer.alloc(size, byte);
        },
      });
      assert.equal(entropy.toString("base64url")[0], prefix);
      const card = registry.issue(observation);
      registry.lookup(card, now);
      registry.reserve(card, "operation:prefix", "a".repeat(64), now);
      assert.deepEqual(requests, [16, 32]);
      assert.match(card.capability, /^capability:x[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(Buffer.from(card.capability.slice("capability:x".length), "base64url"), entropy);
      const journal = targetRecordFile(observation, card.targetId);
      const records = journalRecords(journal);
      assert.deepEqual(records.map((record) => record.state), ["issued", "reserved"]);
      for (const record of records) {
        assert.equal(record.capabilityHash, createHash("sha256").update(card.capability).digest("hex"));
      }
      for (const file of [journal, targetLockFile(observation, card.targetId)]) {
        assert.ok(!fs.readFileSync(file, "utf8").includes(card.capability));
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
    }
  });
}

test("registry uses its built-in random source when one is not injected", () => {
  const fixture = makeWorkspace();
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const card = new TargetRegistry({ stateRoot: observation.stateRoot }).issue(observation);
    assert.match(card.targetId, /^target:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(card.capability, /^capability:x[A-Za-z0-9_-]{43}$/);
    const registry = new TargetRegistry({ stateRoot: observation.stateRoot });
    registry.lookup(card);
    registry.reserve(card, "operation:default-random", "a".repeat(64));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("durable JSON reader treats invalid UTF-8 state as operation-in-doubt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-durable-json-"));
  const file = path.join(root, "record.json");
  fs.writeFileSync(file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
  try {
    assert.throws(() => readJsonFile(file), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable JSON reader treats duplicate state keys as operation-in-doubt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-durable-json-"));
  const file = path.join(root, "record.json");
  fs.writeFileSync(file, '{"state":"issued","state":"consumed"}');
  try {
    assert.throws(() => readJsonFile(file), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lookup rejects an expired target and reserve rechecks expiry without changing the issued record", () => {
  const fixture = makeWorkspace();
  const issuedAt = new Date("2026-09-05T00:00:00.000Z");
  const expiredAt = new Date("2026-09-05T00:30:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, issuedAt);
    const card = registry.issue(observation);
    registry.lookup(card, new Date("2026-09-05T00:29:59.999Z"));
    const recordFile = targetRecordFile(observation, card.targetId);
    const before = fs.readFileSync(recordFile, "utf8");
    assert.throws(() => registry.lookup(card, expiredAt), errorCode("TARGET_EXPIRED"));
    assert.throws(() => registry.reserve(card, "operation:late", "a".repeat(64), expiredAt), errorCode("TARGET_EXPIRED"));
    assert.equal(fs.readFileSync(recordFile, "utf8"), before);
    registry.reserve(card, "operation:timely", "a".repeat(64), new Date("2026-09-05T00:29:59.999Z"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("reserve and consume are idempotent only for the same operation, attempt, and receipt", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    registry.reserve(card, "operation:one", "a".repeat(64), now);
    registry.reserve(card, "operation:one", "a".repeat(64), new Date("2026-09-05T00:31:00.000Z"));
    assert.throws(() => registry.reserve(card, "operation:one", "b".repeat(64), now), errorCode("OPERATION_CONFLICT"));
    assert.throws(() => registry.reserve(card, "operation:two", "a".repeat(64), now), errorCode("TARGET_CONSUMED"));
    registry.consume(card, "operation:one", "receipt:one");
    registry.consume(card, "operation:one", "receipt:one");
    assert.throws(() => registry.consume(card, "operation:two", "receipt:two"), errorCode("TARGET_CONSUMED"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("reserve rejects a concurrent contender while its real per-target transition is held", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const contender = registryFor(observation.stateRoot, now);
    const issuer = registryFor(observation.stateRoot, now);
    const card = issuer.issue(observation);
    let contenderFailure: unknown;
    const owner = new TargetRegistry({
      stateRoot: observation.stateRoot,
      clock: () => now,
      onTargetLockAcquired: () => {
        try {
          contender.reserve(card, "operation:contender", "b".repeat(64), now);
        } catch (error) {
          contenderFailure = error;
        }
      },
    });
    owner.reserve(card, "operation:owner", "a".repeat(64), now);
    assert.ok(errorCode("OPERATION_IN_DOUBT")(contenderFailure));
    const record = journalRecords(targetRecordFile(observation, card.targetId)).at(-1)!;
    assert.equal(record.state, "reserved");
    assert.equal(record.operationId, "operation:owner");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("consume rejects a concurrent contender while its real per-target transition is held", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const issuer = registryFor(observation.stateRoot, now);
    const card = issuer.issue(observation);
    issuer.reserve(card, "operation:owner", "a".repeat(64), now);
    const contender = registryFor(observation.stateRoot, now);
    let contenderFailure: unknown;
    const owner = new TargetRegistry({
      stateRoot: observation.stateRoot,
      clock: () => now,
      onTargetLockAcquired: () => {
        try {
          contender.consume(card, "operation:owner", "receipt:contender");
        } catch (error) {
          contenderFailure = error;
        }
      },
    });
    owner.consume(card, "operation:owner", "receipt:owner");
    assert.ok(errorCode("OPERATION_IN_DOUBT")(contenderFailure));
    const record = journalRecords(targetRecordFile(observation, card.targetId)).at(-1)!;
    assert.equal(record.state, "consumed");
    assert.equal(record.receiptId, "receipt:owner");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("reserve refuses a symlinked persistent per-target lock without removing it", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    const lock = targetLockFile(observation, card.targetId);
    fs.unlinkSync(lock);
    fs.symlinkSync(targetRecordFile(observation, card.targetId), lock);
    assert.throws(() => registry.reserve(card, "operation:owner", "a".repeat(64), now), errorCode("OPERATION_IN_DOUBT"));
    assert.ok(fs.lstatSync(lock).isSymbolicLink());
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("workspace and registry reject symlinked state-root and targets ancestors", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  const externalState = `${fixture.stateRoot}-external`;
  const externalTargets = path.join(fixture.root, "external-targets");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    fs.renameSync(observation.stateRoot, externalState);
    fs.symlinkSync(externalState, observation.stateRoot);
    assert.throws(() => observeWorkspace(fixture.root, path.join(observation.stateRoot, "child")), errorCode("CAPABILITY_UNAVAILABLE"));
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    fs.unlinkSync(observation.stateRoot);
    fs.renameSync(externalState, observation.stateRoot);
    fs.renameSync(path.join(observation.stateRoot, "targets"), externalTargets);
    fs.symlinkSync(externalTargets, path.join(observation.stateRoot, "targets"));
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
    fs.rmSync(externalState, { recursive: true, force: true });
  }
});

test("registry rejects insecure private directory and record modes", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    assert.equal(fs.statSync(observation.stateRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(observation.stateRoot, "targets")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(targetRecordFile(observation, card.targetId)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(targetLockFile(observation, card.targetId)).mode & 0o777, 0o600);
    fs.chmodSync(observation.stateRoot, 0o755);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    fs.chmodSync(observation.stateRoot, 0o700);
    fs.chmodSync(path.join(observation.stateRoot, "targets"), 0o755);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    fs.chmodSync(path.join(observation.stateRoot, "targets"), 0o700);
    fs.chmodSync(targetRecordFile(observation, card.targetId), 0o644);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    fs.chmodSync(targetRecordFile(observation, card.targetId), 0o600);
    fs.chmodSync(targetLockFile(observation, card.targetId), 0o644);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("registry treats impossible issued, reserved, and consumed record combinations as in-doubt", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const cards = [registry.issue(observation), registry.issue(observation), registry.issue(observation)];
    const mutations = [
      { state: "issued", operationId: "operation:impossible", attemptDigest: "a".repeat(64), receiptId: null },
      { state: "reserved", operationId: "operation:impossible", attemptDigest: null, receiptId: null },
      { state: "consumed", operationId: "operation:impossible", attemptDigest: "a".repeat(64), receiptId: null },
    ];
    for (let index = 0; index < cards.length; index++) {
      const file = targetRecordFile(observation, cards[index]!.targetId);
      const record = journalRecords(file)[0]!;
      writeJournal(file, [{ ...record, ...mutations[index] }]);
      assert.throws(() => registry.lookup(cards[index]!, now), errorCode("OPERATION_IN_DOUBT"));
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("target state uses a newline-terminated append-only journal and rejects torn or illegal chains", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    const journal = targetRecordFile(observation, card.targetId);
    const [issued] = journalRecords(journal);
    fs.appendFileSync(journal, '{"schema":"trajecta.local-target-record/v1"}');
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    writeJournal(journal, [issued!, { ...issued!, state: "consumed", operationId: "operation:illegal", attemptDigest: "a".repeat(64), receiptId: "receipt:illegal" }]);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("durable journal rejects empty opaque record identifiers", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    const journal = targetRecordFile(observation, card.targetId);
    const [issued] = journalRecords(journal);
    writeJournal(journal, [{ ...issued!, targetId: "" }]);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("durable journal rejects extra record/workspace keys and non-increasing timestamps", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const cards = [registry.issue(observation), registry.issue(observation), registry.issue(observation), registry.issue(observation)];
    const changes = [
      (record: Record<string, unknown>) => ({ ...record, unexpected: true }),
      (record: Record<string, unknown>) => ({ ...record, workspace: { ...(record.workspace as Record<string, unknown>), unexpected: true } }),
      (record: Record<string, unknown>) => ({ ...record, createdAt: "2026-09-05T00:00:00.000Z", expiresAt: "2026-09-05T00:00:00.000Z" }),
      (record: Record<string, unknown>) => ({ ...record, createdAt: "2026-09-05T00:00:01.000Z", expiresAt: "2026-09-05T00:00:00.000Z" }),
    ];
    for (let index = 0; index < cards.length; index++) {
      const file = targetRecordFile(observation, cards[index]!.targetId);
      writeJournal(file, [changes[index]!(journalRecords(file)[0]!)]);
      assert.throws(() => registry.lookup(cards[index]!, now), errorCode("OPERATION_IN_DOUBT"));
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("replacing a persistent lock after descriptor acquisition fails closed", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const issuer = registryFor(observation.stateRoot, now);
    const card = issuer.issue(observation);
    const lock = targetLockFile(observation, card.targetId);
    const orphan = `${lock}.orphan`;
    const registry = new TargetRegistry({
      stateRoot: observation.stateRoot,
      clock: () => now,
      onTargetDescriptorsAcquired: () => {
        fs.renameSync(lock, orphan);
        fs.writeFileSync(lock, fs.readFileSync(orphan), { mode: 0o600 });
      },
    });
    assert.throws(() => registry.reserve(card, "operation:owner", "a".repeat(64), now), errorCode("OPERATION_IN_DOUBT"));
    assert.equal(journalRecords(targetRecordFile(observation, card.targetId)).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("replacing a journal after append cannot be reported or treated as committed", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const issuer = registryFor(observation.stateRoot, now);
    const card = issuer.issue(observation);
    const journal = targetRecordFile(observation, card.targetId);
    const issuedBytes = fs.readFileSync(journal);
    const orphan = `${journal}.orphan`;
    const registry = new TargetRegistry({
      stateRoot: observation.stateRoot,
      clock: () => now,
      onAfterJournalAppend: () => {
        fs.renameSync(journal, orphan);
        fs.writeFileSync(journal, issuedBytes, { mode: 0o600 });
      },
    });
    assert.throws(() => registry.reserve(card, "operation:owner", "a".repeat(64), now), errorCode("OPERATION_IN_DOUBT"));
    assert.equal(journalRecords(journal).length, 1);
    assert.equal(journalRecords(orphan).length, 2);
    registryFor(observation.stateRoot, now).reserve(card, "operation:recovered", "b".repeat(64), now);
    assert.equal(journalRecords(journal).at(-1)!.operationId, "operation:recovered");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("same-receipt consume waits for a held kernel lock then returns idempotently", async () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    registry.reserve(card, "operation:owner", "a".repeat(64), now);
    const child = spawnContendingConsume(observation.stateRoot, card, "operation:owner", "receipt:shared");
    await waitForChildOutput(child, "locked");
    registry.consume(card, "operation:owner", "receipt:shared");
    await waitForChildExit(child);
    registry.consume(card, "operation:owner", "receipt:shared");
    assert.equal(journalRecords(targetRecordFile(observation, card.targetId)).at(-1)!.receiptId, "receipt:shared");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("different receipt consume waits for a held kernel lock then conflicts", async () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    registry.reserve(card, "operation:owner", "a".repeat(64), now);
    const child = spawnContendingConsume(observation.stateRoot, card, "operation:owner", "receipt:child");
    await waitForChildOutput(child, "locked");
    assert.throws(() => registry.consume(card, "operation:owner", "receipt:other"), errorCode("OPERATION_CONFLICT"));
    await waitForChildExit(child);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("persistent kernel lock is released when a child exits without close", async () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    const lock = targetLockFile(observation, card.targetId);
    const source = [
      'import fs from "node:fs";',
      "const file = process.argv[1];",
      "fs.openSync(file, fs.constants.O_RDWR | 0x20 | 0x20000000);",
      "process.stdout.write('locked\\n');",
      "process.exit(0);",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, lock], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForChildOutput(child, "locked");
    await waitForChildExit(child);
    registry.reserve(card, "operation:owner", "a".repeat(64), now);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("kernel no-follow-any rejects an ancestor swapped to a symlink immediately before target open", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  const externalState = `${fixture.stateRoot}-external`;
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const issuer = registryFor(observation.stateRoot, now);
    const card = issuer.issue(observation);
    let swapped = false;
    const registry = new TargetRegistry({
      stateRoot: observation.stateRoot,
      clock: () => now,
      onBeforeTargetOpen: () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(observation.stateRoot, externalState);
        fs.symlinkSync(externalState, observation.stateRoot);
      },
    });
    assert.throws(() => registry.reserve(card, "operation:owner", "a".repeat(64), now), errorCode("OPERATION_IN_DOUBT"));
  } finally {
    try {
      if (fs.lstatSync(fixture.stateRoot).isSymbolicLink()) fs.unlinkSync(fixture.stateRoot);
    } catch {}
    if (fs.existsSync(externalState)) fs.renameSync(externalState, fixture.stateRoot);
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});
