# Trajecta Production Local SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the private Trajecta production local SDK that safely accepts one bounded handoff file, binds it to one exact local workspace target, rejects stale or mis-targeted state without advancing work, resumes once, and returns the same durable receipt on equivalent retry.

**Architecture:** Keep the Apache Trajecta kernel as the revision-CAS authority and place the private SDK in a separate non-distributable development package. First harden the kernel's write-ahead recovery contract; then layer strict JSON decoding, canonical envelopes, an exact workspace target registry, an exclusive writer lock, a recoverable SDK operation journal, receipt storage, and a small CLI above a narrow kernel port. Standalone inspection remains read-only; mutating resume always revalidates under the lock and can reconcile every persisted transition without starting a second kernel resume.

**Tech Stack:** macOS Apple Silicon; Node.js `>=22.19 <23`; TypeScript executed with Node type stripping; `node:test`; built-in `crypto`, `fs`, `path`, `child_process`, `os`, and `util`; Git invoked only with fixed argument arrays; no runtime dependency, network request, daemon, telemetry, or shell-startup modification.

**Spec:** `docs/superpowers/specs/2026-09-04-trajecta-private-beta-delivery.md`

## Global Constraints

- This plan implements only plan 1, **Production local SDK**, from the approved spec.
- The product name is **Trajecta Verified Resume SDK Beta v0.1** and the binary name is `trajecta-beta`.
- The v0.1 product is a local-workspace SDK, not a turnkey ChatGPT-to-Codex adapter and not a native Codex-session capability.
- Reserve the future package name `@patternstatic/trajecta-beta` and version `0.1.0`, but do not create a release `package.json` in this plan. Plan 1 produces repo-local executable SDK tooling; the Release Integrity plan must create and smoke-test the installable customer manifest, dependency staging, publish allowlist, licenses, signatures, and archive.
- Preserve the Apache-2.0 kernel boundary. New beta source stays under `packages/trajecta-beta/`; the root kernel never imports beta modules.
- Support only macOS Apple Silicon and Node.js `>=22.19 <23`.
- Read at most 16 KiB before parsing an inbound file. Require fatal UTF-8, one JSON value with no trailing data, maximum nesting depth 8, no duplicate object keys, and a transfer packet no larger than 6,000 bytes.
- Candidate packet content is untrusted data. Never execute its commands, open its URLs, or load its referenced files.
- Bind a target to one registry, normalized repository fingerprint, state-root fingerprint, and exact non-detached Git branch; never use title, latest, current window, or frontmost selection.
- Do not serialize credentials, cookies, prompts, transcripts, hidden reasoning, remote tokens, or absolute home paths into target cards, envelopes, receipts, or normal CLI output.
- Standalone `inspect` performs no durable write. `resume` repeats validation under an exclusive writer lock before any kernel mutation.
- Equivalent operation replay resolves before live expiry/revision checks and returns the original receipt bytes. Reusing an operation ID with altered canonical input fails without a competing receipt.
- A stale, wrong-target, wrong-branch, expired, or unaccepted handoff must not advance kernel work or consume its target.
- One accepted handoff advances the exact work revision once, commits one receipt, and consumes the target once.
- Recovery may finish an already reserved exact operation but must never start a second kernel resume. Ambiguous state returns `OPERATION_IN_DOUBT`.
- Preserve the three existing untracked research/business documents. Stage only files named by each task.
- Do not create a buyer ZIP, commercial terms, Payhip delivery, payment, marketing, or public post in this plan.

## File Map

| File | Responsibility |
|---|---|
| `src/store.ts` | Recoverable kernel write-ahead transaction and exact replay beneath the SDK |
| `src/index.ts` | Export kernel recovery errors and the bounded transfer-packet validator |
| `src/adapters/proof/attempt-contract.ts` | Reusable bounded `TransferPacket` assertion and locale-independent canonical key order |
| `test/store-recovery.test.ts` | Fault-injection proof for reserve/delta/state recovery and ambiguous-state rejection |
| `packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md` | States that plan-1 tooling is repo-local and not a customer/release package |
| `packages/trajecta-beta/src/errors.ts` | Stable failure codes, plain-language explanations, and safe next actions |
| `packages/trajecta-beta/src/strict-json.ts` | 16 KiB pre-read limit, fatal UTF-8 decoder, duplicate-key/depth/trailing-data rejection |
| `packages/trajecta-beta/src/canonical.ts` | Locale-independent canonical JSON and SHA-256 helpers |
| `packages/trajecta-beta/src/contracts.ts` | Local target card, resume envelope, inspection, operation, and receipt contracts |
| `packages/trajecta-beta/src/envelope.ts` | Envelope creation, integrity digest, schema/bounds/expiry validation |
| `packages/trajecta-beta/src/workspace.ts` | Fixed-argv Git observation, credential-stripping remote normalization, exact fingerprints |
| `packages/trajecta-beta/src/target-registry.ts` | Issue, read, reserve, expire, and consume single-use target cards |
| `packages/trajecta-beta/src/durable-file.ts` | Restricted directories and fsync-backed atomic JSON/byte writes |
| `packages/trajecta-beta/src/writer-lock.ts` | One exact state-root writer with safe dead-owner quarantine |
| `packages/trajecta-beta/src/operation-journal.ts` | Canonical-digest operation transitions and recovery state |
| `packages/trajecta-beta/src/receipt-store.ts` | Immutable receipt bytes and exact operation lookup |
| `packages/trajecta-beta/src/kernel-port.ts` | Narrow adapter around `TrajectaStore` resume/work/history/operation authority |
| `packages/trajecta-beta/src/resume-service.ts` | Read-only inspect, locked resume, rejection receipts, accepted recovery, exact replay |
| `packages/trajecta-beta/src/args.ts` | Dependency-free strict CLI argument parsing |
| `packages/trajecta-beta/src/doctor.ts` | Read-only supported-environment and local-state diagnostics |
| `packages/trajecta-beta/src/demo.ts` | Offline real-service stale/current/retry fixture |
| `packages/trajecta-beta/src/cli.ts` | `doctor`, `demo`, `host init`, `inspect`, `resume`, `receipt`, and `version` |
| `packages/trajecta-beta/bin/trajecta-beta` | Executable repo-local launcher with Node type-stripping shebang |
| `packages/trajecta-beta/src/index.ts` | Public SDK exports without exposing seller/release tooling |
| `packages/trajecta-beta/test/helpers.ts` | Fixed valid packet/target/envelope fixtures and bounded temporary-file helpers |
| `packages/trajecta-beta/test/*.test.ts` | Focused contract, target, recovery, service, CLI, and demo tests |
| `test/beta-parent-contract.test.ts` | Root-level proof that the private SDK respects the Apache kernel boundary |
| `package.json` | Root `beta:test`, `beta:demo`, `beta:check`, and full `check` integration |

---

### Task 1: Make kernel operations recoverable after interruption

**Files:**
- Modify: `src/store.ts`
- Modify: `src/index.ts`
- Create: `test/store-recovery.test.ts`

**Interfaces:**
- Consumes: existing `TrajectaStore.open()`, `capture()`, `resume()`, `state.json`, `deltas.jsonl`, and `operations.jsonl` contracts.
- Produces: `OperationInDoubt`, `StoreFaultPoint`, and recoverable v2 operation records containing exact before/after state digests, the intended delta, next state, and result.

- [ ] **Step 1: Write failing fault-injection tests**

Create `test/store-recovery.test.ts` with a reusable resume fixture and these exact cases:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalStoreDigest, OperationConflict, OperationInDoubt, TrajectaStore } from "../src/index.ts";
import type { StoreFaultPoint } from "../src/index.ts";

