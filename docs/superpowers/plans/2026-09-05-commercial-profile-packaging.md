# Commercial Profile Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a deterministic commercial-candidate ZIP whose signed receipt, outer documents, installed-package terms and acceptance evidence all identify the same preparation-only profile.

**Architecture:** Introduce a closed `ReleaseKind` (`evaluation` or `commercial-candidate`) that defaults to evaluation for the existing API and is explicit in the new CLI command. Route the kind through build, staging and assembly. Keep shared recipes and troubleshooting as frozen common sources where their copy is profile-neutral; use commercial overrides for start pages, environment, package boundary, notices and terms. Verify candidate nested/outer terms byte equality and surface the signed receipt schema in acceptance evidence.

**Tech Stack:** Existing TypeScript, Node 22.23.1, node:test, deterministic ZIP/tgz and Ed25519; no dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-trajecta-private-beta-delivery.md`; approved terms in `release/commercial-candidate/LICENSES/BETA-COMMERCIAL-TERMS.txt`.

## Global Constraints

- Existing `build` command and evaluation bytes/validation semantics remain compatible.
- New command is exactly `build-commercial-candidate`; unknown profiles fail closed.
- Commercial candidate means preparation pending activation, not a sale/payment/Customer-0 claim.
- Both outer and installed `BETA-COMMERCIAL-TERMS.txt` must be identical authenticated bytes.
- No actual signing key is read in unit tests; use ephemeral keys.
- No checkout, public post, purchase, refund, money movement or legal seller identity inference.

### Task 1: Route one closed release profile through build

**Files:** Modify `tools/release-integrity/src/assemble.ts`, `build.ts`, `stage-package.ts`, `cli.ts`, `release/payload-policy.json`; create/modify commercial start files; test `cli.test.ts`, `assemble.test.ts`, `stage-package.test.ts`, and source-policy tests.

**Interfaces:** Export `type ReleaseKind = 'evaluation'|'commercial-candidate'`. `BuildReleaseOptions.releaseKind?` is the only optional compatibility field and accepts no other value. `AssemblyInput.releaseKind?` and `StagePackageOptions.releaseKind?` default to evaluation. CLI `build` passes evaluation; `build-commercial-candidate` passes commercial-candidate.

- [ ] Add tests proving the new CLI discriminator, candidate assembly schema, candidate inner terms selection, evaluation default preservation and unknown kind rejection. Run focused tests and observe failure because the profile is not wired.
- [ ] Add the commercial source root to the frozen allowlist. Add explicit profile source mapping; commercial `START-HERE.md/html` and terms come from commercial sources, while the neutral recipes/troubleshooting/environment file remain named explicit shared sources. Never choose paths from user input.
- [ ] Pass release kind through both frozen builds, staging and assembly; choose `buildCommercialCandidateReceipt` only for the new kind. Preserve deterministic two-build and offline-install gates.
- [ ] Add commercial HTML start page matching the existing CSP/offline boundary and new canonical path/fingerprint guidance. Keep evaluation docs unchanged.
- [ ] Run focused tests GREEN, then `npm run beta:test` and `npm run release:test`; commit scoped files.

### Task 2: Bind nested terms and acceptance identity

**Files:** Modify `packages/trajecta-beta/src/release/archive-verification.ts`, `packages/trajecta-beta/src/acceptance.ts`; test archive audit and acceptance.

**Interfaces:** `verifyArchive()` compares outer `LICENSES/BETA-COMMERCIAL-TERMS.txt` to installed `BETA-COMMERCIAL-TERMS.txt` for the commercial-candidate schema. Evaluation verification remains byte-compatible with the preserved evaluation artifact. Acceptance evidence adds `releaseReceiptSchema`; retain `evaluation` with value `not-for-sale` for evaluation and `commercial-candidate-activation-pending` for candidate.

- [ ] Write tampered nested-terms and candidate evidence tests; observe failures because mismatch passes and evidence is hardcoded.
- [ ] Add byte-equality gate with a bounded `TERMS_MISMATCH` diagnostic and derive evidence identity only from the verified signed receipt schema.
- [ ] Run focused tests GREEN, beta/release aggregate once, diff check and commit.

### Task 3: Build and verify exact commercial candidate

**Files:** Evidence documents only after runtime acceptance.

- [ ] Run fresh complete checks on the clean candidate commit.
- [ ] Build two snapshots with frozen time and the existing external evaluation signing key solely as a technical candidate identity; never claim it is a legal seller identity.
- [ ] Seller-verify/extract, install with shipped command outside source and run installed acceptance on exact ZIP/pins/key with fresh canonical paths.
- [ ] Dispatch one fresh-context operator using only delivered bytes, pins/key and `START-HERE.html`; capture all friction honestly.
- [ ] Review code and evidence; preserve evaluation ZIP. Do not activate checkout or perform a non-revenue order without separate Ty authorization.
