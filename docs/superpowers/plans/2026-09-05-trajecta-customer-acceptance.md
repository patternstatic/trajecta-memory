# Trajecta Customer Acceptance Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the central integration, with bounded implementation and independent testing subagents already authorized by Ty. This is the remaining Customer-0 work under the approved delivery goal, not a new feature proposal.

**Goal:** Ship `trajecta-beta verify-acceptance` and prove the full Customer-0 gate from the delivered ZIP without source-repository access.

**Architecture:** Share the already-tested public archive verification primitives between seller tooling and the installed beta. Keep private-key signing, source snapshots, staging, and release construction seller-only. A customer runner first authenticates original ZIP bytes and compares the unpacked and installed files, then runs the real CLI and production service against new isolated state roots and writes explicit evidence.

**Tech Stack:** Existing dependency-free Node ESM, generated JavaScript, Ed25519, local Git, current SDK service and CLI.

**Spec:** `docs/superpowers/specs/2026-09-04-trajecta-private-beta-delivery.md`, sections 6–15. Release contracts remain in `2026-09-05-trajecta-release-integrity.md`.

## Global constraints

- Customer macOS Apple Silicon, Node `>=22.19 <23`; seller Node22.23.1/npm10.9.8.
- No dependency downloads, runtime compiler, arbitrary packet execution, account connector, telemetry, marketing or payment action.
- No source-repo access in the final customer test. Only customer verification code is shared into the package; no private-key signer or build tool is distributed.
- Original ZIP digest comes from `--pinned-zip-sha256`; public key comes from `--public-key` independently. Never obtain either expected value from the archive being verified.
- Receipt remains immutable evaluation evidence with `not-for-sale` and `no-commercial-activation`. Customer results are a separate evidence set; do not change a signed receipt after running tests.
- Rejection must preserve work state, not necessarily the deliberately written rejection receipt. Read-only inspect must preserve the entire SDK state inventory.
- Every runtime state path is under the caller's new `--state-root`. Evidence is written only to the separately explicit new `--evidence-dir`. Both paths must have existing safe parents and may not overlap existing data or the package/bundle.
- The documented CLI uses exactly the six flags in spec section13. No acceptance result is inferred from a parser test or a status string.

## Task 1 — Public verification in the installed SDK

**Files:**
- Create `packages/trajecta-beta/src/release/` public modules for canonical bytes, release contracts/errors, ZIP/tar parsing, signature verification and archive verification.
- Keep seller files at `tools/release-integrity/src/{canonical,contracts,errors,deterministic-zip,tar-reader}.ts` as compatibility re-exports where possible; remove duplicated verifier logic from `assemble.ts` and `signing.ts`.
- Update `release/license-map.json`, `release/payload-policy.json`, staging fixtures for recursive beta runtime modules.
- Create `packages/trajecta-beta/test/release-verification.test.ts`.

**Interface:**
```ts
export interface DeliveredBundleInput {
  archivePath: string;
  pinnedZipSha256: string;
  bundleRoot: string;
  publicKeyPath: string;
  installedPackageRoot: string;
}
export interface DeliveredBundleAudit {
  archiveSha256: string;
  publicKeyFingerprint: string;
  memberCount: number;
  installedMemberCount: number;
  releaseInstant: string;
}
export function verifyDeliveredBundle(input: DeliveredBundleInput): DeliveredBundleAudit;
```

- [ ] RED: authenticate a real signed fixture, then separately alter original ZIP, pin, key, extracted document, installed runtime and add a symlink/extra file. Each must reject before acceptance-state creation; valid files pass. The regression's failure must be observable, not an assertion about imports.
- [ ] Move public primitives without forking behavior. Reuse existing release adversarial tests against the shared implementation. Receipt verification includes exact manifest schema, canonical bytes, recursive tar ledger, notices and every checksum.
- [ ] Hash original ZIP first. Obtain its untrusted DOS timestamp only to drive the canonical ZIP decoder; the signed receipt must agree with that timestamp before any output is trusted. Bound reads to existing archive limits. Compare unpacked tree against all17 authenticated members and installed package bytes/modes against the authenticated nested ledger. Reject links, special files and unexpected files.
- [ ] GREEN: run `node --experimental-strip-types --test packages/trajecta-beta/test/release-verification.test.ts` and `npm run release:check`; commit the shared verification slice and exact staging maps.

## Task 2 — Real isolated acceptance scenarios and evidence

**Files:** create `packages/trajecta-beta/src/acceptance.ts`, `packages/trajecta-beta/src/acceptance-proof.ts`, and `packages/trajecta-beta/test/acceptance.test.ts`. Update only the runner-facing exports if needed; do not modify core resume semantics.

**Interface:**
```ts
export interface AcceptanceProofInput { root: string; bin: string; }
export interface AcceptanceProofResult {
  checks: Record<string, boolean>;
  commands: Array<{argv: string[]; exitCode: number; stdout: string; stderr: string}>;
  semanticTrace: string[];
  stateInventory: Array<{path: string; sha256: string; bytes: number}>;
  receipts: {stale: string; accepted: string; retry: string; lookup: string};
  finalRevision: number;
}
export async function runAcceptanceProof(input: AcceptanceProofInput): Promise<AcceptanceProofResult>;
export interface AcceptanceInput extends DeliveredBundleInput {
  stateRoot: string; evidenceDir: string; bin: string;
}
export async function runAcceptance(input: AcceptanceInput): Promise<{code: 'ACCEPTANCE_PASSED'; evidencePath: string}>;
```

