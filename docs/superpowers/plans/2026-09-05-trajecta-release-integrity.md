# Trajecta Release Integrity Implementation Plan

> **Status:** implementation-ready, post-audit revision. It consumes the approved private-beta delivery specification and merged Production Local SDK at `a59e187`.

**Goal:** Create a byte-reproducible, not-for-sale evaluation archive with an auditable package, manifest, receipt, and detached signature. It is a release-integrity gate, not a Customer-0 usability result or commercial activation.

**Scope boundary:** This plan creates seller-only release tooling and the evaluation archive. It does not publish, sell, activate Payhip, add terms acceptance, create customer onboarding, claim usability, perform the 15-step Customer-0 run, add hosted transport, or make a network-security claim beyond the bounded npm/package checks below.

**Architecture:** `tools/release-integrity/` is seller-only and never enters the archive. A sanitized Git preflight snapshots a clean allowlisted source set at one resolved commit. All later construction consumes that immutable snapshot; it reads neither Git nor wall time. The builder stages one dependency-free private npm package, deterministically packs it, creates a non-self-referential manifest and member ledger, signs a fixed evaluation receipt, then writes and audits the exact approved ZIP tree.

## Fixed contracts and global invariants

- The only distributed ZIP tree is exactly the section-9 tree in the approved spec, rooted at `trajecta-verified-resume-sdk-beta-0.1.0/`; there are no extra members, directories, comments, or generated reports. The package tgz entry remains at `packages/trajecta-beta-0.1.0.tgz`.
- `release/payload-policy.json` names every construction input: release tool code, package template, evaluation placeholders, core runtime paths, beta runtime/bin paths, `packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md`, `LICENSE`, `NOTICE`, and release policy data. It also records exact staged paths and an exclusion list. Recursive globs are expanded once by the preflight and sorted as POSIX relative paths.
- Before any staging, packing, manifesting, signing, or output-directory creation, `preflight-source.ts` requires an absolute `--git-bin`. It verifies that path is a no-follow regular executable, executes `<git-bin> --version`, and uses that exact executable for every Git call with `GIT_CONFIG_NOSYSTEM=1`, an empty temporary global config, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and a copied allowlisted environment. It resolves `buildCommit^{commit}`, requires it equal `HEAD^{commit}`, and obtains the complete expanded allowlist from `git ls-tree -r -z --name-only <buildCommit> -- <policy roots>`, not from the working tree. It rejects a policy match absent from that tree and requires every source input to be represented by that tracked list. It then rejects any staged, unstaged, or untracked change reported by `git status --porcelain=v1 -z --untracked-files=all -- <every-expanded-allowlisted-input>`, including deletion of an allowlisted tracked path. It also rejects a source path that is absent, a symlink/special file, or case-fold collision. This establishes that every source input is clean at the claimed commit; it is not a claim that unrelated paths are clean.
- Preflight creates a new immutable snapshot outside the source tree using no-follow reads, hashes and records each source byte/mode, and rechecks its descriptors while copying. After that point construction consults only the snapshot, frozen CLI values and external key bytes: no Git, wall clock, source-tree path, environment credential, or network service.
- `--output-dir` is required and must be an absolute path to a **new, non-existent** directory outside the source root. The builder creates it exclusively; it rejects an existing path, source-descendant path, symlink ancestry, or output/pins inside the source. `release-pins.json` is written beside the ZIP in that output directory, never in the ZIP.
- `releaseInstant` is an explicit UTC RFC 3339 instant in ZIP DOS range `1980-01-01T00:00:00Z` through `2107-12-31T23:59:58Z`, has zero milliseconds, and an even seconds value. Every ZIP entry has exactly that DOS date/time and has no extra field. `verificationInstant` is separately explicit receipt data; both are validated before construction.
- ZIP uses method **STORE** only. Names are UTF-8 but constrained to ASCII `[A-Za-z0-9][A-Za-z0-9._/-]*`, contain no `//`, `.`/`..` segment, backslash, control character, leading slash, or trailing slash. This same path policy applies to the `SHA256SUMS.txt` names and recursive tar ledger member names.
- The package `.tgz` uses a bounded POSIX ustar stream with lexicographically sorted regular-file members, mode `0644` except `bin/trajecta-beta` `0755`, uid/gid `0`, empty uname/gname, and mtime equal to `releaseInstant` Unix seconds. Its gzip wrapper uses mtime `0`, XFL `0`, OS `255`, and no optional fields. No links, devices, PAX records, sparse files, or unsupported headers are allowed. The tar reader applies entry/size/depth/ratio bounds before it exposes member bytes.
- `SHA256SUMS.txt` is UTF-8, LF-terminated, sorted by archive-relative path, covers every ZIP member except itself, and uses exactly `<lowercase-64-hex>  <safe-path>\n` per line (two spaces; no escaping).
- `MANIFEST.json` inventories payload members only and excludes itself, receipt, signature, public key, and checksum list. Each normal member has path, bytes, SHA-256, and one original class: `apache-core`, `commercial-beta`, `documentation`, or `notice`. The exact package tgz entry alone has `mixed-container` and a recursively audited `memberLedger`; every ledger member keeps one original class. `mixed-container` is forbidden for inner members and all other ZIP entries.
- The receipt schema is exactly `release-integrity-evaluation` v1. It carries only the fixed test-scope IDs `release-contracts-v1`, `release-source-preflight-v1`, `release-stage-layout-v1`, `release-tgz-audit-v1`, `release-offline-npm-v1`, `release-archive-audit-v1`, and `release-reproducibility-v1`; it carries no suite status, count, or post-assembly result. It sets `highestProvenReceiptLevel: production-local-sdk` and includes these limitations verbatim: `Customer-0-not-run`, `not-for-sale`, and `no-commercial-activation`. It records no invented acceptance result or commercial claim. Post-assembly archive-audit and reproducibility evidence is external: after the final immutable ZIP is audited, `release-pins.json` and the LWM checkpoint may record that evidence without changing the receipt or signature.
- Every staged Apache-derived member has an explicit `modified: true|false` license-map value; an omitted or unknown state is treated as modified and fails unless the required notice covers it. The tgz includes `LICENSES/CORE-MODIFICATIONS.txt` listing every modified Apache-derived member. The outer existing `LICENSES/CORE-NOTICE.txt` is generated from the core NOTICE plus byte-identical modification-notice content. The stage and archive audits fail if any modified Apache-derived member lacks the required notice.
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

