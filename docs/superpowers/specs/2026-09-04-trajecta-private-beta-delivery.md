# Trajecta Private Beta Delivery Design

**Status:** proposed for Ty review  
**Date:** 2026-09-04  
**Owner:** Trajecta product-validation branch  
**Target offer:** Trajecta Verified Resume SDK Beta, USD 19 one-time<br>
**Return point:** approve this design before implementation planning

## 1. Decision

Sell a maintained private delivery pack, not access to the GitHub repository and
not a renamed copy of the Apache-licensed kernel.

The first paid artifact is **Trajecta Verified Resume SDK Beta v0.1**. It gives
an agent builder a bounded local-workspace workflow that can inspect a candidate
handoff, reject stale or mis-targeted state without advancing work, resume one
exact current branch once, and return a durable receipt on equivalent retry.

The offer is an SDK and reference workflow, not a turnkey ChatGPT-to-Codex
adapter. It does not claim automatic account integration, exact remote-thread
delivery, a native Codex session capability, hosted sync, general memory, or a
finished multi-agent platform. A future client-specific adapter must prove its
own host-issued capability before inheriting any exact-session claim.

## 2. Program decomposition

This goal contains four ordered sub-projects. Each receives its own
implementation plan and verification gate.

1. **Production local SDK:** add bounded file decoding, canonical envelopes, a
   local-workspace host registry, recoverable operation state, writer locking,
   and doctor, host-init, inspect, resume, and receipt commands.
2. **Release integrity:** produce one deterministic customer archive without
   repository history, internal notes, test credentials, or seller-only tools.
   Bind it with a non-self-referential manifest and detached signature.
3. **Customer-0 usability:** add a non-technical start page, three bounded
   recipes, troubleshooting, license notices, and a fixed fresh-context test.
4. **Commercial activation:** only after acceptance, obtain Ty's approval for
   terms/refund copy and attach the exact accepted bytes to delivery.

Checkout and automatic delivery remain inactive until all four gates pass.

## 3. Approaches considered

### Selected — separate paid SDK pack over the Apache core

Keep previously Apache-licensed Trajecta kernel material identifiable and ship
the paid beta as a separately bounded SDK/release layer. The customer pays
for the maintained workflow, tested packaging, recipes, release receipts, and
the beta update/support window.

This preserves the product's actual value while avoiding a false promise that
making a repository private erases rights already granted on older releases.

### Rejected — sell a ZIP of the current repository

This leaks internal product/research material, exposes Git history, gives poor
onboarding, and mostly resells code already governed by Apache 2.0. It creates
weak product value and a confusing license boundary.

### Deferred — hosted subscription

A hosted relay could justify recurring revenue later, but it introduces
accounts, security operations, billing, uptime, and support before repeated
use is proven. It is not part of the first beta.

## 4. Licensing boundary

The repository currently contains Apache License 2.0 material. Repository
privacy does not revoke permissions already granted to recipients. Apache's
official FAQ states that modified Apache-licensed work may be sold or kept
private, while the original covered material and attribution obligations still
apply. Section 4 of the license permits different terms for modifications or a
derivative as a whole only while the original license obligations are honored.

Primary references:

- <https://www.apache.org/foundation/license-faq.html>
- <https://www.apache.org/licenses/LICENSE-2.0.html>

Therefore:

- existing kernel files remain identified as Apache-2.0 components;
- their license and required notices ship with every customer archive that
  contains them;
- paid adapter/release files live under a separate commercial beta agreement;
- the commercial agreement must not claim ownership of or restrict rights in
  the Apache-covered components;
- no copy may claim that privacy retroactively converted an earlier Apache
  release into proprietary code;
- final customer-facing legal text requires Ty's approval and, before material
  scale, qualified legal review.

The first commercial agreement grants one purchaser internal use on devices
they control. It excludes redistribution, resale, public mirroring, sublicensing,
service-bureau use, and sharing the paid adapter/release files with another
person or organization. It provides no warranty or guaranteed compatibility
beyond the supported environment stated in the release receipt.

## 5. Offer and support boundary

**Price:** proposed USD 19 one-time during private beta; it does not go live
without Ty's commercial-activation approval.

Included:

- one versioned Trajecta Verified Resume SDK Beta archive;
- the supported local-workspace file SDK and CLI commands;
- one deterministic proof/demo;
- three reusable handoff recipes;
- a troubleshooting decision tree;
- checksums, a canonical manifest, and an Ed25519-signed release receipt;
- bug-fix builds for 30 calendar days from purchase;
- one email thread for installation clarification during that window.

Not included:

- a live setup call;
- workflow customization;
- ongoing support after 30 days;
- hosted storage, cloud sync, background monitoring, or team access;
- support for every AI client, shell, operating system, or Node version;
- a promise that the customer's AI followed or completed the transferred task.

