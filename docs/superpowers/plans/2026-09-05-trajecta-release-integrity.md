# Trajecta Release Integrity Implementation Plan

> **Status:** implementation-ready, post-audit revision. It consumes the approved private-beta delivery specification and merged Production Local SDK at `a59e187`.

**Goal:** Create a byte-reproducible, not-for-sale evaluation archive with an auditable package, manifest, receipt, and detached signature. It is a release-integrity gate, not a Customer-0 usability result or commercial activation.

**Scope boundary:** This plan creates seller-only release tooling and the evaluation archive. It does not publish, sell, activate Payhip, add terms acceptance, create customer onboarding, claim usability, perform the 15-step Customer-0 run, add hosted transport, or make a network-security claim beyond the bounded npm/package checks below.

**Architecture:** `tools/release-integrity/` is seller-only and never enters the archive. A sanitized Git preflight snapshots a clean allowlisted source set at one resolved commit. All later construction consumes that immutable snapshot; it reads neither Git nor wall time. The builder stages one dependency-free private npm package, deterministically packs it, creates a non-self-referential manifest and member ledger, signs a fixed evaluation receipt, then writes and audits the exact approved ZIP tree.

## Fixed contracts and global invariants

- The only distributed ZIP tree is exactly the section-9 tree in the approved spec, rooted at `trajecta-verified-resume-sdk-beta-0.1.0/`; there are no extra members, directories, comments, or generated reports. The package tgz entry remains at `packages/trajecta-beta-0.1.0.tgz`.
- `release/payload-policy.json` names every construction input: release tool code, package template, evaluation placeholders, core runtime paths, beta runtime/bin paths, `LICENSE`, `NOTICE`, and release policy data. It also records exact staged paths and an exclusion list. Recursive globs are expanded once by the preflight and sorted as POSIX relative paths.
- Before any staging, packing, manifesting, signing, or output-directory creation, `preflight-source.ts` invokes only a controlled Git executable with `GIT_CONFIG_NOSYSTEM=1`, an empty temporary global config, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and a copied allowlisted environment. It resolves `buildCommit^{commit}`, requires it equal `HEAD^{commit}`, and rejects any staged, unstaged, or untracked change reported by `git status --porcelain=v1 -z --untracked-files=all -- <every-expanded-allowlisted-input>`. It also rejects a source path that is absent, a symlink/special file, case-fold collision, or not present in `buildCommit`. This establishes that every source input is clean at the claimed commit; it is not a claim that unrelated paths are clean.
- Preflight creates a new immutable snapshot outside the source tree using no-follow reads, hashes and records each source byte/mode, and rechecks its descriptors while copying. After that point construction consults only the snapshot, frozen CLI values and external key bytes: no Git, wall clock, source-tree path, environment credential, or network service.
- `--output-dir` is required and must be an absolute path to a **new, non-existent** directory outside the source root. The builder creates it exclusively; it rejects an existing path, source-descendant path, symlink ancestry, or output/pins inside the source. `release-pins.json` is written beside the ZIP in that output directory, never in the ZIP.
- `releaseInstant` is an explicit UTC RFC 3339 instant in ZIP DOS range `1980-01-01T00:00:00Z` through `2107-12-31T23:59:58Z`, has zero milliseconds, and an even seconds value. Every ZIP entry has exactly that DOS date/time and has no extra field. `verificationInstant` is separately explicit receipt data; both are validated before construction.
- ZIP uses method **STORE** only. Names are UTF-8 but constrained to ASCII `[A-Za-z0-9][A-Za-z0-9._/-]*`, contain no `//`, `.`/`..` segment, backslash, control character, leading slash, or trailing slash. This same path policy applies to the `SHA256SUMS.txt` names and recursive tar ledger member names.
- The package `.tgz` uses a bounded POSIX ustar stream with lexicographically sorted regular-file members, mode `0644` except `bin/trajecta-beta` `0755`, uid/gid `0`, empty uname/gname, and mtime equal to `releaseInstant` Unix seconds. Its gzip wrapper uses mtime `0`, XFL `0`, OS `255`, and no optional fields. No links, devices, PAX records, sparse files, or unsupported headers are allowed. The tar reader applies entry/size/depth/ratio bounds before it exposes member bytes.
- `SHA256SUMS.txt` is UTF-8, LF-terminated, sorted by archive-relative path, covers every ZIP member except itself, and uses exactly `<lowercase-64-hex>  <safe-path>\n` per line (two spaces; no escaping).
- `MANIFEST.json` inventories payload members only and excludes itself, receipt, signature, public key, and checksum list. Each normal member has path, bytes, SHA-256, and one original class: `apache-core`, `commercial-beta`, `documentation`, or `notice`. The exact package tgz entry alone has `mixed-container` and a recursively audited `memberLedger`; every ledger member keeps one original class. `mixed-container` is forbidden for inner members and all other ZIP entries.
- The receipt schema is exactly `release-integrity-evaluation` v1. Its known suite IDs are `release-contracts-v1`, `release-source-preflight-v1`, `release-stage-layout-v1`, `release-tgz-audit-v1`, `release-offline-npm-v1`, `release-archive-audit-v1`, and `release-reproducibility-v1`. It must include all seven (each with pass/fail/not-run) plus these limitations verbatim: `Customer-0-not-run`, `not-for-sale`, and `no-commercial-activation`. It records no invented acceptance result or commercial claim.
- The only network assertion is deliberately narrow: the staged package has no dependencies or lifecycle scripts; installation uses npm offline mode; and audited SDK runtime imports contain no `node:net`, `node:tls`, `node:http`, `node:https`, `node:http2`, `node:dgram`, `node:dns`, or their bare aliases. This plan does not assert that the operating system made no socket attempt.