**Red:** Test canonical JSON/UTF-8 LF, exact safe paths, commit digests, release/verification instants, ZIP-DOS range, even seconds, zero milliseconds, the four original license classes plus the package-only `mixed-container`, the fixed receipt test-scope IDs/level/limitations with no statuses, and output location validation. With an isolated Git fixture, prove preflight rejects a relative, missing, symlinked, non-executable, or non-Git `--git-bin`; a commit different from HEAD; staged/unstaged/untracked changes; and deletion of every allowlisted tracked path obtained from `git ls-tree`. Also reject untracked expanded children, Git config overrides, symlinks, case collisions, a policy match missing from the commit tree, and a changed file during snapshot. Prove no output exists when preflight fails and construction receives an immutable snapshot, never a repo.

**Green:** Implement the verified exact Git invocation, commit-tree allowlist derivation, and scoped porcelain check above before any construction. Freeze the expanded input list and no-follow snapshot ledger. Define manifest, receipt and release-pins schemas: receipt requires only named test-scope IDs, `highestProvenReceiptLevel: production-local-sdk`, and limitations; pins owns post-assembly external-gate results. The generated package template is `@patternstatic/trajecta-beta@0.1.0`, `private: true`, `type: module`, `engines.node: >=22.19 <23`, no `dependencies`, `optionalDependencies`, `peerDependencies`, `bundledDependencies`, or `scripts`, and an exact `files` list only for the staged layout in Task 2, including `beta/DEVELOPMENT-BOUNDARY.md` and `LICENSES/CORE-MODIFICATIONS.txt`.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/contracts.test.ts tools/release-integrity/test/preflight-source.test.ts
```

## Task 2: Stage the exact package layout and license ledger (TDD)

**Files:**

- Create `tools/release-integrity/src/stage-package.ts`
- Create `tools/release-integrity/test/stage-package.test.ts`
- Create `release/license-map.json`
- Create `release/evaluation/LICENSES/CORE-NOTICE.txt`
- Create `release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt`
- Create `release/evaluation/THIRD-PARTY-NOTICES.txt`

**Red:** From the immutable snapshot, prove the staged package is exactly:

```text
package/
  package.json
  bin/trajecta-beta
  beta/DEVELOPMENT-BOUNDARY.md
  beta/src/<every runtime .ts source>
  core/src/<every required Apache runtime .ts source>
  LICENSE
  NOTICE
  BETA-COMMERCIAL-TERMS.txt
  LICENSES/CORE-MODIFICATIONS.txt
