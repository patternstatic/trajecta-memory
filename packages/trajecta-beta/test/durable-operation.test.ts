import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { BetaError, OperationJournal, ReceiptStore, withWriterLock, type LocalResumeReceiptV1 } from "../src/index.ts";
import { TrajectaStore } from "../../../src/index.ts";

const now = "2026-09-05T00:00:00.000Z";
const input = { operationId: "operation:one", attemptDigest: "a".repeat(64), envelopeId: "envelope:one", targetId: "target:one" };
const acceptance = { source: "runtime-flag" as const, observedAt: now };
const surface = { kind: "local" as const, name: "test", session: "session:one" };
const kernelResult = {
  work: { id: "work:one", topic: "test", goal: "test", instruction: null, status: "active" as const, revision: 2, activeBranchId: "branch:one", branches: [], openLoops: [], nextAction: null, lastSurface: surface, createdAt: now, updatedAt: now },
  delta: { id: "delta:one", operationId: `${input.operationId}.kernel`, workId: "work:one", revision: 2, kind: "resume" as const, summary: "resumed", surface, branchId: "branch:one", targetSurface: null, provenance: [], createdAt: now },
};
function receipt(accepted = false): LocalResumeReceiptV1 {
  return { schema: "trajecta.local-resume-receipt/v1", receiptId: "receipt:one", ...input, outcome: accepted ? "accepted" : "rejected", code: accepted ? "RESUMED" : "REVISION_CONFLICT", repositoryFingerprint: "b".repeat(64), stateRootFingerprint: "c".repeat(64), workId: "work:one", branchId: "branch:one", packetId: "packet:one", expectedRevision: 1, observedRevisionBefore: accepted ? 1 : 2, observedRevisionAfter: 2, provenance: [], evidence: [], createdAt: now };
}
function code(want: string) { return (e: unknown) => e instanceof BetaError && e.code === want; }
function root(t: any) {
  const value = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "trajecta-operation-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function file(stateRoot: string, directory: string) { return path.join(stateRoot, directory, `${hash(input.operationId)}.json`); }
function options(stateRoot: string) { return { stateRoot, operationId: input.operationId, clock: () => new Date(now) }; }
function seededOwner(stateRoot: string, change: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(stateRoot, "locks"), { mode: 0o700 });
  const owner = { schema: "trajecta.writer-lock/v1", operationId: input.operationId, pid: process.pid, hostname: os.hostname(), processStartToken: "old process instance", acquiredAt: now, ...change };
  const bytes = Buffer.from(`${JSON.stringify({ event: "acquired", owner })}\n`);
  fs.writeFileSync(path.join(stateRoot, "locks/writer.lock"), bytes, { mode: 0o600 });
  return bytes;
}

test("kernel lock excludes another live writer and keeps one inode after release and callback failure", async (t) => {
  const stateRoot = root(t);
  let inode: number;
  await withWriterLock(options(stateRoot), async () => {
    inode = fs.statSync(path.join(stateRoot, "locks/writer.lock")).ino;
    await assert.rejects(withWriterLock(options(stateRoot), () => assert.fail("contender entered")), code("OPERATION_IN_DOUBT"));
    const source = `import { withWriterLock } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}; try { await withWriterLock({ stateRoot: process.argv[1], operationId: 'operation:two' }, () => { throw Error('entered') }); } catch(e) { console.log(e.code); }`;
    assert.equal(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, stateRoot], { encoding: "utf8" }).trim(), "OPERATION_IN_DOUBT");
  });
  await assert.rejects(withWriterLock(options(stateRoot), () => { throw new Error("callback failed"); }), /callback failed/);
  await withWriterLock(options(stateRoot), () => assert.equal(fs.statSync(path.join(stateRoot, "locks/writer.lock")).ino, inode));
});

test("dead owner token is preserved in quarantine before entering a new writer epoch", async (t) => {
  const stateRoot = root(t);
  const prior = seededOwner(stateRoot);
  const inode = fs.statSync(path.join(stateRoot, "locks/writer.lock")).ino;
  await withWriterLock(options(stateRoot), () => {
    assert.deepEqual(fs.readFileSync(path.join(stateRoot, "locks/quarantine", `${hash(prior)}.json`)), prior);
    assert.equal(fs.statSync(path.join(stateRoot, "locks/writer.lock")).ino, inode);
  });
});