- [ ] RED: run the production proof with a new root; assert revision4, all checks true, exact receipt equality, and identical normalized semantic traces in a second independent root. Mutating a receipt comparison or stale preservation check must fail. Assert no writes on archive failure, existing state/evidence root, overlap or symlink path.
- [ ] Create a committed minimal Git workspace below the supplied root with credential-free `example.invalid/customer/workspace.git`. Do not use a real user repository. Run installed `doctor`, `demo`, `host init`, `inspect`, `resume` and `receipt` with explicit roots and capture each exit code/output. The runner supplies subprocess `TMPDIR` below the declared root so temporary demo work remains within it.
- [ ] Before those scenarios, `runAcceptance` proves offline installation by invoking the customer's local `npm` against the authenticated bundle tgz in a new child of stateRoot. Clear inherited npm/auth/proxy/registry configuration, write isolated npm config/cache/home/prefix below stateRoot, use `--offline --ignore-scripts --package-lock=false --no-audit --no-fund`, and record npm version, command and exit status. Audit the newly installed package against the same ZIP ledger, then give that installed bin to the proof. No network-service lookup or global install is allowed. The caller's already-installed package is also audited before this new install.
- [ ] Use the same shipped API as recipe1 to prepare stale/current envelopes. Hash kernel state before/after rejection and full state inventory before/after inspect. Wrong capability and branchless packets must fail without printing unauthorized revision or changing kernel state. Preserve the original packet for accepted resume.
- [ ] Assert one current resume, one kernel resume delta, exact retry and lookup bytes. Rebuild an envelope with changed content but the accepted operation ID; expect `OPERATION_CONFLICT` and no competing receipt. A new operation with the consumed target must be refused. Test expiry using a separately issued target and the production registry/service with an injected clock after its deadline; explicitly label this clock-controlled check, not a real30minute wait.
- [ ] Write `evidence.json`, exact receipt files and command traces only under explicit evidence output. Include archive audit, runtime version, before/after digests, target status, normalized trace, state inventory and empty manual-intervention list. Fail if any required check is false; never serialize exceptions/private target capabilities. Repeat the proof in a second child directory and compare semantic traces, not random IDs/timestamps.
- [ ] Record paths in reports relative to the declared roots (and replace root prefixes in command output), while keeping executable argv intact only in memory. For spec13 cleanup proof, inventory the second disposable proof directory, remove only that exact runner-created child after exporting its receipts/evidence, then check every inventoried entry is absent. Preserve the first proof directory for customer inspection. Record cleanup separately from semantic equivalence; neither check implies the other.
- [ ] GREEN: run focused acceptance tests and existing beta tests; commit the runner.

## Task 3 — Installed command, updated guide and package

**Files:** update `packages/trajecta-beta/src/{args,cli}.ts`, parser/CLI tests, release maps and `release/evaluation/payload/START-HERE.{md,html}`. Keep the original six acceptance flags.

```text
trajecta-beta verify-acceptance --archive /absolute/download.zip \
  --pinned-zip-sha256 <independent64hex> --bundle-root /absolute/unpacked \
  --public-key /absolute/independent-public.pem \
  --state-root /absolute/new-state --evidence-dir /absolute/new-evidence
```

- [ ] RED: actual bin rejects missing/duplicate/unknown flags with exit2 and no state writes; valid invocation reaches the authenticated installed-package runner. The parser must not accept these flags on other commands.
- [ ] Route to `runAcceptance` before normal workspace lookup, since the runner creates its own sandbox. Resolve package root/bin from the installed module's location; the customer command may not resolve a source-repo tool or use a fallback global installation.
- [ ] Add one copyable evaluation command to the guide, separate from commercial approval. Clarify stale expected revision2 versus current3; retain the two-minute operator's friction as observed misunderstanding rather than a false claim the original text said3.
- [ ] GREEN: compile and install the new package. Invoke the real installed `verify-acceptance` from outside any source checkout, with original ZIP and independent key/pin. All14 automated checks must pass. Keep #15 as independent operator evidence, never simulate it inside the runner.

## Task 4 — Fresh artifact proof, integration and activation boundary

- [ ] Run `npm run check` and `npm run release:check`, build two identical evaluation archives, verify original bytes with literal pins, and run the installed acceptance command in two fresh customer environments.
- [ ] Obtain an independent review of the complete release/customer diff. Fix material findings and rerun the affected real path. Push/integrate only the private branch already authorized by Ty; do not touch repository visibility, public pages or payment configuration.
- [ ] Fresh operator receives only final archive, pinned digest/key and guide. Record elapsed time, each completed step, verbatim friction and help. No help in the first15minutes; earlier completion is permitted. AI operator evidence does not establish human usability or willingness to pay.
- [ ] Requirement-by-requirement audit of spec13: #1–2 authenticated archive and package audit, #3 actual offline install, #4–12 recorded command/service checks, #13 inventory and disposable-root cleanup verification, #14 independent semantic reproduction, #15 operator record. Preserve failed results as evidence; do not rename them passed.
- [ ] Save exact archive hash, key fingerprint, commit, evidence paths and remaining limits in LWM. Leave commercial activation closed. Present the accepted bytes and final terms/refund/contact/offer decision to Ty only when that decision is actually the remaining gate.

## Central self-review

This plan preserves every Customer-0 check and the non-commercial boundary.
It does not replace actual commands with API-only results: API-only expiry is
explicitly separate while the documented entrypoints are exercised through the
installed bin. Authenticated ZIP, unpacked tree and installed package are three
separate inputs, and each is checked. Exact receipt bytes remain evidence,
not a new authority to execute the packet's text.