```

Assert `bin/trajecta-beta` imports only `../beta/src/cli.ts`; staged beta relative imports resolve inside `beta/src`; the generated staged `beta/src/kernel-port.ts` changes only its core module specifier to `../../core/src/index.ts`; and all core relative imports resolve inside `core/src`. Assert `beta/DEVELOPMENT-BOUNDARY.md` is installed, classified as `documentation`, declared in `files`, and present in the package entry's manifest `memberLedger`. Assert no tests, other docs, fixtures, source-repo manifest, Git metadata, seller tool, source path, dependency, lifecycle script, symlink, special file, or unexpected package member appears. Assert every staged regular member has one original license class; every Apache-derived member has an explicit modification state; the conservative `LICENSES/CORE-MODIFICATIONS.txt` lists each modified Apache-derived member; copied Apache `LICENSE`/`NOTICE` retain bytes; and commercial terms say evaluation only, not for sale, and not commercial activation.

**Green:** Copy only snapshot allowlisted inputs with normal modes (`0644`, bin `0755`), produce the exact generated layout, and write a sorted package-member ledger. `release/license-map.json` explicitly maps every staged path and Apache modification state; it is not distributed. Generate the tgz modification notice from that map, then fold those exact bytes into the existing outer `LICENSES/CORE-NOTICE.txt` after the core NOTICE text. Do not modify repository `NOTICE` unless an attribution audit proves a gap. Update no product source: this is a generated staging boundary.

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

**Red:** Pack identical staged bytes twice and require identical bytes. Reject tar traversal, duplicate/case-colliding names, links/devices/PAX/sparse entries, unsafe path characters/modes, non-canonical ordering/header fields, bad gzip headers, over-limit member count/size/depth/ratio, missing/extra members, digest mismatch, an inner `mixed-container` class, missing `beta/DEVELOPMENT-BOUNDARY.md`, or missing/mismatched `LICENSES/CORE-MODIFICATIONS.txt`. Prove the resulting package entry's manifest ledger exactly binds every audited tar regular member.

**Green:** Use the deterministic ustar/gzip policy above rather than delegating byte construction to npm. Audit the completed `.tgz` recursively before it can enter the ZIP. Emit the package's one outer `mixed-container` manifest entry with its member ledger; preserve the original class for each inner member.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/tgz-audit.test.ts
```

## Task 4: Prove controlled offline npm installation (TDD)

**Files:**

- Create `tools/release-integrity/src/run.ts`
- Create `tools/release-integrity/test/offline-package.test.ts`

**Red:** Create an independent minimal customer Git workspace outside the source tree: `git init`, an attached `main` branch, a credential-free origin such as `https://example.invalid/customer.git`, and only a tiny consumer `package.json`. It must contain no copied source repository metadata/path. Require an absolute regular-file `--npm-cli`, prove `process.execPath <npm-cli> --version` is exactly `10.9.8`, and reject a relative, missing, altered, or other-version CLI. Poison user/project/global npm configs with registry, proxy, auth, script, audit/fund/update-notifier, and lockfile settings; poison every inherited case-insensitive `npm_config_*`, auth, proxy, and registry variable. Before install, recursively audit the tgz and its manifest `memberLedger` for `LICENSES/CORE-MODIFICATIONS.txt`; after install, directly assert that exact file exists under the installed package root and byte-matches the audited ledger. Prove the installed bin runs its existing `version`, `doctor`, and `demo` behavior with an explicit state root. Assert the package has no dependencies/scripts and SDK import audit has no network-capable import. Do not attempt to prove OS socket absence.

