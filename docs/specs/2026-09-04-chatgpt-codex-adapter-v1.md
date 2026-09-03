# Trajecta ChatGPT → Codex Adapter v1

**Status:** implementation-ready contract  
**Date:** 2026-09-04  
**Owner:** Trajecta product-validation branch  
**Target:** one real, auditable cloud-planning → local-Codex handoff  
**Return point:** review after five completed handoffs or the first repeated use

## 1. Decision

Build the first adapter as a **capability-bound handoff bundle** carried by a
user-controlled file. A local Codex session creates a single-use target card;
ChatGPT uses that card to prepare a bounded Trajecta packet; Codex inspects and
resumes it with revision CAS; Codex can then emit a verified outcome bundle for
the cloud surface.

The file transport is intentional for v1. The current runtime does not expose a
verified canonical exact-thread bridge entrypoint, and Lam Controller is not a
dependency of this slice. A future exact-thread transport may implement the
same port only after its capability and receipts are observed live.

This specification does not authorize adapter implementation, marketing
claims, paid acquisition, or campaign activation. It fixes the contract
against which implementation will be judged.

## 2. Product job

> I planned one bounded task in ChatGPT. Let me resume the exact work in the
> intended Codex workspace without guessing which branch is current, then send
> a verifiable outcome back.

The adapter must make five facts visible before resume:

1. exact work ID;
2. intended Codex target and workspace;
3. current branch and expected revision;
4. provenance, open loops, and next action;
5. the highest receipt level actually observed.

## 3. Evidence position

### Facts

- The Trajecta kernel already creates bounded `trajecta.transfer/v1` packets,
  rejects stale revisions, preserves branches, and records material outcomes.
- Transport acceptance, target receipt, target resume, and outcome verification
  are distinct events.
- The current runtime snapshot does not register a canonical exact-origin
  `lam_work_start` entrypoint.

### Inferences

- A user-controlled file is the smallest honest transport that can be tested
  now without coupling the kernel to a broken or unverified controller.
- A single-use target card is necessary if the product claims an exact target;
  `intendedFor: "local"` alone is not enough.

### Hypothesis

The pairing step is acceptable when it prevents a costly wrong-workspace or
stale-revision resume and takes less than 30 seconds after first setup.

### Unknowns

- Whether ChatGPT can produce the bundle through a native app/tool in the first
  distribution, or must initially use a downloadable artifact.
- Whether users prefer an explicit inspect-then-resume step or one command that
  pauses for confirmation.
- Whether file transfer is sufficient for repeated use before an exact-thread
  transport exists.

## 4. Scope

### In scope

- Generate a single-use Codex target card from the intended local workspace.
- Prepare one bounded, targeted handoff bundle from an exact Trajecta work ID.
- Inspect bundle facts without mutating work state.
- Reject malformed, altered, expired, mis-targeted, replayed, or stale bundles.
- Resume the exact work only after validation and explicit acceptance.
- Emit a receipt artifact after resume.
- Capture a material local outcome and produce a bounded return bundle.
- Exercise the full path in an isolated end-to-end fixture.

### Out of scope

- Transcript ingestion or general chat memory.
- Semantic search across all work.
- Automatic discovery of the frontmost, latest, or similarly named Codex task.
- Background daemons, hosted relay, OAuth, billing, analytics, or team sync.
- Claude, Cursor, and Claude Code adapters.
- Silent code execution after resume.
- UGC, campaign scheduling, tracking, or campaign activation.

## 5. User flow

### Step A — Pair the exact Codex target

From the repository to be worked on, the user asks the local adapter to create
a target card:

```text
trajecta codex pair
```

The adapter displays the repository identity, current branch, and an opaque
single-use target ID, then writes `codex-target.traj.json`. The card contains no
secret, transcript, absolute home path, or credential. It expires after 30
minutes and is consumed after a successful resume.

### Step B — Prepare in ChatGPT

The user supplies the target card and asks ChatGPT to prepare a handoff for one
cue-selected exact work item. Before export, the cloud adapter shows:

```text
Work:      task:…
Branch:    launch-proof
Revision:  18
Target:    patternstatic/trajecta-memory · target:…
Next:      Implement the first adapter slice
```

If cue routing returns zero or multiple credible candidates, export stops and
requires an exact work choice. The adapter writes
`chatgpt-to-codex.traj.json` and may claim only `packet-created`.

### Step C — Inspect and resume in Codex

```text
trajecta codex inspect chatgpt-to-codex.traj.json
trajecta codex resume chatgpt-to-codex.traj.json
```