const now = () => new Date("2026-09-05T00:00:00.000Z");

function fixture(failAt?: StoreFaultPoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-kernel-recovery-"));
  let armed = false;
  const store = new TrajectaStore(root, now, (point) => {
    if (armed && point === failAt) throw new Error(`fault:${point}`);
  });
  const opened = store.open({
    operationId: "operation:recovery-open",
    topic: "Recovery",
    goal: "Resume once after interruption",
    surface: { kind: "local", name: "Local workspace", session: "local:recovery" },
    initialBranch: {
      label: "recovery",
      purpose: "Prove WAL recovery",
      cues: ["recovery"],
      returnPoint: "Compare revision and operation receipt",
    },
  });
  armed = true;
  const input = {
    operationId: "operation:recovery-resume",
    workId: opened.work.id,
    expectedRevision: opened.work.revision,
    surface: { kind: "local" as const, name: "Local workspace", session: "local:recovery" },
    instruction: "Continue exact recovery task",
  };
  return { root, store, opened, input };
}

for (const point of ["after-reserve", "after-delta", "after-state"] as const) {
  test(`kernel replay recovers a ${point} interruption exactly once`, () => {
    const f = fixture(point);
    try {
      assert.throws(() => f.store.resume(f.input), new RegExp(`fault:${point}`));
      const recovered = new TrajectaStore(f.root, now).resume(f.input);
      assert.equal(recovered.work.revision, f.opened.work.revision + 1);
      assert.deepEqual(new TrajectaStore(f.root, now).resume(f.input), recovered);
      assert.equal(new TrajectaStore(f.root, now).history(f.opened.work.id)
        .filter((delta) => delta.operationId === f.input.operationId).length, 1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("kernel rejects changed input after a reserved operation", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    assert.throws(() => new TrajectaStore(f.root, now).resume({
      ...f.input,
      instruction: "Different instruction",
    }), OperationConflict);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel refuses recovery when live state matches neither WAL boundary", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    const stateFile = path.join(f.root, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.work[0].revision += 7;
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel treats a torn final operation record as in doubt", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    fs.appendFileSync(path.join(f.root, "operations.jsonl"), '{"schema":');
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel treats a torn final delta after reservation as in doubt", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    const deltasFile = path.join(f.root, "deltas.jsonl");
    fs.appendFileSync(deltasFile, '{"schema":');
    const tornBytes = fs.readFileSync(deltasFile);
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
    assert.deepEqual(fs.readFileSync(deltasFile), tornBytes);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "state.json"), "utf8"))
      .work[0].revision, f.opened.work.revision);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel v2 digest treats equivalent object key order as the same input", () => {
  const left = { z: 1, nested: { y: true, a: 2 } };
  const right = { nested: { a: 2, y: true }, z: 1 };
  assert.equal(canonicalStoreDigest(left), canonicalStoreDigest(right));
});
```

- [ ] **Step 2: Run the recovery tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/store-recovery.test.ts
```

Expected: FAIL because `OperationInDoubt`, `StoreFaultPoint`, and the third constructor argument do not exist.

- [ ] **Step 3: Add a v2 write-ahead record and fault seam**

In `src/store.ts`, add these shapes and preserve the existing two-argument constructor behavior:

```ts
export type StoreFaultPoint = "after-reserve" | "after-delta" | "after-state";

interface OperationRecordV2 {
  schema: "trajecta.operation/v2";
  operationId: string;
  digest: string;
  state: "reserved" | "committed";
  beforeStateDigest: string;
  nextStateDigest: string;
  delta: Delta;
  nextState: StateFile;
  result: { work: WorkItem; delta: Delta };
}

export class OperationInDoubt extends Error {
  constructor() {
    super("Operation outcome is ambiguous; inspect durable state before retrying");
    this.name = "OperationInDoubt";
  }
}
```

Store `fault?: (point: StoreFaultPoint) => void` on the class. Change `commit()` so it computes `result`, `beforeStateDigest`, and `nextStateDigest`, appends one complete `reserved` v2 record before mutating the delta/state files, calls the three fault points at their named boundaries, and appends `committed` only after the state file is durable.

Implement and export `canonicalStoreDigest()` inside `src/store.ts` using a
kernel-local recursive serializer with code-unit key order. V2 WAL input,
before-state, next-state, delta, and result comparisons all use this function.
The Apache kernel must not import `packages/trajecta-beta`.

Use fsync-backed helpers:

```ts
function appendJsonl(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const descriptor = fs.openSync(file, "a", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Operation log write made no progress");
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  if (!existed) {
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Atomic file write made no progress");
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
```

- [ ] **Step 4: Implement exact reserved-operation reconciliation**

When `replay()` finds an equivalent v2 reservation without a commit:

1. Require the current `state.json` digest to equal either `beforeStateDigest` or `nextStateDigest`.
2. Require zero or one delta with the same operation ID. If one exists, require byte-equivalent canonical JSON to the reserved delta.
3. Append the reserved delta only when it is absent.
4. Write `nextState` only when current state equals `beforeStateDigest`.
5. Re-read and verify `nextStateDigest`, then append the `committed` record and return its stored result.
6. Return `OperationInDoubt` for legacy incomplete reservations, multiple/mismatched deltas, or any other state digest.

`readJsonl(file, role)` must require a newline-terminated final record and map
any torn, malformed, or schema-incoherent operation **or delta** line to
`OperationInDoubt` during replay/recovery; it must never ignore a partial tail.
The role is a closed union (`"operations" | "deltas"`) so both schemas are
validated explicitly. An unreadable/malformed atomic state file is also
`OperationInDoubt`. Unit-test the write-all helper with an injected writer that
returns short positive writes before completion.

Expose `OperationInDoubt` and `StoreFaultPoint` from `src/index.ts`.

- [ ] **Step 5: Run focused and parent regression tests**

Run:

```bash
node --experimental-strip-types --test test/store-recovery.test.ts test/store.test.ts test/adapter-proof.test.ts
```

Expected: PASS; every fault case has one resume delta and revision advances once.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/store.ts src/index.ts test/store-recovery.test.ts
git commit -m "feat: recover interrupted kernel operations"
```

---

### Task 2: Parse bounded JSON and compute canonical digests

**Files:**
- Create: `packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md`
- Create: `packages/trajecta-beta/src/errors.ts`
- Create: `packages/trajecta-beta/src/strict-json.ts`
- Create: `packages/trajecta-beta/src/canonical.ts`
- Create: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/strict-json.test.ts`

**Interfaces:**
- Consumes: at most 16 KiB from one file and Node's fatal `TextDecoder`.
- Produces: `BetaError`, `parseStrictJsonFile()`, `canonicalJson()`, and `canonicalSha256()` without depending on the kernel or envelope contract.

- [ ] **Step 1: Write failing strict-decoder and canonicalization tests**

Add these concrete helpers to `strict-json.test.ts`:

```ts
function errorCode(code: BetaErrorCode) {
  return (error: unknown) => error instanceof BetaError && error.code === code;
}

function writeRaw(contents: string | Uint8Array) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-beta-json-"));
  const file = path.join(root, "input.json");
  fs.writeFileSync(file, contents);
  return { root, file };
}
```

Create tests that assert these exact behaviors:

```ts
test("strict reader rejects before parsing when the file exceeds 16 KiB", () => {
  const { root, file } = writeRaw(`{"value":"${"x".repeat(16_384)}"}`);
  try { assert.throws(() => parseStrictJsonFile(file), errorCode("FILE_TOO_LARGE")); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("strict reader rejects duplicate keys, depth nine, trailing data, and invalid UTF-8", () => {
  assert.throws(() => parseStrictJsonText('{"a":1,"a":2}'), errorCode("DUPLICATE_KEY"));
  assert.throws(() => parseStrictJsonText('[[[[[[[[[0]]]]]]]]]'), errorCode("JSON_TOO_DEEP"));
  assert.throws(() => parseStrictJsonText('{"a":1} true'), errorCode("INVALID_JSON"));
  assert.throws(() => parseStrictJsonBytes(Buffer.from([0xc3, 0x28])), errorCode("INVALID_UTF8"));
});

test("canonical JSON is insertion-order independent and locale independent", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: 2 } }),
    '{"a":{"b":2,"y":true},"z":1}');
});

test("canonical digest changes on a material value change", () => {
  assert.notEqual(canonicalSha256({ value: "left" }), canonicalSha256({ value: "right" }));
});
```

Every raw-file test removes its fresh `os.tmpdir()` directory in `finally`.

- [ ] **Step 2: Run the contract test and verify red**

Run:

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/strict-json.test.ts
```

Expected: FAIL because the strict JSON and canonicalization exports do not exist.

- [ ] **Step 3: Create the non-release development boundary and error contract**

Create `packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md` with this exact position:

```markdown
# Trajecta Beta Development Boundary

This directory contains private, repo-local implementation work for the
approved Trajecta Verified Resume SDK Beta. It is not an installable customer
package and must not be sold or published from this tree.

The later Release Integrity plan owns the reviewed `@patternstatic/trajecta-beta`
package manifest, Apache-core staging and notices, customer file allowlist,
installed-bin smoke test, signatures, and deterministic archive.
```

Define `BetaError` with code and safe next action:

```ts
export class BetaError extends Error {
  constructor(
    readonly code: BetaErrorCode,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = "BetaError";
  }
}
```

Include the spec-required codes plus `FILE_TOO_LARGE`, `INVALID_UTF8`, `INVALID_JSON`, `DUPLICATE_KEY`, `JSON_TOO_DEEP`, `UNSUPPORTED_SCHEMA`, and `OPERATION_CONFLICT`.

- [ ] **Step 4: Implement a real bounded recursive-descent JSON reader**

`strict-json.ts` must inspect file size with `openSync()`/`fstatSync()` before reading, decode with `new TextDecoder("utf-8", { fatal: true })`, and parse exactly one JSON value. Implement a cursor-based recursive descent parser whose object parser owns a `Set<string>` per object and throws before assigning a repeated decoded key. Increment depth on every object/array and reject depth greater than 8. Parse string tokens with JSON escape rules, parse numbers only with `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`, reject non-finite numbers, skip JSON whitespace only, and require end-of-input after the root value.

The public API is:

```ts
export const MAX_ENVELOPE_BYTES = 16 * 1024;
export const MAX_JSON_DEPTH = 8;

export function parseStrictJsonBytes(bytes: Uint8Array): unknown;
export function parseStrictJsonText(text: string): unknown;
export function parseStrictJsonFile(file: string): unknown;
```

Implement `canonicalJson()` in `canonical.ts` with recursive code-unit key
sorting, cycle detection, JSON-value-only input, and rejection of non-finite
numbers. `canonicalSha256()` hashes its exact UTF-8 bytes.

- [ ] **Step 5: Run the focused tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/strict-json.test.ts
```

Expected: PASS for size-before-parse, fatal UTF-8, duplicate keys, maximum
depth, trailing data, canonical order, and value-sensitive digest.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md packages/trajecta-beta/src/errors.ts packages/trajecta-beta/src/strict-json.ts packages/trajecta-beta/src/canonical.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/strict-json.test.ts
git commit -m "feat: parse bounded canonical json"
```

---

### Task 3: Define and verify the local resume envelope

**Files:**
- Create: `packages/trajecta-beta/src/contracts.ts`
- Create: `packages/trajecta-beta/src/envelope.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/helpers.ts`
- Create: `packages/trajecta-beta/test/envelope-contract.test.ts`
- Modify: `src/adapters/proof/attempt-contract.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `TransferPacket`, the existing 6,000-byte packet limits, strict JSON, and canonical SHA-256.
- Produces: `LocalWorkspaceTargetCardV1`, `LocalResumeEnvelopeV1`, `LocalResumeReceiptV1`, `buildLocalResumeEnvelope()`, `assertLocalResumeEnvelope()`, `readLocalResumeEnvelopeBytes()`, and `captureLocalResumeEnvelopeFile()`.

- [ ] **Step 1: Write failing envelope integrity and bounds tests**

Create `test/helpers.ts` with fixed-clock builders for one complete bounded
`TransferPacket`, target card, and unsigned envelope input. The packet builder
sets `budget.usedBytes` to zero, recalculates the final UTF-8 serialized length,
and repeats until the integer no longer changes before returning.

The fixed target uses `target:fixture`, `capability:fixture`,
`registryFingerprint: "a".repeat(64)`, repository
`example.invalid/patternstatic/trajecta-memory`, branch `main`, and fixed
2026-09-05 timestamps. The valid packet uses the complete
`trajecta.transfer/v1` shape with one work, one active branch, one provenance
delta, `intendedFor: "local"`, and a final 6,000-byte budget calculation.

Export this shared assertion helper from `test/helpers.ts` and import it in
every beta contract test that checks a failure code:

```ts
export function errorCode(code: BetaErrorCode) {
  return (error: unknown) => error instanceof BetaError && error.code === code;
}
```

```ts
test("one material envelope byte change fails integrity", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  const changed = structuredClone(envelope);
  changed.packet.work.goal = "altered";
  assert.throws(() => assertLocalResumeEnvelope(changed), errorCode("INTEGRITY_MISMATCH"));
});

test("attempt digest is exactly the verified canonical payload digest", () => {
  const envelope = buildLocalResumeEnvelope(validEnvelopeInput());
  assertLocalResumeEnvelope(envelope);
  assert.equal(attemptDigest(envelope), envelope.integrity.canonicalPayloadDigest);
});
```

Also reject unknown schemas, bad 64-hex digests, non-local packets, missing
active branches, more than 20 evidence/provenance entries, strings above their
declared bounds, and a packet over 6,000 bytes.

- [ ] **Step 2: Run the envelope tests and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/envelope-contract.test.ts
```

Expected: FAIL because envelope contracts and validators do not exist.

- [ ] **Step 3: Define target, envelope, inspection, and receipt types**

Use these exact v1 public shapes in `contracts.ts`:

```ts
export interface LocalWorkspaceTargetCardV1 {
  schema: "trajecta.local-target/v1";
  targetId: string;
  capability: string;
  createdAt: string;
  expiresAt: string;
  registryFingerprint: string;
  workspace: {
    repository: string;
    repositoryFingerprint: string;
    stateRootFingerprint: string;
    branch: string;
  };
}

export interface LocalResumeEnvelopeV1 {
  schema: "trajecta.local-resume-envelope/v1";
  envelopeId: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  target: LocalWorkspaceTargetCardV1;
  packet: TransferPacket;
  integrity: {
    algorithm: "sha256";
    canonicalPayloadDigest: string;
  };
}

export interface LocalResumeInspectionV1 {
  schema: "trajecta.local-resume-inspection/v1";
  envelopeId: string;
  operationId: string;
  targetId: string;
  repository: string;
  workId: string;
  branchId: string;
  expectedRevision: number;
  currentRevision: number;
  nextAction: string | null;
  provenance: string[];
}

export type LocalResumeReceiptCode =
  | "REVISION_CONFLICT"
  | "BRANCH_MISMATCH"
  | "RESUMED";