Assisted setup remains a later USD 79 one-time offer and may be activated only
after two unrelated users complete self-serve onboarding.

## 6. Supported environment

Beta v0.1 supports only:

- macOS on Apple Silicon;
- Node.js `>=22.19 <23`;
- one local workspace and one active Trajecta writer at a time;
- a user-controlled JSON file as transport;
- English command output and English documentation;
- a bounded external-planner to local-workspace recipe in which the user
  explicitly moves, inspects, and approves the handoff file.

Windows, Linux, Intel macOS, hosted runtimes, direct account connectors,
multi-writer concurrency, and unattended resume are out of scope.

## 7. Customer workflow

### Step 1 — Download and verify

The buyer downloads `trajecta-verified-resume-sdk-beta-0.1.0.zip`, checks the
published SHA-256 value, unpacks it, and opens `START-HERE.html`.

No GitHub account or repository invitation is required.

### Step 2 — Install locally

The start page gives one copyable command to install the bundled package archive
from disk. Installation performs no network request and does not modify shell
startup files.

### Step 3 — Run doctor and proof

```text
trajecta-beta doctor
trajecta-beta demo
```

`doctor` checks the supported Node and platform versions, local write access,
single-writer state location, and required package files. `demo` runs the real
reviewed stale/current fixture and produces machine-readable receipts plus a
short human trace.

### Step 4 — Initialize one exact local workspace host

```text
trajecta-beta host init
```

Initialization displays the normalized repository identity and current Git
branch, then creates one 30-minute single-use local-workspace target card backed
by a host registry entry. The capability proves only the exact local registry,
repository fingerprint, state root, and branch observed by this process. It
does not claim a Codex thread or remote-chat identity. It never exports an
absolute home path, credential, cookie, prompt, transcript, or Git remote token.

### Step 5 — Inspect and resume

```text
trajecta-beta inspect handoff.traj.json
trajecta-beta resume handoff.traj.json
```

The handoff file may be produced by a human or another agent using the published
schema. Its content is candidate input, not proof of which planner authored it.
`inspect` is read-only. `resume` repeats validation, shows exact work/branch,
expected/current revision, provenance, and next action, then requires explicit
confirmation. Every rejection identifies the failed invariant and a safe next
step. Successful resume consumes the target card and advances once.

### Step 6 — Prove replay

```text
trajecta-beta receipt operation:...
```

Repeating the byte-equivalent accepted operation returns the same committed
receipt. Reusing its operation ID with altered input fails without appending a
competing receipt.

## 8. Command boundary

The paid SDK package is named `@patternstatic/trajecta-beta`, installs the
binary `trajecta-beta`, and declares `engines.node` as `>=22.19 <23`. It is a
separate package manifest and file boundary from the existing Apache
`trajecta-memory` package.

The paid SDK exposes only:

- `doctor` — read-only environment and archive audit;
- `demo` — isolated verified-resume proof;
- `host init` — exact local-workspace target-card creation;
- `inspect <file>` — read-only bounded envelope inspection;
- `resume <file>` — validated, confirmed resume;
- `receipt <operation-id>` — read-only durable receipt lookup;
- `version` — release and support-window information.

There is no `codex pair` command in v0.1. A future Codex adapter must obtain and
re-check a capability issued by an observed Codex host; if unavailable it must
return `CAPABILITY_UNAVAILABLE`, never synthesize authority from a random
string. There is no arbitrary command execution, URL following, transcript import,
background daemon, auto-update, telemetry, or implicit network access.

## 9. Customer archive

The release assembler creates exactly:

```text
trajecta-verified-resume-sdk-beta-0.1.0/
  START-HERE.html
  START-HERE.md
  packages/trajecta-beta-0.1.0.tgz
  recipes/01-planner-to-local-workspace.md
  recipes/02-stale-rejection.md
  recipes/03-inspect-retry-receipt.md
  TROUBLESHOOTING.md
  SUPPORTED-ENVIRONMENT.md
  LICENSES/CORE-APACHE-2.0.txt
  LICENSES/CORE-NOTICE.txt
  LICENSES/BETA-COMMERCIAL-TERMS.txt
  THIRD-PARTY-NOTICES.txt
  MANIFEST.json
  RELEASE-RECEIPT.json
  RELEASE-RECEIPT.json.sig
  SELLER-PUBLIC-KEY.pem
  SHA256SUMS.txt
```

The archive excludes `.git`, GitHub configuration, internal specs/plans,
research notes, seller email, API keys, cookies, local state, test run folders,
buyer data, screenshots, marketing drafts, and unpublished repositories.

