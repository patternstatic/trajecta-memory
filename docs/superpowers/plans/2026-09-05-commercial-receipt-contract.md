# Commercial Receipt Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strictly validated signed commercial-candidate receipt without changing evaluation receipt acceptance.

**Architecture:** Keep the evaluation parser unchanged. Add a discriminated commercial-candidate type and parser, then route seller signing and installed verification through a strict schema dispatcher. This task does not activate commerce or construct a commercial ZIP.

**Tech Stack:** Existing TypeScript, Node 22.23.1, node:test and Ed25519; no dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-trajecta-private-beta-delivery.md`; approved terms recorded in `docs/evidence/2026-09-05-commercial-terms-draft.md`.

## Global Constraints

- macOS on Apple Silicon; Node.js `>=22.19 <23`.
- Existing evaluation parser and its exact claims remain unchanged.
- No private key files, checkout, network, public posting or financial action.
- Commercial candidate is not proof of completed Customer-0 or an activated sale.
- Terms approval already supplied by Ty; no repeated approval question.

### Task 1: Strict commercial-candidate signature contract

**Files:** Modify `packages/trajecta-beta/src/release/contracts.ts`, `packages/trajecta-beta/src/release/signature-verification.ts`, `tools/release-integrity/src/signing.ts`; create `tools/release-integrity/test/commercial-signing.test.ts`.

**Interfaces:** Preserve `EvaluationReceipt` and `buildEvaluationReceipt`.
Add `CommercialCandidateReceipt`, `ReleaseReceipt`, `parseCommercialCandidateReceipt(value: unknown): void`, `parseReleaseReceipt(value: unknown): void`, and `buildCommercialCandidateReceipt` with the same five input fields as `buildEvaluationReceipt`. The new receipt uses the same fields except schema and limitations; schema is `trajecta.release-integrity-commercial-candidate/v1`, limitations exactly `['Customer-0-not-run', 'commercial-activation-pending', 'no-remote-task-completion-claim']`. All environment, version, support, key, frozen time, manifest and scope constraints remain exact.

- [ ] Add failing tests using ephemeral in-memory Ed25519 keys:

```ts
const built = buildCommercialCandidateReceipt(input);
assert.equal(built.value.schema, 'trajecta.release-integrity-commercial-candidate/v1');
assert.throws(() => parseEvaluationReceipt(built.value));
assert.doesNotThrow(() => parseCommercialCandidateReceipt(built.value));
const signature = signReceipt({ receiptBytes: built.bytes, privateKeyPem });
assert.equal(verifySignedReceipt({ receiptBytes: built.bytes, signature,
  manifestBytes: input.manifestBytes, publicKeyPem: input.publicKeyPem,
  expectedPublicKeyFingerprint: built.publicKeyFingerprint }).schema, built.value.schema);
for (const patch of [{ limitations: ['ready-for-sale'] }, { extra: true },
  { schema: 'unknown/v1' }, { supportDefinition: 'lifetime support' }]) {
  assert.throws(() => parseReleaseReceipt({ ...built.value, ...patch }));
}
```

- [ ] Run `node --experimental-strip-types --test tools/release-integrity/test/commercial-signing.test.ts`; missing exports must fail before implementation.
- [ ] Implement the commercial parser by validating its exact discriminator/limitations, then validating a copy through the untouched evaluation parser with ONLY schema and limitations normalized to evaluation constants. Do not mutate input or relax arbitrary claims.

```ts
export type CommercialCandidateReceipt = Omit<EvaluationReceipt, 'schema'> & {
  schema: 'trajecta.release-integrity-commercial-candidate/v1';
};
export type ReleaseReceipt = EvaluationReceipt | CommercialCandidateReceipt;
```

- [ ] Add strict dispatcher: evaluation schema calls evaluation parser, commercial schema calls commercial parser, all other values fail `INVALID_RECEIPT`. Seller signing and installed verification use dispatcher; signature bytes remain the original canonical bytes, never the normalized validation copy.
- [ ] Build candidate from the existing frozen evaluation value by replacing only schema and limitations, validate, canonicalize, and return matching digests. `BuiltReceipt.value` becomes `ReleaseReceipt`; keep evaluation output unchanged.
- [ ] Extend tests: evaluation still round-trips; candidate signature fails with a changed schema/manifest/key; repeated frozen inputs yield identical receipt bytes. Run new test and existing signing/contracts tests. Run full `npm run beta:test` and `npm run release:test` once after focused GREEN.
- [ ] Inspect diff for unintended changes; commit only the four scoped source/test files with `feat: add strict commercial-candidate receipt contract` and report command evidence.

## Next consuming gates (not implemented by this task)

Explicit profile plumbing must subsequently select approved inner and outer terms,
source allowlists, guides and assembler receipt together; installed acceptance
must report profile honestly. Before release, test full commercial bytes from a
clean install and compare outer/inner terms. This contract task alone does not
satisfy the full delivery goal.