export interface LocalResumeReceiptV1 {
  schema: "trajecta.local-resume-receipt/v1";
  receiptId: string;
  envelopeId: string;
  operationId: string;
  attemptDigest: string;
  outcome: "rejected" | "accepted";
  code: LocalResumeReceiptCode;
  targetId: string;
  repositoryFingerprint: string;
  stateRootFingerprint: string;
  workId: string;
  branchId: string | null;
  packetId: string;
  expectedRevision: number;
  observedRevisionBefore: number | null;
  observedRevisionAfter: number | null;
  provenance: string[];
  evidence: string[];
  createdAt: string;
}
```

Apply these exact outer-contract bounds before using any field:

| Field | Bound |
|---|---|
| namespaced opaque IDs | 240 characters |
| repository | 240 characters |
| branch | 240 characters |
| timestamps | valid ISO string, at most 64 characters |
| SHA-256 values | exactly 64 lowercase hex characters |
| provenance/evidence arrays | at most 20 unique values |
| each provenance/evidence value | namespaced opaque ID, at most 240 characters |

Derive receipt provenance as sorted unique
`packet.recentDeltas.flatMap(delta => delta.provenance)` and evidence as sorted
unique `packet.recentDeltas.map(delta => delta.id)`. Never accept either from a
separate caller argument.

Export the existing packet validator as `assertTransferPacket()` from
`src/adapters/proof/attempt-contract.ts`; replace locale-sensitive
`localeCompare()` canonical key sorting with code-unit comparison and keep all
current proof tests green.

- [ ] **Step 4: Implement envelope construction and integrity verification**

`canonicalJson()` accepts JSON values only, recursively sorts object keys using code-unit order, and rejects `undefined`, functions, symbols, non-finite numbers, and cycles. `canonicalSha256()` hashes its UTF-8 result.

Envelope integrity covers every field except the `integrity` object:

```ts
export function envelopePayload(envelope: LocalResumeEnvelopeV1) {
  const { integrity: _integrity, ...payload } = envelope;
  return payload;
}

export function buildLocalResumeEnvelope(
  input: Omit<LocalResumeEnvelopeV1, "integrity">,
): LocalResumeEnvelopeV1 {
  return {
    ...structuredClone(input),
    integrity: {
      algorithm: "sha256",
      canonicalPayloadDigest: canonicalSha256(input),
    },
  };
}
```

`readLocalResumeEnvelopeBytes(bytes)` accepts one already captured buffer,
enforces the same 16 KiB/fatal-UTF-8/strict-JSON rules, validates all
schema/ID/string/array/timestamp bounds, calls `assertTransferPacket()`, compares
the canonical digest with `timingSafeEqual`, and returns a deep clone.
`captureLocalResumeEnvelopeFile(file)` opens once without following a symlink,
reads at most 16 KiB plus one sentinel byte into one defensive `Buffer`, closes
the descriptor, and returns `{ bytes, envelope }` by calling the byte API. No
resume path reopens the file. Expiry is exposed as a separate
`assertEnvelopeFresh(envelope, now)` function because committed replay must
resolve before live expiry checks.

Define `attemptDigest(envelope)` to return exactly the already-verified
`envelope.integrity.canonicalPayloadDigest`. This one value is the authority for
SDK journal lookup, target reservation, receipt identity, and equivalent replay.

- [ ] **Step 5: Run focused and proof regression tests**

Run:

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/envelope-contract.test.ts test/adapter-proof.test.ts
```

Expected: PASS, including all malformed-input cases and the existing proof contract.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/trajecta-beta/src/contracts.ts packages/trajecta-beta/src/envelope.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/helpers.ts packages/trajecta-beta/test/envelope-contract.test.ts src/adapters/proof/attempt-contract.ts src/index.ts
git commit -m "feat: define strict local resume envelopes"
```

---

### Task 4: Bind single-use targets to one exact local workspace

**Files:**
- Create: `packages/trajecta-beta/src/durable-file.ts`
- Create: `packages/trajecta-beta/src/workspace.ts`
- Create: `packages/trajecta-beta/src/target-registry.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/workspace-target.test.ts`

**Interfaces:**
- Consumes: exact `cwd`, exact `stateRoot`, fixed-argv Git observations, clock, and random bytes.
- Produces: `observeWorkspace()`, `normalizeRepositoryRemote()`, `TargetRegistry.issue()`, `lookup()`, `reserve()`, and `consume()`.

- [ ] **Step 1: Write failing repository-normalization and target-state tests**

Cover these exact inputs and outputs:

```ts
assert.equal(normalizeRepositoryRemote("git@github.com:PatternStatic/trajecta-memory.git"),
  "github.com/PatternStatic/trajecta-memory");
assert.equal(normalizeRepositoryRemote("https://user:token@github.com/patternstatic/trajecta-memory.git"),
  "github.com/patternstatic/trajecta-memory");
assert.equal(normalizeRepositoryRemote("ssh://git@github.com/patternstatic/trajecta-memory.git"),
  "github.com/patternstatic/trajecta-memory");
```

Add tests proving:

- a detached HEAD or missing `origin` fails `CAPABILITY_UNAVAILABLE`;
- the card contains normalized repository and fingerprints but no absolute path or credential;
- the registry stores only `sha256(capability)`, never the raw capability;
- default expiry is exactly 30 minutes from the injected clock;
- expired lookup returns `TARGET_EXPIRED`;
- a target that expires after read-only lookup but before `reserve(..., now)` is rejected without changing its issued record;
- reserve is idempotent only for the same operation ID and attempt digest;
- stale rejection can leave an issued target reusable;
- consume is idempotent for the same receipt and rejects another operation as `TARGET_CONSUMED`.

- [ ] **Step 2: Run target tests and verify red**

Run:

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/workspace-target.test.ts
```

Expected: FAIL because workspace and target-registry modules do not exist.

- [ ] **Step 3: Implement restricted, fsync-backed durable writes**

`durable-file.ts` exports:

```ts
export function ensurePrivateDirectory(directory: string): void;
export function writeJsonExclusive(file: string, value: unknown): void;
export function writeJsonAtomic(file: string, value: unknown): void;
export function writeBytesExclusive(file: string, bytes: Uint8Array): void;
export function readJsonFile(file: string): unknown;
```

Directories use mode `0o700`; files use `0o600`; exclusive creation uses `wx`.
All byte writes loop until the full buffer is written or a zero-progress write
fails. Atomic replacement writes and fsyncs a sibling temporary file, renames
it, and fsyncs the parent directory; first creation also fsyncs the parent.
Malformed or torn target/operation/receipt JSON maps to `OPERATION_IN_DOUBT`,
never an ignored tail or empty default. Never follow a symlink for the state
root, registry directory, target record, operation record, receipt, or lock.

- [ ] **Step 4: Implement exact workspace observation**

Run Git only as fixed argument arrays in the supplied `cwd`:

```ts
git rev-parse --show-toplevel
git symbolic-ref --quiet --short HEAD
git config --get remote.origin.url
```

`normalizeRepositoryRemote()` strips URL username/password, strips scp-style user prefixes, lowercases only the host, removes one leading slash and one trailing `.git`, rejects query/fragment/control characters, and returns `<host>/<owner>/<repo>`. `observeWorkspace()` returns:

```ts
export interface WorkspaceObservation {
  repository: string;
  repositoryFingerprint: string;
  stateRootFingerprint: string;
  branch: string;
  workspaceRoot: string; // internal only; never serialized by card/receipt renderers
  stateRoot: string;     // internal only; never serialized by card/receipt renderers
}
```