JavaScript or TypeScript distributed to a buyer must be treated as inspectable.
Minification or bundling may reduce clutter but is not a security or license
boundary.

The beta package source boundary is separate from the current repository
package manifest. Every included Apache core path retains the Apache license,
the repository's applicable `NOTICE` text, and a modification notice where
required. Commercial terms apply only to paths classified `commercial-beta`
and to the stated support service; they never narrow rights in `apache-core`
paths.

## 10. Manifest and release receipt

`MANIFEST.json` is canonical JSON and inventories payload files only. It records
each payload's archive-relative path, byte length, SHA-256 digest, and license
class (`apache-core`, `commercial-beta`, `documentation`, or `notice`). Entries
are sorted by path and contain no absolute path. It explicitly excludes itself,
`RELEASE-RECEIPT.json`, its detached signature, the seller public key, and
`SHA256SUMS.txt`; no file is required to hash itself.

`RELEASE-RECEIPT.json` records:

- schema and product version;
- build commit and deterministic manifest digest;
- supported environment;
- build and verification timestamps;
- acceptance test identifiers;
- highest proven receipt level;
- known limitations;
- support-window definition;
- Ed25519 key ID and seller-controlled public-key fingerprint.

The seller signs the exact UTF-8 bytes of `RELEASE-RECEIPT.json` with an
Ed25519 private key stored outside the repository and customer archive.
`RELEASE-RECEIPT.json.sig` contains only the detached signature. The receipt
binds the SHA-256 digest of the canonical manifest. `SHA256SUMS.txt` lists the
manifest, receipt, detached signature, seller public key, and payload files but
excludes itself.

`SELLER-PUBLIC-KEY.pem` is included for convenience, not as its own trust root.
Before sale, the public-key fingerprint and ZIP SHA-256 digest must be pinned
out-of-band on the delivery page. Key rotation requires a new key ID, a new
release receipt, and both old and new fingerprints displayed for the 30-day
support window. An archive alone proves internal consistency, not seller origin.

"Deterministic" means that the assembler produces a byte-identical ZIP from the
same frozen release inputs. It sorts paths, normalizes permissions and archive
metadata, removes owner/group identity, and uses the receipt's explicit UTC
release instant as every archive modification time. Build and verification
times are frozen inputs before signing; the assembler never reads the wall clock
while constructing an accepted release.

The receipt proves which bytes were assembled and tested. It does not prove
that Payhip delivered them, that a buyer installed them, or that an AI
completed a task.

## 11. Failure UX

Every failure prints one code, one plain-language explanation, and one safe
next action. Required codes include:

- `UNSUPPORTED_ENVIRONMENT` — use the supported macOS/Node combination;
- `ARCHIVE_INCOMPLETE` — download the release again;
- `MANIFEST_MISMATCH` — stop and obtain a verified archive;
- `TARGET_EXPIRED` — create a new target card;
- `TARGET_MISMATCH` — open the intended local workspace host;
- `TARGET_CONSUMED` — inspect the stored receipt or create a new target;
- `INTEGRITY_MISMATCH` — regenerate the handoff file;
- `BRANCH_MISMATCH` — return to the exact paired branch;
- `REVISION_CONFLICT` — inspect current work and export a fresh packet;
- `USER_ACCEPTANCE_REQUIRED` — no mutation occurred; explicitly confirm;
- `OPERATION_IN_DOUBT` — inspect durable operation state before retrying;
- `CAPABILITY_UNAVAILABLE` — the requested client-specific host binding cannot
  be proved; use the supported local-workspace host or stop.

No error path silently selects another task, branch, repository, workspace, or
host registry entry.

## 12. Security and privacy

- Treat every handoff field and recipe response as untrusted data.
- Never execute commands, open links, or load referenced files from packet
  content.
- Reject files larger than 16 KiB before parsing. Require UTF-8 JSON with no
  trailing data, a maximum nesting depth of 8, no duplicate object keys, and a
  proof packet no larger than the kernel's 6,000-byte ceiling.
- Verify schema, bounded fields, canonical digest, expiry, target, workspace,
  active branch, expected revision, and explicit acceptance in that order.
- Use restrictive permissions and exclusive creation for target cards,
  operation records, and receipts.
- Strip credentials before normalizing Git remote identity.
- Keep all work state local by default.
- Collect no telemetry in beta v0.1.
- Never print secrets, absolute home paths, raw prompts, transcripts, or hidden
  agent state.

The production SDK does not package the proof ledger as its transaction layer.
It adds a per-state-root exclusive writer lock and a recoverable operation
journal with these states:

```text
created -> inspected -> reserved -> kernel-resumed -> receipt-committed -> target-consumed
```

