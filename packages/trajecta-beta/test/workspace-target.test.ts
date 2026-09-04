import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  return new TargetRegistry({ stateRoot, clock: () => now, randomBytes: (size) => Buffer.alloc(size, 7) });
}

function targetRecordFile(observation: { stateRoot: string }, targetId: string) {
  return path.join(observation.stateRoot, "targets", `${createHash("sha256").update(targetId).digest("hex")}.json`);
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
    const record = fs.readFileSync(path.join(observation.stateRoot, "targets", `${createHash("sha256").update(card.targetId).digest("hex")}.json`), "utf8");
    assert.ok(record.includes(createHash("sha256").update(card.capability).digest("hex")));
    assert.ok(!record.includes(card.capability));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("registry uses its built-in random source when one is not injected", () => {
  const fixture = makeWorkspace();
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const card = new TargetRegistry({ stateRoot: observation.stateRoot }).issue(observation);
    assert.match(card.targetId, /^target:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(card.capability, /^capability:[A-Za-z0-9_-]{43}$/);
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
    const recordFile = path.join(observation.stateRoot, "targets", `${createHash("sha256").update(card.targetId).digest("hex")}.json`);
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
    const record = JSON.parse(fs.readFileSync(targetRecordFile(observation, card.targetId), "utf8"));
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
    const record = JSON.parse(fs.readFileSync(targetRecordFile(observation, card.targetId), "utf8"));
    assert.equal(record.state, "consumed");
    assert.equal(record.receiptId, "receipt:owner");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});

test("reserve refuses crash-left and symlinked per-target locks without removing them", () => {
  const fixture = makeWorkspace();
  const now = new Date("2026-09-05T00:00:00.000Z");
  try {
    const observation = observeWorkspace(fixture.root, fixture.stateRoot);
    const registry = registryFor(observation.stateRoot, now);
    const card = registry.issue(observation);
    const lock = targetRecordFile(observation, card.targetId).replace(/\.json$/, ".lock");
    fs.writeFileSync(lock, "crash-left", { mode: 0o600 });
    assert.throws(() => registry.reserve(card, "operation:owner", "a".repeat(64), now), errorCode("OPERATION_IN_DOUBT"));
    assert.equal(fs.readFileSync(lock, "utf8"), "crash-left");
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
    fs.chmodSync(observation.stateRoot, 0o755);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    fs.chmodSync(observation.stateRoot, 0o700);
    fs.chmodSync(path.join(observation.stateRoot, "targets"), 0o755);
    assert.throws(() => registry.lookup(card, now), errorCode("OPERATION_IN_DOUBT"));
    fs.chmodSync(path.join(observation.stateRoot, "targets"), 0o700);
    fs.chmodSync(targetRecordFile(observation, card.targetId), 0o644);
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
    const registry = new TargetRegistry({ stateRoot: observation.stateRoot, clock: () => now });
    const cards = [registry.issue(observation), registry.issue(observation), registry.issue(observation)];
    const mutations = [
      { state: "issued", operationId: "operation:impossible", attemptDigest: "a".repeat(64), receiptId: null },
      { state: "reserved", operationId: "operation:impossible", attemptDigest: null, receiptId: null },
      { state: "consumed", operationId: "operation:impossible", attemptDigest: "a".repeat(64), receiptId: null },
    ];
    for (let index = 0; index < cards.length; index++) {
      const file = targetRecordFile(observation, cards[index]!.targetId);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...record, ...mutations[index] }));
      assert.throws(() => registry.lookup(cards[index]!, now), errorCode("OPERATION_IN_DOUBT"));
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.stateRoot, { recursive: true, force: true });
  }
});