Fingerprint canonical UTF-8 strings with SHA-256. Resolve the Git top level with
`realpathSync()`. For a not-yet-created state root, resolve its nearest existing
parent, reject every remaining `..` or symlink component, append the validated
relative components, and use that canonical intended path for the fingerprint.
An explicit state root may be outside the repository because clean acceptance
tests require that isolation; it remains user-supplied host configuration, is
bound by fingerprint, and is never serialized as a path.

- [ ] **Step 5: Implement the target registry state machine**

Store records at `stateRoot/targets/<sha256(targetId)>.json`:

```ts
type TargetState = "issued" | "reserved" | "consumed";

interface TargetRecordV1 {
  schema: "trajecta.local-target-record/v1";
  targetId: string;
  capabilityHash: string;
  registryFingerprint: string;
  workspace: LocalWorkspaceTargetCardV1["workspace"];
  createdAt: string;
  expiresAt: string;
  state: TargetState;
  operationId: string | null;
  attemptDigest: string | null;
  receiptId: string | null;
}
```

`issue(observation)` generates `target:<uuid>` plus 32 random bytes encoded as `capability:<base64url>`, stores only its hash, and returns a card. `lookup(card, now)` verifies card schema, capability hash with `timingSafeEqual`, registry/workspace equality, expiry, and state without writing. `reserve(card, operationId, attemptDigest, now)` re-reads the record and rechecks capability, exact workspace fields, and expiry immediately before atomic replacement. An expired issued target is never reserved. Recovery may continue only when the record is already reserved by the same operation ID and attempt digest; it does not re-authorize a new reservation after expiry. `consume()` uses atomic replacement and enforces same-operation/same-receipt idempotency.

Define `registryFingerprint` as SHA-256 of the UTF-8 string
`trajecta.local-registry/v1\0<stateRootFingerprint>`. Define
`repositoryFingerprint` and `stateRootFingerprint` as lowercase 64-character
hex. All comparisons use exact bytes; only the fixed-length capability hashes
use `timingSafeEqual`.

- [ ] **Step 6: Run focused tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/workspace-target.test.ts
```

Expected: PASS with no card/record output containing the temporary absolute root or credential-bearing remote.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/trajecta-beta/src/durable-file.ts packages/trajecta-beta/src/workspace.ts packages/trajecta-beta/src/target-registry.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/workspace-target.test.ts
git commit -m "feat: bind targets to exact local workspaces"
```

---

### Task 5: Add exclusive writer, recoverable SDK journal, and immutable receipts

**Files:**
- Create: `packages/trajecta-beta/src/writer-lock.ts`
- Create: `packages/trajecta-beta/src/operation-journal.ts`
- Create: `packages/trajecta-beta/src/receipt-store.ts`
- Modify: `packages/trajecta-beta/src/contracts.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/durable-operation.test.ts`

**Interfaces:**
- Consumes: one exact `stateRoot`, canonical attempt digest, process identity, and `LocalResumeReceiptV1`.
- Produces: `withWriterLock()`, `OperationJournal.open()`, `transition()`, `markInspectionRequired()`, and `ReceiptStore.commit()/readBytes()`.

- [ ] **Step 1: Write failing durability and transition tests**

Test these exact rules:

```ts
const allowed = [
  ["created", "inspected"],
  ["inspected", "reserved"],
  ["inspected", "receipt-committed"],
  ["reserved", "kernel-resumed"],
  ["kernel-resumed", "receipt-committed"],
  ["receipt-committed", "target-consumed"],
] as const;
```

- a second live writer receives `OPERATION_IN_DOUBT`;
- a dead same-host owner with a mismatched process-start token is atomically moved to `locks/quarantine/` before a new lock is acquired;
- an unreadable, other-host, or unverifiable lock is never auto-broken;
- `open()` returns existing data only for the same attempt digest and throws `OPERATION_CONFLICT` for altered input;
- illegal or skipped transitions fail;
- any nonterminal state may move to `inspection-required` with a bounded reason;
- a truncated operation snapshot or receipt maps to `OPERATION_IN_DOUBT` and is never replaced;
- committing a receipt twice with identical bytes returns the first bytes;
- another byte sequence for the same operation fails and never overwrites the first receipt.

- [ ] **Step 2: Run durability tests and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/durable-operation.test.ts
```

Expected: FAIL because writer, journal, and receipt-store exports do not exist.

- [ ] **Step 3: Implement process-bound exclusive writer locking**

Create `stateRoot/locks/writer.lock` with `wx`, mode `0o600`, and this bounded record:

```ts
interface WriterLockV1 {
  schema: "trajecta.writer-lock/v1";
  operationId: string;
  pid: number;
  hostname: string;
  processStartToken: string;
  acquiredAt: string;
}
```

Obtain the macOS process-start token with fixed argv `ps -p <pid> -o lstart=`. On collision, reclaim only when hostname matches and the recorded PID is absent or its current start token differs. Atomically rename a proven-dead record to `locks/quarantine/<sha256(lock-bytes)>.json`; never delete it silently. Always release in `finally` only when the on-disk bytes still equal the acquiring process's bytes.

- [ ] **Step 4: Implement the SDK operation journal**

Use one atomic snapshot at `stateRoot/operations/<sha256(operationId)>.json`:

```ts
export type OperationState =
  | "created"
  | "inspected"
  | "reserved"
  | "kernel-resumed"
  | "receipt-committed"
  | "target-consumed"
  | "inspection-required";

export interface LocalOperationRecordV1 {
  schema: "trajecta.local-operation/v1";
  operationId: string;
  attemptDigest: string;
  envelopeId: string;
  targetId: string;
  state: OperationState;
  transitions: Array<{ state: OperationState; observedAt: string }>;
  acceptance: { source: "runtime-flag"; observedAt: string } | null;
  kernelResult: { work: WorkItem; delta: Delta } | null;
  receipt: LocalResumeReceiptV1 | null;
  doubtReason: string | null;
}
```

Require adjacent allowed transitions. The rejection path is `created -> inspected -> receipt-committed`; it never reserves or consumes a target. A repeated transition to the same state is idempotent only when the complete record is unchanged.
Rejection records keep `acceptance` null. An accepted operation may set
`acceptance` only in the same atomic snapshot that transitions `inspected ->
reserved`; no earlier durable state may imply approval.

- [ ] **Step 5: Implement immutable byte-preserving receipt storage**

Store canonical JSON plus one newline at `stateRoot/receipts/<sha256(operationId)>.json` using exclusive creation. `commit(receipt)` returns the exact on-disk bytes. If the file exists, return it only when bytes match; otherwise throw `OPERATION_CONFLICT`. `readBytes(operationId)` returns a defensive `Buffer` copy and validates that its parsed `operationId` matches the lookup key.

- [ ] **Step 6: Run durability tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/durable-operation.test.ts
```

Expected: PASS; no test leaves a live lock or overwrites receipt bytes.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/trajecta-beta/src/writer-lock.ts packages/trajecta-beta/src/operation-journal.ts packages/trajecta-beta/src/receipt-store.ts packages/trajecta-beta/src/contracts.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/durable-operation.test.ts
git commit -m "feat: persist recoverable local resume operations"
```

---

### Task 6: Implement authorized inspection and deterministic rejection

**Files:**
- Create: `packages/trajecta-beta/src/kernel-port.ts`
- Create: `packages/trajecta-beta/src/resume-service.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/resume-inspect-reject.test.ts`

**Interfaces:**
- Consumes: strict envelope reader, workspace observer, target registry, writer lock, operation journal, receipt store, and `TrajectaStore` through `LocalKernelPort`.
- Produces: `LocalResumeService.inspectFile()`, deterministic stale/branch rejection receipts, `receiptBytes()`, and one pure `toKernelResumeInput()` projection; accepted kernel mutation remains disabled until Task 7.

Use this exact construction boundary so tests and the CLI inject the same
authorities:

```ts
export interface LocalResumeServiceOptions {
  stateRoot: string;
  cwd: string;
  kernel: LocalKernelPort;
  registry: TargetRegistry;
  journal: OperationJournal;
  receipts: ReceiptStore;
  clock?: () => Date;
  observe?: (cwd: string, stateRoot: string) => WorkspaceObservation;
}