test("other-host, unverifiable, live and unreadable owner epochs fail closed without quarantine or replacement", async (t) => {
  for (const change of [{ hostname: "another-host" }, { pid: -1 }, { processStartToken: execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim() }, { processStartToken: "" }]) {
    const stateRoot = root(t);
    const bytes = seededOwner(stateRoot, change);
    await assert.rejects(withWriterLock(options(stateRoot), () => assert.fail("entered")), code("OPERATION_IN_DOUBT"));
    assert.deepEqual(fs.readFileSync(path.join(stateRoot, "locks/writer.lock")), bytes);
  }
  const stateRoot = root(t);
  seededOwner(stateRoot);
  fs.writeFileSync(path.join(stateRoot, "locks/writer.lock"), "{torn");
  await assert.rejects(withWriterLock(options(stateRoot), () => {}), code("OPERATION_IN_DOUBT"));
  assert.equal(fs.readFileSync(path.join(stateRoot, "locks/writer.lock"), "utf8"), "{torn");
});

test("writer recovers a real killed child while preserving the unmatched owner epoch", async (t) => {
  const stateRoot = root(t);
  const source = `import { withWriterLock } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}; await withWriterLock({stateRoot:process.argv[1],operationId:'operation:child'},async()=>{console.log('ready');await new Promise(()=>setInterval(()=>{},1000));});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, stateRoot]);
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child readiness timed out")), 3000);
    child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("child exited early")); });
  });
  const prior = fs.readFileSync(path.join(stateRoot, "locks/writer.lock"));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited;
  await withWriterLock(options(stateRoot), () => assert.deepEqual(fs.readFileSync(path.join(stateRoot, "locks/quarantine", `${hash(prior)}.json`)), prior));
});

test("operation open binds the complete attempt and read-only lookup does not create state", async (t) => {
  const stateRoot = root(t);
  const journal = new OperationJournal({ stateRoot, clock: () => new Date(now) });
  assert.equal(journal.lookup(input.operationId), null);
  assert.equal(fs.existsSync(path.join(stateRoot, "operations")), false);
  await withWriterLock(options(stateRoot), (writer) => {
    const first = journal.open(input, writer);
    assert.equal(first.state, "created");
    assert.deepEqual(journal.open(input, writer), first);
    for (const change of [{ attemptDigest: "d".repeat(64) }, { envelopeId: "envelope:other" }, { targetId: "target:other" }]) assert.throws(() => journal.open({ ...input, ...change }, writer), code("OPERATION_CONFLICT"));
    first.state = "target-consumed";
    assert.equal(journal.lookup(input.operationId)?.state, "created");
  });
});

test("mutations reject forged, wrong-root, wrong-operation and expired writer leases", async (t) => {
  const stateRoot = root(t), second = root(t);
  const journal = new OperationJournal({ stateRoot });
  const store = new ReceiptStore({ stateRoot });
  assert.throws(() => journal.open(input, {} as any), code("OPERATION_IN_DOUBT"));
  let expired: any;
  await withWriterLock(options(stateRoot), (writer) => {
    expired = writer; journal.open(input, writer);
    assert.throws(() => new OperationJournal({ stateRoot: second }).open(input, writer), code("OPERATION_IN_DOUBT"));
    assert.throws(() => journal.open({ ...input, operationId: "operation:other" }, writer), code("OPERATION_IN_DOUBT"));
  });
  assert.throws(() => journal.transition(input.operationId, "inspected", {}, expired), code("OPERATION_IN_DOUBT"));
  assert.throws(() => journal.markInspectionRequired(input.operationId, "uncertain", expired), code("OPERATION_IN_DOUBT"));
  assert.throws(() => store.commit(receipt(), expired), code("OPERATION_IN_DOUBT"));
});

test("accepted adjacent transitions persist acceptance only with reservation and preserve kernel and receipt", async (t) => {
  const stateRoot = root(t);
  await withWriterLock(options(stateRoot), (writer) => {
    const journal = new OperationJournal({ stateRoot, clock: () => new Date(now) });
    journal.open(input, writer);
    assert.throws(() => journal.transition(input.operationId, "inspected", { acceptance }, writer), code("OPERATION_CONFLICT"));
    assert.equal(journal.transition(input.operationId, "inspected", {}, writer).acceptance, null);
    assert.throws(() => journal.transition(input.operationId, "reserved", {}, writer), code("OPERATION_CONFLICT"));
    assert.deepEqual(journal.transition(input.operationId, "reserved", { acceptance }, writer).acceptance, acceptance);
    assert.throws(() => journal.transition(input.operationId, "kernel-resumed", {}, writer), code("OPERATION_CONFLICT"));
    journal.transition(input.operationId, "kernel-resumed", { kernelResult }, writer);
    assert.throws(() => journal.transition(input.operationId, "receipt-committed", { receipt: receipt() }, writer), code("OPERATION_CONFLICT"));
    journal.transition(input.operationId, "receipt-committed", { receipt: receipt(true) }, writer);
    const last = journal.transition(input.operationId, "target-consumed", {}, writer);
    assert.deepEqual(last.transitions.map((v) => v.state), ["created", "inspected", "reserved", "kernel-resumed", "receipt-committed", "target-consumed"]);
    assert.deepEqual(last.kernelResult, kernelResult);
    assert.deepEqual(journal.transition(input.operationId, "target-consumed", {}, writer), last);
    assert.throws(() => journal.transition(input.operationId, "target-consumed", { receipt: { ...receipt(true), receiptId: "receipt:other" } }, writer), code("OPERATION_CONFLICT"));
  });
});

test("rejection path cannot reserve, gain acceptance, use an accepted receipt, or consume", async (t) => {
  const stateRoot = root(t);
  await withWriterLock(options(stateRoot), (writer) => {
    const journal = new OperationJournal({ stateRoot }); journal.open(input, writer);
    assert.throws(() => journal.transition(input.operationId, "receipt-committed", { receipt: receipt() }, writer), code("OPERATION_CONFLICT"));
    journal.transition(input.operationId, "inspected", {}, writer);
    assert.throws(() => journal.transition(input.operationId, "receipt-committed", { receipt: receipt(true) }, writer), code("OPERATION_CONFLICT"));
    const rejected = journal.transition(input.operationId, "receipt-committed", { receipt: receipt() }, writer);
    assert.equal(rejected.acceptance, null); assert.equal(rejected.kernelResult, null);
    for (const next of ["reserved", "kernel-resumed", "target-consumed", "created"] as const) assert.throws(() => journal.transition(input.operationId, next, {}, writer), code("OPERATION_CONFLICT"));
    assert.throws(() => journal.markInspectionRequired(input.operationId, "late", writer), code("OPERATION_CONFLICT"));
  });
});

test("every nonterminal state can become inspection-required with a bounded immutable reason", async (t) => {
  for (const stop of ["created", "inspected", "reserved", "kernel-resumed", "receipt-committed"] as const) {
    const stateRoot = root(t);
    await withWriterLock(options(stateRoot), (writer) => {
      const journal = new OperationJournal({ stateRoot }); journal.open(input, writer);
      for (const [state, patch] of [["inspected", {}], ["reserved", { acceptance }], ["kernel-resumed", { kernelResult }], ["receipt-committed", { receipt: receipt(true) }]] as const) {
        if (journal.lookup(input.operationId)?.state === stop) break;
        journal.transition(input.operationId, state, patch, writer);
      }
      for (const reason of ["", "x".repeat(513), "bad\nreason"]) assert.throws(() => journal.markInspectionRequired(input.operationId, reason, writer), code("OPERATION_CONFLICT"));
      const marked = journal.markInspectionRequired(input.operationId, "interrupted after write", writer);
      assert.equal(marked.state, "inspection-required");
      assert.deepEqual(journal.markInspectionRequired(input.operationId, "interrupted after write", writer), marked);
      assert.throws(() => journal.markInspectionRequired(input.operationId, "changed", writer), code("OPERATION_CONFLICT"));
      assert.throws(() => journal.transition(input.operationId, "inspected", {}, writer), code("OPERATION_CONFLICT"));
    });
  }
});

test("torn or semantically impossible operation snapshots fail closed and remain untouched", async (t) => {
  const stateRoot = root(t);
  await withWriterLock(options(stateRoot), (writer) => {
    const journal = new OperationJournal({ stateRoot }); const original = journal.open(input, writer);
    for (const text of ["{", JSON.stringify({ ...original, acceptance }), JSON.stringify({ ...original, state: "reserved" }), JSON.stringify({ ...original, unexpected: true }), JSON.stringify({ ...original, operationId: "operation:other" })]) {
      fs.writeFileSync(file(stateRoot, "operations"), text);
      assert.throws(() => journal.open(input, writer), code("OPERATION_IN_DOUBT"));
      assert.throws(() => journal.lookup(input.operationId), code("OPERATION_IN_DOUBT"));
      assert.throws(() => journal.transition(input.operationId, "inspected", {}, writer), code("OPERATION_IN_DOUBT"));
      assert.equal(fs.readFileSync(file(stateRoot, "operations"), "utf8"), text);
    }
  });
});

test("receipts preserve canonical first bytes and reject any changed receipt without overwrite", async (t) => {
  const stateRoot = root(t), store = new ReceiptStore({ stateRoot });
  assert.equal(store.readBytes(input.operationId), null);
  assert.equal(fs.existsSync(path.join(stateRoot, "receipts")), false);
  await withWriterLock(options(stateRoot), (writer) => {
    const first = store.commit(receipt(), writer);
    assert.ok(first.toString().startsWith('{"attemptDigest":')); assert.ok(first.toString().endsWith("}\n"));
    assert.deepEqual(store.commit(receipt(), writer), first);
    assert.throws(() => store.commit({ ...receipt(), createdAt: "2026-09-06T00:00:00.000Z" }, writer), code("OPERATION_CONFLICT"));
    assert.deepEqual(store.readBytes(input.operationId), first);
    first.fill(0); assert.equal(store.readBytes(input.operationId)?.[0], 123);
  });
});

test("truncated, wrong-operation and malformed receipt bytes never get replaced", async (t) => {
  const stateRoot = root(t), store = new ReceiptStore({ stateRoot });
  await withWriterLock(options(stateRoot), (writer) => {
    store.commit(receipt(), writer);
    for (const text of ["{", JSON.stringify(receipt()), JSON.stringify({ ...receipt(), operationId: "operation:other" }) + "\n", '{"operationId":"operation:one"}\n']) {
      fs.writeFileSync(file(stateRoot, "receipts"), text);
      assert.throws(() => store.readBytes(input.operationId), code("OPERATION_IN_DOUBT"));
      assert.throws(() => store.commit(receipt(), writer), code("OPERATION_IN_DOUBT"));
      assert.equal(fs.readFileSync(file(stateRoot, "receipts"), "utf8"), text);
    }
  });
});

test("state paths and existing files reject symlinks and insecure modes", async (t) => {
  const stateRoot = root(t), outside = root(t);
  const alias = path.join(root(t), "alias"); fs.symlinkSync(stateRoot, alias);
  await assert.rejects(withWriterLock(options(alias), () => {}), code("OPERATION_IN_DOUBT"));
  await withWriterLock(options(stateRoot), (writer) => {
    const journal = new OperationJournal({ stateRoot }), store = new ReceiptStore({ stateRoot });
    journal.open(input, writer); store.commit(receipt(), writer);
    for (const directory of ["operations", "receipts"]) {
      const target = file(stateRoot, directory), saved = `${target}.saved`;
      fs.renameSync(target, saved); fs.symlinkSync(saved, target);
      const read = () => directory === "operations" ? journal.lookup(input.operationId) : store.readBytes(input.operationId);
      assert.throws(read, code("OPERATION_IN_DOUBT")); fs.unlinkSync(target); fs.renameSync(saved, target);
      fs.chmodSync(target, 0o644); assert.throws(read, code("OPERATION_IN_DOUBT")); fs.chmodSync(target, 0o600);
      fs.chmodSync(path.join(stateRoot, directory), 0o755); assert.throws(read, code("OPERATION_IN_DOUBT")); fs.chmodSync(path.join(stateRoot, directory), 0o700);
    }
  });
  fs.chmodSync(path.join(stateRoot, "locks/writer.lock"), 0o644);
  await assert.rejects(withWriterLock(options(stateRoot), () => {}), code("OPERATION_IN_DOUBT"));
  fs.chmodSync(outside, 0o755);
  await assert.rejects(withWriterLock(options(outside), () => {}), code("OPERATION_IN_DOUBT"));
});

test("writer disappearance invalidates the lease with OPERATION_IN_DOUBT and never writes a release to another inode", async (t) => {
  const stateRoot = root(t);
  await assert.rejects(withWriterLock(options(stateRoot), (writer) => {
    fs.renameSync(path.join(stateRoot, "locks/writer.lock"), path.join(stateRoot, "locks/displaced.lock"));
    assert.throws(() => new OperationJournal({ stateRoot }).open(input, writer), code("OPERATION_IN_DOUBT"));
  }), code("OPERATION_IN_DOUBT"));
  const displaced = fs.readFileSync(path.join(stateRoot, "locks/displaced.lock"), "utf8");
  assert.ok(!displaced.includes('"released"'));
});

test("receipt read rejects an inode substituted during read instead of returning stale bytes", async (t) => {
  const stateRoot = root(t), store = new ReceiptStore({ stateRoot });
  await withWriterLock(options(stateRoot), (writer) => store.commit(receipt(), writer));
  const target = file(stateRoot, "receipts"), original = fs.readSync;
  const changed = Buffer.from("{torn");
  let substituted = false;
  fs.readSync = ((...args: any[]) => {
    const count = (original as any)(...args);
    if (!substituted) {
      substituted = true;
      fs.renameSync(target, `${target}.saved`);
      fs.writeFileSync(target, changed, { mode: 0o600 });
    }
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { assert.throws(() => store.readBytes(input.operationId), code("OPERATION_IN_DOUBT")); }
  finally { fs.readSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(target), changed);
});

test("altered kernel or receipt identity and out-of-stage evidence cannot enter durable state", async (t) => {
  const stateRoot = root(t);
  await withWriterLock(options(stateRoot), (writer) => {
    const journal = new OperationJournal({ stateRoot }); journal.open(input, writer);
    journal.transition(input.operationId, "inspected", {}, writer);
    assert.throws(() => journal.transition(input.operationId, "reserved", { acceptance, kernelResult }, writer), code("OPERATION_CONFLICT"));
    journal.transition(input.operationId, "reserved", { acceptance }, writer);
    for (const invalid of [{ ...kernelResult, work: { ...kernelResult.work, revision: 3 } }, { ...kernelResult, delta: { ...kernelResult.delta, operationId: "operation:other" } }, { work: {}, delta: {} }]) {
      assert.throws(() => journal.transition(input.operationId, "kernel-resumed", { kernelResult: invalid as any }, writer), code("OPERATION_CONFLICT"));
    }
    journal.transition(input.operationId, "kernel-resumed", { kernelResult }, writer);
    for (const change of [{ targetId: "target:other" }, { attemptDigest: "d".repeat(64) }, { workId: "work:other" }, { observedRevisionAfter: 4 }, { provenance: ["ref:z", "ref:a"] }, { extra: true }]) {
      assert.throws(() => journal.transition(input.operationId, "receipt-committed", { receipt: { ...receipt(true), ...change } }, writer), code("OPERATION_CONFLICT"));
    }
    assert.equal(journal.lookup(input.operationId)?.state, "kernel-resumed");
  });
});

for (const multiline of [false, true]) {
  test(`genuine kernel resume result persists with projected ID${multiline ? " and bounded multiline/tab work text" : ""}`, async (t) => {
    const stateRoot = root(t), kernelRoot = root(t), store = new TrajectaStore(kernelRoot, () => new Date(now));
    const workText = multiline ? "First line\nSecond\tpart" : "Bounded work text";
    const opened = store.open({ operationId: "operation:open-fixture", topic: "Fixture", goal: workText, instruction: workText, surface,
      initialBranch: { label: workText, purpose: workText, cues: [workText], returnPoint: workText } });
    const captured = store.capture({ operationId: "operation:capture-fixture", workId: opened.work.id, expectedRevision: 1, kind: "next_action", summary: workText, nextAction: workText, openLoops: [workText], surface });
    const resumeInput = { operationId: `${input.operationId}.kernel`, workId: opened.work.id, expectedRevision: captured.work.revision, surface, instruction: workText };
    const result = store.resume(resumeInput);
    assert.equal(result.delta.operationId, "operation:one.kernel");
    assert.equal(result.work.revision, 3);
    await withWriterLock(options(stateRoot), (writer) => {
      const journal = new OperationJournal({ stateRoot }); journal.open(input, writer);
      journal.transition(input.operationId, "inspected", {}, writer);
      journal.transition(input.operationId, "reserved", { acceptance }, writer);
      const resumed = journal.transition(input.operationId, "kernel-resumed", { kernelResult: result }, writer);
      assert.deepEqual(resumed.kernelResult, result);
      assert.equal(journal.lookup(input.operationId)?.kernelResult?.delta.operationId, "operation:one.kernel");
      const completedReceipt = { ...receipt(true), workId: result.work.id, branchId: result.work.activeBranchId, expectedRevision: 2, observedRevisionBefore: 2, observedRevisionAfter: 3 };
      journal.transition(input.operationId, "receipt-committed", { receipt: completedReceipt }, writer);
      assert.equal(journal.transition(input.operationId, "target-consumed", {}, writer).state, "target-consumed");
      assert.deepEqual(store.resume(resumeInput), result);
    });
  });
}

test("receipt read rejects a substituted parent directory even when the open file metadata stays unchanged", async (t) => {
  for (const replacement of ["directory", "symlink"] as const) {
    const stateRoot = root(t), store = new ReceiptStore({ stateRoot });
    await withWriterLock(options(stateRoot), (writer) => store.commit(receipt(true), writer));
    const directory = path.join(stateRoot, "receipts"), saved = `${directory}.saved`, target = file(stateRoot, "receipts"), original = fs.readSync;
    const before = fs.statSync(target), replacementBytes = Buffer.from("{torn");
    let substituted = false;
    fs.readSync = ((...args: any[]) => {
      const count = (original as any)(...args);
      if (!substituted) {
        substituted = true; fs.renameSync(directory, saved);
        if (replacement === "symlink") fs.symlinkSync(saved, directory);
        else { fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(target, replacementBytes, { mode: 0o600 }); }
        const after = fs.fstatSync(args[0]);
        assert.equal(after.ino, before.ino); assert.equal(after.ctimeMs, before.ctimeMs); assert.equal(after.mtimeMs, before.mtimeMs);
      }
      return count;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try { assert.throws(() => store.readBytes(input.operationId), code("OPERATION_IN_DOUBT")); }
    finally { fs.readSync = original; syncBuiltinESMExports(); }
    if (replacement === "directory") assert.deepEqual(fs.readFileSync(target), replacementBytes);
    else assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
  }
});

test("rejected receipts commit equal before/after revisions and reject null or changed after revisions", async (t) => {
  for (const rejectionCode of ["REVISION_CONFLICT", "BRANCH_MISMATCH"] as const) {
    const stateRoot = root(t), store = new ReceiptStore({ stateRoot });
    const rejected = { ...receipt(), code: rejectionCode, observedRevisionBefore: 2, observedRevisionAfter: 2 };
    await withWriterLock(options(stateRoot), (writer) => {
      const journal = new OperationJournal({ stateRoot }); journal.open(input, writer); journal.transition(input.operationId, "inspected", {}, writer);
      for (const observedRevisionAfter of [null, 1, 3]) {
        const invalid = { ...rejected, observedRevisionAfter };
        assert.throws(() => store.commit(invalid, writer), code("OPERATION_CONFLICT"));
        assert.throws(() => journal.transition(input.operationId, "receipt-committed", { receipt: invalid }, writer), code("OPERATION_CONFLICT"));
        assert.equal(store.readBytes(input.operationId), null);
        assert.equal(journal.lookup(input.operationId)?.state, "inspected");
      }
      const bytes = store.commit(rejected, writer);
      assert.equal(JSON.parse(bytes.toString()).observedRevisionAfter, 2);
      assert.deepEqual(store.commit(rejected, writer), bytes);
      const committed = journal.transition(input.operationId, "receipt-committed", { receipt: rejected }, writer);
      assert.equal(committed.acceptance, null); assert.equal(committed.kernelResult, null);
      for (const observedRevisionAfter of [null, 1, 3]) assert.throws(() => store.commit({ ...rejected, observedRevisionAfter }, writer), code("OPERATION_CONFLICT"));
      assert.deepEqual(store.readBytes(input.operationId), bytes);
    });
  }
});

test("rejected null/null revisions fail before receipt creation for both rejection codes", async (t) => {
  for (const rejectionCode of ["REVISION_CONFLICT", "BRANCH_MISMATCH"] as const) {
    const stateRoot = root(t), store = new ReceiptStore({ stateRoot });
    await withWriterLock(options(stateRoot), (writer) => {
      const invalid = { ...receipt(), code: rejectionCode, observedRevisionBefore: null, observedRevisionAfter: null };
      assert.throws(() => store.commit(invalid, writer), code("OPERATION_CONFLICT"));
      assert.equal(store.readBytes(input.operationId), null);
      assert.equal(fs.existsSync(path.join(stateRoot, "receipts")), false);
    });
  }
});