## Task 1: Define frozen inputs, schemas, and source preflight (TDD)

**Files:**

- Create `tools/release-integrity/src/contracts.ts`
- Create `tools/release-integrity/src/canonical.ts`
- Create `tools/release-integrity/src/errors.ts`
- Create `tools/release-integrity/src/preflight-source.ts`
- Create `tools/release-integrity/test/contracts.test.ts`
- Create `tools/release-integrity/test/preflight-source.test.ts`
- Create `release/payload-policy.json`
- Create `release/trajecta-beta.package.json`

**Red:** Test canonical JSON/UTF-8 LF, exact safe paths, commit digests, release/verification instants, ZIP-DOS range, even seconds, zero milliseconds, the four original license classes plus the package-only `mixed-container`, the fixed receipt contract/suite IDs/limitations, and output location validation. With an isolated Git fixture, prove preflight rejects a commit different from HEAD, staged/unstaged/untracked changes to every allowlisted file, untracked expanded children, Git config overrides, symlinks, case collisions, missing tracked paths, and a changed file during snapshot. Prove no output exists when preflight fails and construction receives an immutable snapshot, never a repo.

**Green:** Implement the controlled Git invocation and exact scoped porcelain check above before any construction. Freeze the expanded input list and no-follow snapshot ledger. Define the manifest, receipt and release-pins schemas; the receipt validator requires the named suite IDs and limitations. The generated package template is `@patternstatic/trajecta-beta@0.1.0`, `private: true`, `type: module`, `engines.node: >=22.19 <23`, no `dependencies`, `optionalDependencies`, `peerDependencies`, `bundledDependencies`, or `scripts`, and an exact `files` list only for the staged layout in Task 2.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/contracts.test.ts tools/release-integrity/test/preflight-source.test.ts
```

## Task 2: Stage the exact package layout and license ledger (TDD)

**Files:**

- Create `tools/release-integrity/src/stage-package.ts`
- Create `tools/release-integrity/test/stage-package.test.ts`
- Create `release/license-map.json`
- Create `release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt`
- Create `release/evaluation/THIRD-PARTY-NOTICES.txt`

**Red:** From the immutable snapshot, prove the staged package is exactly:

```text
package/
  package.json
  bin/trajecta-beta
  beta/src/<every runtime .ts source>
  core/src/<every required Apache runtime .ts source>
  LICENSE
  NOTICE
  BETA-COMMERCIAL-TERMS.txt
```

Assert `bin/trajecta-beta` imports only `../beta/src/cli.ts`; staged beta relative imports resolve inside `beta/src`; the generated staged `beta/src/kernel-port.ts` changes only its core module specifier to `../../core/src/index.ts`; and all core relative imports resolve inside `core/src`. Assert no tests, docs, fixtures, source-repo manifest, Git metadata, seller tool, source path, dependency, lifecycle script, symlink, special file, or unexpected package member appears. Assert every staged regular member has one original license class, copied Apache `LICENSE`/`NOTICE` retain bytes, and commercial terms say evaluation only, not for sale, and not commercial activation.

**Green:** Copy only snapshot allowlisted inputs with normal modes (`0644`, bin `0755`), produce the exact generated layout, and write a sorted package-member ledger. `release/license-map.json` explicitly maps every staged path; it is not distributed. Do not modify repository `NOTICE` unless an attribution audit proves a gap. Update no product source: this is a generated staging boundary.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/stage-package.test.ts
```