export class LocalResumeService {
  constructor(options: LocalResumeServiceOptions);
  inspectFile(file: string): LocalResumeInspectionV1;
  resumeFile(file: string, runtime: { accepted: boolean }): Buffer;
  receiptBytes(operationId: string): Buffer;
}
```

Define and unit-test one pure kernel projection in `kernel-port.ts`; both the
initial accepted path and reserved-operation recovery must call this exact
function:

```ts
export function toKernelResumeInput(
  envelope: LocalResumeEnvelopeV1,
): ResumeInput {
  return {
    operationId: `${envelope.operationId}.kernel`,
    workId: envelope.packet.work.id,
    expectedRevision: envelope.packet.resume.expectedRevision,
    surface: {
      kind: "local",
      name: "Trajecta Verified Resume SDK Beta",
      session: `local:${canonicalSha256(envelope.target.targetId).slice(0, 32)}`,
    },
    instruction: envelope.packet.work.nextAction ?? undefined,
  };
}
```

The projection never uses capability, repository path, state-root path, cwd,
prompt, or transcript. Its literals and derived values are part of the v0.1
kernel WAL digest contract.

- [ ] **Step 1: Write a real service fixture and failing behavior tests**

The fixture must create one kernel work item and active branch, issue one target card, export a stale packet, advance the work, and export a current packet. Test:

1. `inspectFile(stale)` returns exact work/branch and expected/current revisions while hashes of kernel state, delta history, target record, operation directory, and receipt directory remain unchanged.
2. Wrong target fails before `getWork()` and returns no live revision.
3. Expired target, wrong repository, wrong state-root fingerprint, and wrong branch fail without work mutation or target consumption.
4. Stale resume commits a `REVISION_CONFLICT` receipt with equal before/after revisions and leaves the target issued.
5. Resume without runtime `accepted: true` returns `USER_ACCEPTANCE_REQUIRED` without creating an operation or receipt.
6. Equivalent stale retry after expiry returns the exact original rejection receipt bytes.
7. Altered stale file with the same operation ID throws `OPERATION_CONFLICT` and creates no second receipt.
8. A current accepted envelope returns `CAPABILITY_UNAVAILABLE` without mutation until Task 7 installs the accepted path.

- [ ] **Step 2: Run the service tests and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/resume-inspect-reject.test.ts
```

Expected: FAIL because `LocalKernelPort` and `LocalResumeService` do not exist.

- [ ] **Step 3: Implement the narrow kernel port**

`kernel-port.ts` wraps only existing authority:

```ts
export interface KernelResumeResult { work: WorkItem; delta: Delta }

export interface LocalKernelPort {
  getWork(workId: string): WorkItem;
  history(workId: string): Delta[];
  resume(input: {
    operationId: string;
    workId: string;
    expectedRevision: number;
    surface: Surface;
    instruction?: string;
  }): KernelResumeResult;
}

export class TrajectaKernelPort implements LocalKernelPort {
  constructor(private readonly store: TrajectaStore) {}
  getWork(workId: string) { return this.store.getWork(workId); }
  history(workId: string) { return this.store.history(workId); }
  resume(input: Parameters<TrajectaStore["resume"]>[0]) { return this.store.resume(input); }
}
```

The beta package may import the Apache core; the core must not import this port.

- [ ] **Step 4: Implement read-only inspection in exact validation order**

`inspectFile(file)` performs:

1. strict file read, schema/bounds, and canonical integrity;
2. envelope expiry;
3. target registry lookup and unused/reserved-for-same-operation check;
4. fresh workspace observation and exact repository/state-root/branch equality;
5. exact work lookup;
6. active branch equality;
7. expected/current revision projection.

Treat `packet.intendedFor === "local"` as part of schema/bounds validation before expiry. Do not instantiate or write an operation journal/receipt. Do not call `getWork()` until target and workspace authorization succeeds. Return `LocalResumeInspectionV1` without absolute paths or capability.

- [ ] **Step 5: Implement ordered validation and deterministic rejection receipts**

`resumeFile(file, { accepted })` calls `captureLocalResumeEnvelopeFile(file)`
once, retains that one bounded byte buffer, strictly parses the complete
envelope, verifies schema/bounds/integrity, and uses
`attemptDigest = envelope.integrity.canonicalPayloadDigest`, then acquires the
writer lock. It never reopens a possibly changed file. Under the lock:

1. Resolve an existing operation first. Altered digest fails; a rejection at
   `receipt-committed` returns stored bytes even if the envelope is now expired.
2. For a new operation, repeat validation against the captured parsed value in
   the complete order: file size, strict JSON, schema and bounds including
   `intendedFor`, integrity, expiry,
   target lookup, workspace/state-root/branch binding, exact work lookup,
   active branch, and expected revision.
3. A pre-authorization target/workspace failure returns a bounded error without
   a receipt or live revision.
4. A stale or branch rejection after authorization creates `created`, moves to
   `inspected`, commits one deterministic receipt, and moves directly to
   `receipt-committed`; it never reserves or consumes the target.
5. Only after a current revision is established, enforce runtime
   `accepted === true`. Missing acceptance returns `USER_ACCEPTANCE_REQUIRED`
   without creating an operation or receipt.
6. Until Task 7, a current accepted envelope returns
   `CAPABILITY_UNAVAILABLE` without mutation.

Derive `receiptId` as `receipt:<first-32-hex-of-sha256(operationId + ":" +
attemptDigest + ":" + outcome + ":" + code)>`. Use the persisted `inspected`
transition timestamp as rejected `createdAt`. Derive provenance and evidence
exactly as Task 3 specifies; never accept them from another caller argument.

- [ ] **Step 6: Run rejection, envelope, and proof tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/resume-inspect-reject.test.ts packages/trajecta-beta/test/envelope-contract.test.ts test/adapter-proof.test.ts
```

Expected: PASS; inspect is byte-for-byte read-only, stale retry returns the
same rejection receipt, and no accepted kernel mutation is yet possible.

- [ ] **Step 7: Commit Task 6**

```bash
git add packages/trajecta-beta/src/kernel-port.ts packages/trajecta-beta/src/resume-service.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/resume-inspect-reject.test.ts
git commit -m "feat: inspect and reject unsafe local resumes"
```

---

### Task 7: Commit one accepted resume and reconcile every crash boundary

**Files:**
- Modify: `packages/trajecta-beta/src/resume-service.ts`
- Modify: `packages/trajecta-beta/src/contracts.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/resume-recovery.test.ts`

**Interfaces:**
- Consumes: Task 6 validation/rejection service, exact attempt digest, target reservation with atomic expiry recheck, recoverable kernel WAL, operation journal, and receipt store.
- Produces: accepted `resumeFile()` plus deterministic reconciliation for `reserved`, `kernel-resumed`, `receipt-committed`, and `target-consumed`.

- [ ] **Step 1: Write failing accepted-path and crash-boundary tests**

Define and export:

```ts
export type ResumeFaultPoint =
  | "after-target-reserve"
  | "after-kernel-resume"
  | "after-receipt-commit"
  | "after-target-consume";