**Green:** Require explicit absolute `--npm-cli`, verify it is a regular no-follow file and that `process.execPath <npm-cli> --version` returns exactly `10.9.8`; invoke npm only as `process.execPath <npm-cli> ...`, never through `PATH`. Start from a copied environment after removing every key matched case-insensitively by `^npm_config_`, `auth`, `proxy`, or `registry`; set a private temporary `HOME`, isolated `NPM_CONFIG_USERCONFIG`, `NPM_CONFIG_GLOBALCONFIG`, cache, prefix, and isolated cwd with no `.npmrc`. Write controlled user/global configs with `offline=true`, `ignore-scripts=true`, `package-lock=false`, `audit=false`, `fund=false`, `update-notifier=false`, and no registry/auth/proxy values. Run `process.execPath <npm-cli> install --offline --ignore-scripts --package-lock=false --no-audit --no-fund` against the local tgz, then check the installed package and its bin. The test fails if npm reads a poisoned config, sees an isolated-cwd `.npmrc`, or package configuration drifts.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/offline-package.test.ts
```

## Task 5: Build the canonical manifest, receipt, and signature (TDD)

**Files:**

- Create `tools/release-integrity/src/manifest.ts`
- Create `tools/release-integrity/src/signing.ts`
- Create `tools/release-integrity/test/manifest-signing.test.ts`

**Red:** Prove normal payload-only manifest entries are sorted and non-self-referential; prove the package tgz alone carries a ledger that binds every recursively audited member. Reject an outer mixed class elsewhere, any ledger mismatch, extra receipt key, unknown/missing test-scope ID, any suite status/count, a non-`production-local-sdk` highest level, changed limitation, or commercial/customer acceptance assertion. Prove Ed25519 signs exact canonical receipt bytes and fails after receipt, manifest, key, or signature modification; private key bytes never appear in diagnostics. Prove release-pins is not a receipt input and receipt/signature bytes cannot change after assembly.

**Green:** Hash verified snapshot/staged bytes, build canonical UTF-8 LF manifest and `release-integrity-evaluation` receipt, sign with an external PEM key, and derive a public-key fingerprint/key ID. Populate only the fixed test-scope IDs, `highestProvenReceiptLevel: production-local-sdk`, and mandatory limitations; never add suite outcomes or post-assembly evidence. This receipt proves release-integrity evaluation scope, not delivery, installation, usability, sale, archive-audit/repro results, or commercial activation.

**Verify:**

```sh
node --experimental-strip-types --test tools/release-integrity/test/manifest-signing.test.ts
```

## Task 6: Assemble the exact deterministic ZIP and pins (TDD)

**Files:**

- Create `tools/release-integrity/src/deterministic-zip.ts`
- Create `tools/release-integrity/src/assemble.ts`
- Create `tools/release-integrity/test/deterministic-archive.test.ts`

**Red:** Build from two independent clean snapshots and require every tgz, manifest, receipt, signature, checksum list, and ZIP byte equal. Inspect local and central headers: exact approved members, lexical order, STORE method, exact DOS release instant on every entry, no extras/comments, normalized mode, and no forbidden names. Reject checksum lines not using two spaces, UTF-8 LF, safe names, or no escaping; reject any directory/output/pin inside source or a non-new output directory. Prove assembly cannot create or modify `release-pins.json`, receipt, or signature after the final ZIP is written.

**Green:** Write regular ZIP members only, STORE only, using the exact release-time metadata; assemble the unchanged approved archive tree. Emit no post-assembly evidence at this point: `release-pins.json` is external gate evidence written only after Task 8 audits the final immutable ZIP and reproduces it, while the receipt and signature stay untouched. Evaluation placeholder `START-HERE.html`, `START-HERE.md`, recipes, troubleshooting, and supported-environment files are explicitly non-onboarding placeholders: they provide no installation flow, commercial terms, checkbox, click-through, or acceptance language.

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

**Red:** Before extraction, reject ZIP digest/key/signature/receipt/manifest/checksum failure; traversal, duplicate/case collision, unsupported method, extra field, wrong time, link/mode, archive-tree drift, bomb bounds, secret or seller-only name, unsafe checksum encoding, and any missing/extra member. Reject receipt suite statuses or any highest level other than `production-local-sdk`. Reject an outer `LICENSES/CORE-NOTICE.txt` that lacks the same modification notice as the tgz's `LICENSES/CORE-MODIFICATIONS.txt`, or any modified/unknown Apache-derived member without a matching entry. For the `.tgz`, recursively reject the Task-3 adversaries and a manifest ledger mismatch before npm is invoked. Every error is a fixed bounded diagnostic and creates no extracted/executed partial output.

**Green:** Hash original ZIP first, verify independently supplied ZIP digest and key fingerprint, then signature, receipt contract, manifest, checksums, exact ZIP policy, conservative Apache-modification notices, and recursive tgz/member ledger. Extract only then to a new empty outside-source directory using exclusive regular-file creation and post-write digests. Installation is a separate Task-4 controlled action after audit; this audit does not mutate receipt or signature.

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

**Red:** Exercise `build`, `audit`, and `verify` via the executable. Reject unknown/repeated/empty flags, missing or invalid absolute `--git-bin`/`--npm-cli`, npm version other than exactly 10.9.8, missing frozen values, invalid instant, in-repo key, output that exists/is inside source, buildCommit not exactly HEAD, dirty/deleted allowlisted input, package/import/layout/development-boundary/license/modification-notice drift, receipt suite statuses, and non-evaluation receipt claims. In two independently copied clean sources at one commit, build to separate outside-source new directories, compare every immutable archive byte, audit each ZIP, then perform the independent Task-4 customer-workspace install. Only after both final ZIPs pass archive audit and reproducibility comparison, prove external `release-pins.json` records their ZIP digest, key fingerprint, archive-audit result, and reproducibility result without changing either ZIP, receipt, or signature; then record the same external evidence in LWM. Prove only the narrow npm/package network assertions, not an OS socket claim.

**Green:** Add `release:test`, `release:check`, and `release:evaluation` root scripts. The latter requires explicit verified external key, absolute `--git-bin`, absolute `--npm-cli` at exactly 10.9.8, build commit, UTC frozen instants, and new output directory; it runs preflight before construction. It writes the immutable ZIP first, audits/reproduces it externally, then writes `release-pins.json` alongside it without changing receipt/signature or ZIP. Update the development boundary to describe the installed generated package layout, including its boundary and modification-notice files, and keep Customer-0 usability, terms acceptance, sale, and activation closed.

**Verify:**

```sh
npm run release:check
npm run release:evaluation -- \
  --private-key /absolute/external-test-key.pem \
  --public-key /absolute/external-test-public-key.pem \
  --git-bin /absolute/path/to/git \
  --npm-cli /absolute/path/to/npm-cli.js \
  --build-commit <exact-HEAD-commit> \
  --release-instant 2026-09-05T00:00:00Z \
  --verification-instant 2026-09-05T00:00:00Z \
  --output-dir /absolute/new-outside-source-directory
```

## Final review gate

An independent reviewer inspects the complete merge-base-to-HEAD diff and runs the exact end-to-end gate. Approval requires verified absolute Git preflight at `HEAD == buildCommit` with the allowlist derived from `git ls-tree`; identical reproducible immutable ZIP outputs; exact staged package/import/bin/development-boundary/license/modification-notice layout; recursive tgz ledger audit before offline install; controlled npm 10.9.8 proof in an independent customer Git workspace; exact STORE ZIP and checksum policy; independently pinned ZIP/key verification; and a `release-integrity-evaluation` receipt with only required test-scope IDs, `production-local-sdk` level, and limitations. The final archive-audit and reproducibility results must be external `release-pins.json`/LWM evidence written only after the immutable ZIP, never receipt contents. The reviewer must confirm no generated output, pins, key, state, or archive was written inside source, and no claim of Customer-0 completion, sale, onboarding/terms acceptance, or commercial activation was made.

After review, record only the release-integrity facts, exact commit, archive digest, fingerprint, external audit/repro outcomes, and stated limitations in `release-pins.json`/LWM. Do not call the archive sellable or start Customer-0 usability from this plan.