## Task 3: Deterministically pack and audit the nested tarball (TDD)

**Files:**

- Create `tools/release-integrity/src/deterministic-tgz.ts`
- Create `tools/release-integrity/src/tar-reader.ts`
- Create `tools/release-integrity/src/pack-package.ts`
- Create `tools/release-integrity/test/tgz-audit.test.ts`

**Red:** Pack identical staged bytes twice and require identical bytes. Reject tar traversal, duplicate/case-colliding names, links/devices/PAX/sparse entries, unsafe path characters/modes, non-canonical ordering/header fields, bad gzip headers, over-limit member count/size/depth/ratio, missing/extra members, digest mismatch, and an inner `mixed-container` class. Prove the resulting package entry's manifest ledger exactly binds every audited tar regular member.

**Green:** Use the deterministic ustar/gzip policy above rather than delegating byte construction to npm. Audit the completed `.tgz` recursively before it can enter the ZIP. Emit the package's one outer `mixed-container` manifest entry with its member ledger; preserve the original class for each inner member.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/tgz-audit.test.ts
```

## Task 4: Prove controlled offline npm installation (TDD)

**Files:**

- Create `tools/release-integrity/src/run.ts`
- Create `tools/release-integrity/test/offline-package.test.ts`

**Red:** Create an independent minimal customer Git workspace outside the source tree: `git init`, an attached `main` branch, a credential-free origin such as `https://example.invalid/customer.git`, and only a tiny consumer `package.json`. It must contain no copied source repository metadata/path. Poison user/project/global npm configs with registry, proxy, auth, script, audit/fund/update-notifier, and lockfile settings. Prove install of the audited tgz succeeds only via the controlled invocation; prove the installed bin runs `version`, `doctor`, and `demo` with an explicit state root. Assert the package has no dependencies/scripts and SDK import audit has no network-capable import. Do not attempt to prove OS socket absence.

**Green:** Pin the invoked npm executable/version, use a private temporary `HOME`, `NPM_CONFIG_USERCONFIG`, empty cache, and controlled config with `offline=true`, `ignore-scripts=true`, `package-lock=false`, `audit=false`, `fund=false`, `update-notifier=false`, and no registry/auth/proxy inheritance. Run `npm install --offline --ignore-scripts --package-lock=false --no-audit --no-fund` against the local tgz, then check the installed package and its bin. The test fails if npm reads a poisoned config or package configuration drifts.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/offline-package.test.ts
```

## Task 5: Build the canonical manifest, receipt, and signature (TDD)

**Files:**

- Create `tools/release-integrity/src/manifest.ts`
- Create `tools/release-integrity/src/signing.ts`
- Create `tools/release-integrity/test/manifest-signing.test.ts`

**Red:** Prove normal payload-only manifest entries are sorted and non-self-referential; prove the package tgz alone carries a ledger that binds every recursively audited member. Reject an outer mixed class elsewhere, any ledger mismatch, extra receipt key, unknown/missing suite, changed limitation, or commercial/customer acceptance assertion. Prove Ed25519 signs exact canonical receipt bytes and fails after receipt, manifest, key, signature, or pin modification; private key bytes never appear in diagnostics.

**Green:** Hash verified snapshot/staged bytes, build canonical UTF-8 LF manifest and `release-integrity-evaluation` receipt, sign with an external PEM key, and derive a public-key fingerprint/key ID. Populate suites only with the known IDs and record `Customer-0-not-run` only as the required limitation, never as an invented suite result; retain all mandatory limitations exactly. This receipt proves release-integrity evaluation facts, not delivery, installation, usability, sale, or commercial activation.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/manifest-signing.test.ts
```

## Task 6: Assemble the exact deterministic ZIP and pins (TDD)

**Files:**

- Create `tools/release-integrity/src/deterministic-zip.ts`
- Create `tools/release-integrity/src/assemble.ts`
- Create `tools/release-integrity/test/deterministic-archive.test.ts`

**Red:** Build from two independent clean snapshots and require every tgz, manifest, receipt, signature, checksum list, ZIP, and `release-pins.json` byte equal. Inspect local and central headers: exact approved members, lexical order, STORE method, exact DOS release instant on every entry, no extras/comments, normalized mode, and no forbidden names. Reject checksum lines not using two spaces, UTF-8 LF, safe names, or no escaping; reject any directory/output/pin inside source or a non-new output directory.