```

Extend `LocalResumeServiceOptions` with
`fault?: (point: ResumeFaultPoint) => void`; production leaves it undefined and
tests inject it at the four named durable boundaries.

Add tests proving:

1. a target that expires after validation but immediately before atomic
   reservation returns `TARGET_EXPIRED`, leaves the record issued, and does not
   create a kernel delta;
2. current accepted resume advances exactly once, stores one receipt, and
   consumes the target;
3. equivalent retry after envelope/target expiry returns the exact original
   receipt bytes and unchanged revision;
4. altered operation reuse fails without a competing receipt;
5. injected failure at each `ResumeFaultPoint`, followed by a new service
   instance and equivalent retry, returns the same receipt/revision and leaves
   exactly one kernel resume delta;
6. any cross-file mismatch becomes `inspection-required` and subsequent retry
   returns `OPERATION_IN_DOUBT` without mutation.

- [ ] **Step 2: Run recovery tests and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/resume-recovery.test.ts
```

Expected: FAIL because the accepted path and recovery fault boundaries are not
implemented.

- [ ] **Step 3: Implement accepted mutation after full validation and acceptance**

After replay lookup, complete every Task 6 validation first. Enforce runtime
acceptance last. Then create `created`, transition `inspected`, call
`registry.reserve(card, operationId, attemptDigest, clock())` so expiry is
rechecked atomically, persist
`acceptance: { source: "runtime-flag", observedAt }` while transitioning to
`reserved`, invoke kernel resume with `toKernelResumeInput(envelope)`, save the
exact result at `kernel-resumed`, commit
canonical receipt bytes, transition `receipt-committed`, consume the target
with that receipt ID, and transition `target-consumed`.

Accepted receipt reconstruction is deterministic: derive its ID with the same
formula as Task 6 and use the persisted `kernel-resumed` transition timestamp
as `createdAt`. Never call the clock or UUID generator again when reconstructing
an existing operation.

- [ ] **Step 4: Reconcile the exact persisted state table**

| Stored state | Recovery action |
|---|---|
| `created` | repeat full validation; never skip acceptance evidence |
| `inspected` | repeat live validation; reserve only when still current and accepted in this invocation |
| `reserved` | require same target reservation; call idempotent kernel resume with `toKernelResumeInput(envelope)` even after expiry |
| `kernel-resumed` | build receipt only from stored kernel result and transition time |
| `receipt-committed` accepted | idempotently consume same target and receipt |
| `receipt-committed` rejected | return stored rejection bytes; leave target issued |
| `target-consumed` | return stored accepted receipt bytes |
| `inspection-required` | throw `OPERATION_IN_DOUBT` without mutation |

Recovery from `created` or `inspected` still requires `accepted: true` in the
new invocation. Recovery from `reserved` requires both the matching target
reservation and the persisted runtime-flag acceptance record, so it may finish
the same operation without asking again. Any
cross-file mismatch moves to `inspection-required` with a bounded reason.

- [ ] **Step 5: Run accepted, rejection, kernel recovery, and proof tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/resume-recovery.test.ts packages/trajecta-beta/test/resume-inspect-reject.test.ts test/store-recovery.test.ts test/adapter-proof.test.ts
```

Expected: PASS; every crash retry returns byte-identical receipt and one kernel
resume delta.

- [ ] **Step 6: Commit Task 7**

```bash
git add packages/trajecta-beta/src/resume-service.ts packages/trajecta-beta/src/contracts.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/resume-recovery.test.ts
git commit -m "feat: resume exact local work with recovery"
```

---

### Task 8: Parse CLI arguments and diagnose the supported environment

**Files:**
- Create: `packages/trajecta-beta/src/args.ts`
- Create: `packages/trajecta-beta/src/doctor.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/args-doctor.test.ts`

**Interfaces:**
- Consumes: raw argv, injected platform/architecture/Node values, actual Git workspace observation, exact `cwd`, and optional `--state-root`.
- Produces: one strict `CliInvocation` union, read-only `runDoctor()`, and product version constant `0.1.0`.

- [ ] **Step 1: Write failing parser and read-only doctor tests**

Assert every accepted command maps to one exact discriminated-union member and
that repeated flags, unknown flags, extra positional values, empty values, and
`--accept=<value>` fail. In a fresh temporary Git repository with branch `main`
and a credential-bearing fake origin, assert:

- exported constants equal `PRODUCT_NAME = "Trajecta Verified Resume SDK Beta"`
  and `PRODUCT_VERSION = "0.1.0"`; process-level version output is Task 9;
- `doctor` is exit 0 only for injected/supported darwin-arm64 and Node `>=22.19 <23`, and its before/after state tree is identical;
- doctor output contains the normalized repository but no credential or absolute home path;
- unsupported platform, architecture, or Node range returns `UNSUPPORTED_ENVIRONMENT`;
- an unverifiable writer lock returns `OPERATION_IN_DOUBT`;
- doctor never creates the state root or changes any durable byte.

- [ ] **Step 2: Run parser/doctor tests and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/args-doctor.test.ts
```

Expected: FAIL because argument and doctor exports do not exist.

- [ ] **Step 3: Implement a strict dependency-free argument parser**

Accept only:

```text
trajecta-beta doctor [--state-root <path>]
trajecta-beta demo [--state-root <path>]
trajecta-beta host init [--state-root <path>] [--out <path>]
trajecta-beta inspect <file> [--state-root <path>]
trajecta-beta resume <file> [--state-root <path>] [--accept]
trajecta-beta receipt <operation-id> [--state-root <path>]
trajecta-beta version
```

Reject repeated flags, unknown flags, extra positional values, empty values, and `--accept=<value>`. Resolve the default state root as `<git-top-level>/.trajecta-beta`; normal output refers to it as `.trajecta-beta`, never by an absolute home path.

- [ ] **Step 4: Implement read-only doctor**

`doctor` reports structured checks for platform, architecture, Node range, Git repository, attached branch, origin normalization, state-root parent writability, state-root symlink rejection, required repo-local SDK files, and existing writer lock. It must not create the state root. Return `UNSUPPORTED_ENVIRONMENT` for any hard requirement and `OPERATION_IN_DOUBT` for an existing unverifiable lock.

- [ ] **Step 5: Run focused tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/args-doctor.test.ts packages/trajecta-beta/test/workspace-target.test.ts
```

Expected: PASS and doctor produces no filesystem delta.

- [ ] **Step 6: Commit Task 8**

```bash
git add packages/trajecta-beta/src/args.ts packages/trajecta-beta/src/doctor.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/args-doctor.test.ts
git commit -m "feat: diagnose the trajecta beta environment"
```

---

### Task 9: Wire the repo-local executable CLI

**Files:**
- Create: `packages/trajecta-beta/src/cli.ts`
- Create: `packages/trajecta-beta/bin/trajecta-beta`
- Modify: `packages/trajecta-beta/src/index.ts`
- Create: `packages/trajecta-beta/test/cli.test.ts`

**Interfaces:**
- Consumes: `CliInvocation`, doctor, workspace/registry, production resume service, and exact receipt bytes.
- Produces: a directly executable repo-local `trajecta-beta` launcher and all approved plan-1 commands except the Task 10 demo body.

- [ ] **Step 1: Write failing executable process tests**

Spawn `packages/trajecta-beta/bin/trajecta-beta` directly, never through an
explicit `node --experimental-strip-types` test shortcut. Assert its executable
mode and shebang work. In a fresh Git repository, prove:

- `version` prints `Trajecta Verified Resume SDK Beta 0.1.0`;
- `doctor` retains the read-only behavior from Task 8;
- `host init` creates `trajecta-target.traj.json` with mode `0o600`, registry state under `.trajecta-beta`, exact branch `main`, and no credential/absolute home path in stdout or card;
- a second default `host init` refuses to overwrite the card;
- `inspect <file>` prints exact work, branch, expected/current revision, provenance, and next action without state changes;
- `resume <file>` without `--accept` prints `USER_ACCEPTANCE_REQUIRED` and exits 2;
- `resume <file> --accept` prints canonical receipt bytes and exits 0;
- `receipt <operation-id>` returns byte-identical receipt JSON;
- unknown commands/flags and missing values exit 2 with bounded usage, not a stack trace.

- [ ] **Step 2: Run the process test and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/cli.test.ts
```