Reservation is durable before kernel mutation. Kernel resume uses the same
operation ID and remains idempotent. A restart after reservation reconciles the
kernel operation result and either finishes the original receipt/consumption or
marks the operation `inspection-required`. It never starts a second resume.

## 13. Customer-0 acceptance gate

The SDK is sellable only when a fresh tester can complete all checks from the
delivered ZIP, a separately pinned ZIP digest, and the pinned seller public-key
fingerprint, without access to the source repository or seller worktree.

After unpacking, the tester runs:

```text
trajecta-beta verify-acceptance \
  --archive <downloaded-zip-path> \
  --pinned-zip-sha256 <independently-obtained-value> \
  --bundle-root <unpacked-directory> \
  --public-key <independently-obtained-key> \
  --state-root <new-test-directory>/.trajecta-beta-state \
  --evidence-dir <new-empty-directory>
```

The command writes a machine-readable evidence set containing the archive
allowlist audit, invoked commands, exit statuses, state/history/ledger hashes,
target states, exact receipt bytes, normalized semantic traces, product
version, resolved state paths, and manual interventions. It hashes the original
downloaded ZIP before inspecting the unpacked tree. In acceptance mode, `demo`,
`host init`, `inspect`, `resume`, and `receipt` receive the one explicit state
root; the SDK must not make any durable write outside it.

1. ZIP checksum matches the separately pinned value and the receipt signature
   verifies against the independently obtained key;
2. archive audit finds no excluded seller/internal material;
3. offline local installation succeeds;
4. `doctor` passes on the supported environment;
5. `demo` writes real stale and accepted receipts;
6. `inspect` changes no state or receipt ledger;
7. a stale packet is rejected with identical before/after work state;
8. a wrong target and a branchless packet are rejected without revealing an
   unauthorized work revision or advancing state;
9. one exact current packet resumes once;
10. equivalent retry returns the original receipt byte-for-byte;
11. altered operation reuse fails without a competing receipt;
12. target-card expiry and single-use behavior pass;
13. every resolved durable state path is under the declared test state root,
    and deleting the test directory removes all listed customer test state;
14. another fresh directory reproduces the same semantic proof;
15. an independent fresh-context operator receives only the delivered archive,
    pinned key, and `START-HERE.html`; receives no help for 15 minutes; and
    either completes doctor, demo, host initialization, inspect, stale reject,
    accepted resume, and receipt lookup or records the exact blocking step.

The fixed operator rubric records elapsed time, completion state for each step,
verbatim friction, and all help after the 15-minute no-help window. Passing this
fresh-context test does not support a broad non-technical-human usability claim;
that requires later external design-partner evidence.

## 14. Commercial activation gate

Do not connect the paid Payhip product to this archive until:

- Customer-0 acceptance passes all 15 checks;
- Ty approves the customer-facing commercial terms, refund/contact copy, and
  exact USD 19 offer;
- one non-revenue test order proves download and delivery;
- the delivered archive digest matches the accepted Customer-0 digest;
- support contact and version-replacement procedure are operational.

Marketing may describe only the receipt levels observed in acceptance. It may
not call v0.1 a ChatGPT-to-Codex adapter or claim automatic account integration,
perfect memory, conflict-free agents, or verified task completion.

## 15. Definition of done

This delivery program is complete when:

- the production local SDK and release assembler are reviewed and merged;
- the deterministic customer archive exists;
- Customer-0 passes from a fresh environment without repository access;
- all artifacts have coherent Apache/commercial notices;
- a release receipt binds the tested archive;
- the exact accepted ZIP, detached trust information, and delivery instructions
  are ready for Ty-approved commercial activation;
- LWM records the outcome, remaining limitations, and the next validation
  branch.

Until then, Trajecta has a strong reviewed proof and a private repository, but
not yet a product that should accept money.

## 16. Ordered implementation plans

Implementation is split into four plans and reviewed in order:

1. **Production local SDK:** untrusted file decoder, canonical envelope,
   local-workspace host registry, expiry/single-use target cards, exclusive
   writer lock, recoverable operation journal, CLI, and parent-contract tests.
   No archive, payment, or marketing work.
2. **Release integrity:** separate beta package manifest, Apache license/NOTICE
   mapping, non-self-referential manifest, Ed25519 receipt signing, deterministic
   archive builder, archive auditor, and verifier.
3. **Customer-0 usability:** start page, three recipes, troubleshooting,
   machine-readable acceptance evidence, two fresh installs, and the fixed
   fresh-context operator test.
4. **Commercial activation:** Ty-approved legal/refund/contact copy, one
   non-revenue delivery test, exact-byte comparison, and support/replacement
   procedure. No activation is authorized by this design alone.

The first implementation plan covers item 1 only. The later plans must consume
its reviewed interfaces rather than replacing its authority model with easier
packaging shortcuts.