**Green:** Write regular ZIP members only, STORE only, using the exact release-time metadata; assemble the unchanged approved archive tree. Write `release-pins.json` only beside the archive with ZIP SHA-256 and public-key fingerprint. Evaluation placeholder `START-HERE.html`, `START-HERE.md`, recipes, troubleshooting, and supported-environment files are explicitly non-onboarding placeholders: they provide no installation flow, commercial terms, checkbox, click-through, or acceptance language.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/deterministic-archive.test.ts
```

## Task 7: Fail closed before extraction or install (TDD)

**Files:**

- Create `tools/release-integrity/src/zip-reader.ts`
- Create `tools/release-integrity/src/audit.ts`
- Create `tools/release-integrity/src/verify.ts`
- Create `tools/release-integrity/test/archive-audit.test.ts`

**Red:** Before extraction, reject ZIP digest/key/signature/receipt/manifest/checksum failure; traversal, duplicate/case collision, unsupported method, extra field, wrong time, link/mode, archive-tree drift, bomb bounds, secret or seller-only name, unsafe checksum encoding, and any missing/extra member. For the `.tgz`, recursively reject the Task-3 adversaries and a manifest ledger mismatch before npm is invoked. Every error is a fixed bounded diagnostic and creates no extracted/executed partial output.

**Green:** Hash original ZIP first, verify independently supplied ZIP digest and key fingerprint, then signature, receipt contract, manifest, checksums, exact ZIP policy, and recursive tgz/member ledger. Extract only then to a new empty outside-source directory using exclusive regular-file creation and post-write digests. Installation is a separate Task-4 controlled action after audit.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/archive-audit.test.ts
```

## Task 8: Expose and prove the seller workflow end to end (TDD)

**Files:**

- Create `tools/release-integrity/bin/trajecta-release`
- Create `tools/release-integrity/src/cli.ts`
- Create `tools/release-integrity/test/cli.test.ts`
- Create `tools/release-integrity/test/end-to-end.test.ts`
- Create `test/release-integrity-parent.test.ts`
- Modify root `package.json`
- Modify `packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md`

**Red:** Exercise `build`, `audit`, and `verify` via the executable. Reject unknown/repeated/empty flags, missing pins/frozen values, invalid instant, in-repo key, output that exists/is inside source, buildCommit not exactly HEAD, dirty allowlisted input, package/import/layout/license drift, and non-evaluation receipt claims. In two independently copied clean sources at one commit, build to separate outside-source new directories, compare every byte, audit each ZIP, then perform the independent Task-4 customer-workspace install. Prove only the narrow npm/package network assertions, not an OS socket claim.

**Green:** Add `release:test`, `release:check`, and `release:evaluation` root scripts. The latter requires explicit external key, build commit, UTC frozen instants, and new output directory; it runs preflight before construction and returns archive and pins only after all release-integrity suites pass. Update the development boundary to describe this generated private package layout and keep Customer-0 usability, terms acceptance, sale, and activation closed.

**Verify:**

```sh
npm run release:check
npm run release:evaluation -- \
  --private-key /absolute/external-test-key.pem \
  --public-key /absolute/external-test-public-key.pem \
  --build-commit <exact-HEAD-commit> \
  --release-instant 2026-09-05T00:00:00Z \
  --verification-instant 2026-09-05T00:00:00Z \
  --output-dir /absolute/new-outside-source-directory
```

## Final review gate

An independent reviewer inspects the complete merge-base-to-HEAD diff and runs the exact end-to-end gate. Approval requires clean allowlisted-source preflight at `HEAD == buildCommit`; identical reproducible outputs; exact staged package/import/bin/license layout; recursive tgz ledger audit before offline install; controlled offline npm proof in an independent customer Git workspace; exact STORE ZIP and checksum policy; independently pinned ZIP/key verification; and a `release-integrity-evaluation` receipt with all required suite IDs and limitations. The reviewer must confirm no generated output, pins, key, state, or archive was written inside source, and no claim of Customer-0 completion, sale, onboarding/terms acceptance, or commercial activation was made.

After review, record only the release-integrity facts, exact commit, archive digest, fingerprint, suite outcomes, and stated limitations. Do not call the archive sellable or start Customer-0 usability from this plan.