Expected: FAIL because the executable launcher does not exist.

- [ ] **Step 3: Add the actual type-stripping executable boundary**

Create `packages/trajecta-beta/bin/trajecta-beta` with executable Git mode and:

```ts
#!/usr/bin/env -S node --experimental-strip-types
import "../src/cli.ts";
```

Set the executable bit explicitly before the first process test:

```bash
chmod 755 packages/trajecta-beta/bin/trajecta-beta
```

This is repo-local plan-1 tooling, not proof of customer installation. The beta
kernel port uses the single explicit development import
`../../../src/index.ts` to reach the Apache root kernel. No other beta module
imports root internals. `DEVELOPMENT-BOUNDARY.md` and the parent-contract test require the
Release Integrity plan to replace that import with reviewed package staging,
retain Apache path attribution, create the real package manifest, and run an
installed-bin smoke test before any buyer archive exists.

- [ ] **Step 4: Wire commands without widening authority**

- `host init` observes the exact workspace, creates the target registry/card, and writes the card with `wx`.
- `inspect` calls only `LocalResumeService.inspectFile()` and renders its fixed fields.
- `resume` treats `--accept` as runtime user acceptance; the file cannot set it.
- `receipt` writes the exact stored bytes without reparsing/reserializing them.
- `version` uses the Task 8 constant, not live network/package lookup.
- `demo` dispatches to Task 10 and returns `CAPABILITY_UNAVAILABLE` until then.
- errors print exactly `CODE: explanation\nNext: safe action\n`; expected user errors exit 2 and unexpected internal errors exit 1 without a stack trace.

- [ ] **Step 5: Run CLI and service tests**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/cli.test.ts packages/trajecta-beta/test/resume-recovery.test.ts packages/trajecta-beta/test/resume-inspect-reject.test.ts
```

Expected: PASS; the real executable loads the kernel and process output contains
no credential, home path, prompt, transcript, or hidden state.

- [ ] **Step 6: Commit Task 9**

```bash
git add packages/trajecta-beta/src/cli.ts packages/trajecta-beta/bin/trajecta-beta packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/cli.test.ts
git commit -m "feat: expose the trajecta beta local cli"
```

---

### Task 10: Prove the production SDK against its parent contract

**Files:**
- Create: `packages/trajecta-beta/src/demo.ts`
- Create: `packages/trajecta-beta/test/demo.test.ts`
- Create: `test/beta-parent-contract.test.ts`
- Modify: `packages/trajecta-beta/src/cli.ts`
- Modify: `packages/trajecta-beta/src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: only the public SDK service, executable, and kernel port created in Tasks 1–9.
- Produces: the offline `demo` command, two clean-process semantic runs, and root `npm run check` coverage.

- [ ] **Step 1: Write failing demo and parent-contract tests**

The tests must assert a real service flow, not canned output:

```text
TARGET    issued for example.invalid/patternstatic/trajecta-memory · main
STALE     REJECTED REVISION_CONFLICT · revision N -> N
CURRENT   ACCEPTED RESUMED · revision N -> N+1
RETRY     same receipt bytes · revision remains N+1
```

Run the demo twice in different copied tracked-source trees and different empty state roots. Normalize only opaque IDs and timestamps; require identical semantic output. Assert each run contains one accepted kernel resume delta, a durable stale receipt, a durable accepted receipt, a consumed target for the accepted operation, no durable path outside its state root, and no credential/account/home-path marker.

The root parent-contract test also asserts:

- no file under `src/` imports from `packages/trajecta-beta/`;
- no `packages/trajecta-beta/package.json`, pack script, publish script, or customer archive exists in Plan 1;
- the executable has its type-stripping shebang and loads the repo-local Apache kernel through the documented development boundary;
- no beta source contains `ChatGPT-to-Codex`, `codex pair`, Payhip, payment, campaign, telemetry, daemon, or network client code;
- standalone inspect preserves byte hashes of kernel state, delta history, target records, operations, and receipts;
- stale reject, accepted resume, and equivalent retry satisfy the approved spec's exact invariants.

- [ ] **Step 2: Run demo tests and verify red**

```bash
node --experimental-strip-types --test packages/trajecta-beta/test/demo.test.ts test/beta-parent-contract.test.ts
```

Expected: FAIL because the real production demo and root beta scripts do not exist.

- [ ] **Step 3: Implement the offline real-service demo**

`runDemo({ stateRoot, output, clock, randomUUID })` creates a temporary local Git repository with a fixed non-credential remote, opens one real kernel work/branch, issues one exact target card, exports a stale envelope, advances work, exports a current envelope for that still-issued target, and calls the same `LocalResumeService` used by the CLI. Use separate operation IDs for stale and current attempts. Retry the current envelope after advancing the injected clock beyond its expiry to prove replay precedes live expiry validation. Render only fields read from stored receipts and current kernel state.

Remove the temporary Git workspace in `finally`; retain only the caller-supplied state root when the caller explicitly supplied one. With no `--state-root`, the CLI demo creates and removes both temporary workspace and state root after printing the proof.

- [ ] **Step 4: Integrate root scripts**

Update root `package.json` scripts to include:

```json
{
  "beta:test": "node --experimental-strip-types --test packages/trajecta-beta/test/*.test.ts test/beta-parent-contract.test.ts test/store-recovery.test.ts",
  "beta:demo": "packages/trajecta-beta/bin/trajecta-beta demo",
  "beta:check": "npm run beta:test && npm run beta:demo",
  "check": "npm test && npm run demo && npm run proof && npm run beta:check"
}
```

Do not add a pack, publish, archive, payment, or marketing script.

- [ ] **Step 5: Run focused proof twice**

```bash
npm run beta:check
npm run beta:check
```

Expected: both runs PASS and produce the same normalized semantic trace.

- [ ] **Step 6: Run the complete repository gate**

```bash
npm run check
git diff --check
git status --short
```

Expected: all root, proof, clean-room, kernel-recovery, beta contract, service, CLI, and demo tests pass. Status shows only the intended Task 10 files plus the three preserved untracked research/business documents before commit.

- [ ] **Step 7: Commit Task 10**

```bash
git add packages/trajecta-beta/src/demo.ts packages/trajecta-beta/src/cli.ts packages/trajecta-beta/src/index.ts packages/trajecta-beta/test/demo.test.ts test/beta-parent-contract.test.ts package.json
git commit -m "test: prove the production local sdk flow"
```

- [ ] **Step 8: Record the implementation gate without opening later plans**

After independent code review and a fresh full check, record exact commit IDs, test counts, stale/accepted/retry receipt IDs, remaining limitations, and the next gate in LWM. Do not start Release Integrity, Customer-0 packaging, or commercial activation until this Production Local SDK plan is reviewed and merged.

## Execution Choice

Use **Subagent-Driven execution**: one fresh bounded implementer per task, followed by spec-compliance review and code-quality review before the next task. The main Lam agent owns architecture, integrates commits, resolves cross-task decisions, runs the final parent-contract gate, and writes the LWM checkpoint.
