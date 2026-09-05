# Task 1 report — public installed archive verifier

## Status

PASS. Review base: `cd64142`. The later parent-owned documentation-only commits `1e8bc38` and `3255daa` were excluded from this task's implementation scope and file review.

The installed SDK now contains a dependency-free, read-only `verifyDeliveredBundle` API at `packages/trajecta-beta/src/release/archive-verification.ts`. It hashes the original ZIP before decoding it, derives only the untrusted DOS timestamp needed for canonical decoding, requires the signed receipt to bind that instant, verifies the receipt with the independently supplied Ed25519 key, authenticates the exact 17-member unpacked tree, and compares installed package bytes and modes with the signed recursive TGZ ledger. Links, special entries, missing entries, unexpected files/directories, altered bytes, and altered modes fail closed.

## RED evidence

Initial interface RED:

```text
$ node --experimental-strip-types --test packages/trajecta-beta/test/release-verification.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/trajecta-beta/src/release/archive-verification.ts'
tests 1
pass 0
fail 1
```

Observable verifier mutation RED: after temporarily replacing the installed-file byte equality check with `void actual`, the unchanged tampered-runtime rejection test failed. The mutation was then reverted.

```text
$ node --experimental-strip-types --test packages/trajecta-beta/test/release-verification.test.ts
not ok 1 - authenticates the delivered ZIP, unpacked tree, and installed package without writing state
error: 'Missing expected exception.'
stack: reject (.../release-verification.test.ts:89:10)
       TestContext.<anonymous> (.../release-verification.test.ts:128:5)
tests 1
pass 0
fail 1
```

This demonstrates that the regression observes verifier behavior: removing the authenticated installed-byte comparison makes the test accept a same-length runtime mutation.

## GREEN evidence

Exact focused command after restoring the guard:

```text
$ node --experimental-strip-types --test packages/trajecta-beta/test/release-verification.test.ts
ok 1 - authenticates the delivered ZIP, unpacked tree, and installed package without writing state
tests 1
pass 1
fail 0
duration_ms 131.073709
```

Focused shared-implementation run:

```text
$ node --experimental-strip-types --test packages/trajecta-beta/test/release-verification.test.ts tools/release-integrity/test/stage-package.test.ts tools/release-integrity/test/assemble.test.ts tools/release-integrity/test/archive-audit.test.ts tools/release-integrity/test/manifest-signing.test.ts tools/release-integrity/test/tgz-audit.test.ts
tests 17
pass 17
fail 0
duration_ms 357.537834
```

The required full release suite was run once after focused integration:

```text
$ npm run release:check
tests 47
pass 47
fail 0
duration_ms 2144.744541
```

Runtime/toolchain receipt:

```text
Darwin arm64
Node v22.23.1
npm 10.9.8
```

## Files

Public installed release modules:

- `packages/trajecta-beta/src/release/archive-verification.ts`
- `packages/trajecta-beta/src/release/canonical.ts`
- `packages/trajecta-beta/src/release/contracts.ts`
- `packages/trajecta-beta/src/release/deterministic-zip.ts`
- `packages/trajecta-beta/src/release/errors.ts`
- `packages/trajecta-beta/src/release/signature-verification.ts`
- `packages/trajecta-beta/src/release/tar-reader.ts`
- `packages/trajecta-beta/test/release-verification.test.ts`

Seller compatibility and duplicate-verifier removal:

- `tools/release-integrity/src/assemble.ts`
- `tools/release-integrity/src/signing.ts`
- `tools/release-integrity/src/canonical.ts`
- `tools/release-integrity/src/contracts.ts`
- `tools/release-integrity/src/deterministic-zip.ts`
- `tools/release-integrity/src/errors.ts`
- `tools/release-integrity/src/tar-reader.ts`

Recursive staging and exact release classification:

- `release/license-map.json`
- `release/payload-policy.json`
- `tools/release-integrity/test/stage-package.test.ts`
- `tools/release-integrity/test/offline-package.test.ts`

## Self-review and concerns

- No blocking findings from the scoped diff review or `git diff --check`.
- Public installed release modules have no import from `tools/release-integrity`, the source repository, or private signing/build code.
- `archive-verification.ts` contains no filesystem write operation and the fixture asserts path set, file bytes, modes, and link targets are unchanged after both accepted and rejected verification.
- All reads are bounded by the existing canonical ZIP, receipt, key, TGZ, member-count, member-size, path-depth, and compression-ratio limits.
- The seller assembler and signer retain private construction/signing authority; their former public verification logic is now a compatibility re-export of the installed implementation.
- No CLI, acceptance runner, acceptance-state creation, evidence-directory workflow, marketing, payment, or network behavior was added. Those remain outside Task 1.