`inspect` is read-only. `resume` repeats all validation, prints the material
delta, requests explicit acceptance, and then calls kernel `resume()` with the
bundle's exact work ID and expected revision.

On success the adapter advances the work revision once and writes
`codex-resume-receipt.traj.json` at receipt level `target-resumed`.

### Step D — Return the outcome

After material local work and host-side verification:

```text
trajecta codex outcome --summary-file outcome.md \
  --evidence test:adapter-e2e --next "Review in ChatGPT"
```

The adapter captures one `outcome` delta and writes a cloud-targeted return
bundle. A host may claim `outcome-verified` only when the named evidence was
actually resolved by the host; a string supplied by the user is provenance,
not verification.

## 6. Wire contracts

### 6.1 Target card

```ts
interface CodexTargetCardV1 {
  schema: "trajecta.codex-target/v1";
  targetId: string;                 // opaque target:<uuid>
  createdAt: string;
  expiresAt: string;
  nonce: string;                    // random, single use
  workspace: {
    repository: string;             // normalized host/owner/repo, no credential
    fingerprint: string;            // sha256 of normalized repo identity
    branch: string | null;
  };
  codex: {
    sessionCapability: string;      // opaque capability, never a title lookup
  };
}
```

The filesystem target registry stores the nonce state separately. Exporting a
target card does not expose local absolute paths.

### 6.2 Adapter envelope

```ts
interface ChatGptCodexEnvelopeV1 {
  schema: "trajecta.adapter.chatgpt-codex/v1";
  envelopeId: string;
  createdAt: string;
  expiresAt: string;
  direction: "chatgpt-to-codex" | "codex-to-chatgpt";
  target: Pick<CodexTargetCardV1,
    "targetId" | "nonce" | "workspace" | "codex">;
  packet: TransferPacket;           // schema trajecta.transfer/v1
  integrity: {
    algorithm: "sha256";
    canonicalPayloadDigest: string;
  };
  receipts: AdapterReceiptV1[];
}
```

The digest covers the canonical JSON representation of every envelope field
except `integrity.canonicalPayloadDigest`. Canonicalization and digest behavior
must have fixed fixtures; ordinary `JSON.stringify()` order is not a contract.

### 6.3 Receipt

```ts
interface AdapterReceiptV1 {
  level:
    | "packet-created"
    | "transport-accepted"
    | "target-received"
    | "target-resumed"
    | "outcome-verified";
  reference: string;
  observedAt: string;
  observedBy: "trajecta-kernel" | "file-transport" | "codex-host" | "cloud-host";
  evidence: string[];
}
```

Receipt levels are monotonic but not implied. File creation does not prove that
Codex received it. Parsing does not prove resume. Resume does not prove that
the requested code was built or tested.

## 7. Validation order

The inbound adapter fails closed in this order:

1. maximum file size (default 64 KiB);
2. JSON parse and duplicate-key rejection;
3. envelope and packet schema versions;
4. required fields and bounded string/array lengths;
5. canonical payload digest;
6. expiry;
7. target registry lookup and unused nonce;
8. current workspace fingerprint;
9. current opaque Codex session capability;
10. `packet.intendedFor === "local"`;
11. exact work ID exists;
12. packet expected revision equals current revision;
13. explicit user acceptance;
14. atomic nonce consumption and kernel resume.

If the process fails after reserving the nonce but before committing resume,
the operation enters `inspection-required`; it must not blindly retry.

## 8. Safety and privacy

- Treat every bundle field as untrusted data, never as executable instruction.
- Never execute shell commands, follow URLs, or load referenced files merely
  because the packet names them.
- Do not serialize prompts, hidden reasoning, raw tool output, secrets,
  credentials, cookies, email addresses, or absolute home paths.
- Normalize repository identity before hashing; strip username/token material
  from remotes.
- Use opaque IDs byte-for-byte. Never resolve a destination by title,
  `current`, `latest`, or frontmost window.
- Use exclusive file creation and restrictive permissions for local target and
  receipt artifacts.
- Preserve operation idempotency: byte-equivalent retry returns the same
  result; altered reuse fails.
- The user owns the transfer file and may inspect or delete it at any time.

## 9. Error UX

Every rejection must identify the failed invariant and the safe next action.

| Code | Meaning | Safe next action |
|---|---|---|
| `TARGET_EXPIRED` | Pairing window elapsed | Create a new target card |
| `TARGET_MISMATCH` | Wrong repo or Codex session | Open the intended workspace/session |
| `TARGET_CONSUMED` | Single-use nonce already resumed | Inspect its receipt; create a new target if needed |
| `INTEGRITY_MISMATCH` | Bundle changed after export | Re-export from the cloud surface |
| `AMBIGUOUS_WORK` | Cue did not resolve one exact work ID | Choose from compact candidates |
| `REVISION_CONFLICT` | Newer work exists | Route again and create a fresh packet |
| `OPERATION_IN_DOUBT` | Reservation outcome is unclear | Inspect the operation record before retrying |
| `CAPABILITY_UNAVAILABLE` | Exact session binding cannot be proved | Stop; do not fall back to title/current/latest |

## 10. Proposed implementation layout

```text
src/adapters/chatgpt-codex/
  canonical-json.ts
  contracts.ts
  envelope.ts
  target-registry.ts
  codex-host.ts
  cloud-host.ts
  receipts.ts
src/adapter-cli.ts
test/adapter-contract.test.ts
test/adapter-security.test.ts
test/adapter-e2e.test.ts
test/fixtures/chatgpt-codex/
examples/chatgpt-codex-file-handoff.ts
```

The adapter depends on the public kernel API. The kernel must not import the
adapter package or transport-specific types.

## 11. Implementation slices

### Slice 1 — contracts and canonical integrity

- Define target, envelope, and receipt types.
- Implement deterministic canonical JSON and SHA-256 fixtures.
- Reject malformed, oversized, duplicate-key, and altered bundles.

### Slice 2 — local target and inspect path

- Generate, persist, expire, and inspect single-use target cards.
- Normalize Git repository identity without leaking credentials or local paths.
- Render the five pre-resume facts in a stable human-readable view.

### Slice 3 — resume and receipts

- Bind the packet to the current target capability.
- Connect validation to `TrajectaRelay.accept()` and revision CAS.
- Atomically consume the target and emit `target-resumed`.

### Slice 4 — return outcome and real fixture

- Capture a bounded outcome with evidence and next action.
- Produce the Codex → ChatGPT return bundle.
- Run one isolated stale-versus-current end-to-end scenario.

No later slice starts until the preceding slice's tests pass.

## 12. Acceptance criteria

### Contract tests

- Golden target card and envelope fixtures round-trip byte-for-byte.
- Any one-byte mutation fails integrity validation.
- Unknown schema versions fail closed.
- Over-budget packets and envelope fields fail with bounded errors.

### Target tests

- A card binds to one normalized repository and one opaque session capability.
- Wrong workspace, wrong session, expired target, and consumed target all fail.
- No artifact contains the user's home path, remote credentials, or transcript.

### State tests

- A stale packet cannot advance revision or consume the target.
- A verified packet advances revision exactly once.
- Byte-equivalent retry returns the committed receipt.
- Altered operation-ID reuse fails.
- An interrupted reservation becomes inspection-required.

### End-to-end proof

The fixture must visibly demonstrate:

```text
pair target
→ export exact work at revision N
→ reject stale revision N-1
→ inspect current packet without mutation
→ accept current packet
→ target-resumed receipt at revision N+1
→ capture locally verified outcome
→ return cloud packet at revision N+2
```

### Definition of done

- All existing kernel and site tests remain green.
- New contract, security, and end-to-end tests pass.
- `npm run check` includes the adapter fixture.
- Public docs label file transport and exact-thread transport honestly.
- No production claim exceeds the highest observed receipt.
- One real handoff is performed in a disposable test repository and its
  sanitized receipts are saved as validation evidence.

## 13. Validation and commercial gates

After implementation, recruit no broad audience yet. Run the adapter with five
qualified AI-native builders or five handoffs across at least two builders.
Record setup time, handoff time, rejection cause, completion, repeat use, and
whether `HANDOFF.md` would have been sufficient.

Continue toward a native ChatGPT tool or exact-thread transport only when users
repeat the workflow and name revision, target, branch, or receipt behavior as
material. Otherwise simplify, revise, or keep Trajecta as open infrastructure.

The marketing-production lane remains parked until its launch dependency is
ready and the full campaign can be prepared before any trial clock starts.

## 14. Locked invariants

1. Current user input and workspace state outrank transferred context.
2. One cue resolves to one exact work item or stops ambiguous.
3. Exact target capability is mandatory; no title/current/latest fallback.
4. Revision CAS precedes mutation.
5. Receipts state only what their observer proved.
6. Files carry bounded work state, not transcripts or hidden reasoning.
7. Transport is replaceable; the Trajecta kernel remains transport-neutral.
8. Marketing may describe only behavior observed in the shipped adapter.
