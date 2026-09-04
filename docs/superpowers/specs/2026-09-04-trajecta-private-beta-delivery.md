# Trajecta Private Beta Delivery Design

**Status:** proposed for Ty review  
**Date:** 2026-09-04  
**Owner:** Trajecta product-validation branch  
**Target offer:** Trajecta Verified Resume Beta Kit, USD 19 one-time  
**Return point:** approve this design before implementation planning

## 1. Decision

Sell a maintained private delivery pack, not access to the GitHub repository and
not a renamed copy of the Apache-licensed kernel.

The first paid artifact is **Trajecta Verified Resume Beta Kit v0.1**. It gives
an AI-native solo builder a bounded local workflow that can inspect a candidate
handoff, reject stale or mis-targeted state without advancing work, resume one
exact current branch once, and return a durable receipt on equivalent retry.

The offer remains a developer beta. It does not claim automatic ChatGPT account
integration, exact remote-thread delivery, hosted sync, general memory, or a
finished multi-agent platform.

## 2. Program decomposition

This goal contains four ordered sub-projects. Each receives its own
implementation plan and verification gate.

1. **Adapter completion:** turn the reviewed in-memory proof into a safe local
   file workflow with doctor, pair, inspect, resume, and receipt commands.
2. **Release assembly:** produce one deterministic customer archive without
   repository history, internal notes, test credentials, or seller-only tools.
3. **Buyer onboarding:** provide a non-technical start page, three bounded
   recipes, troubleshooting, license notices, and support boundaries.
4. **Customer-0 acceptance:** install only from the customer archive in a fresh
   directory and reproduce stale rejection, one exact resume, and same-receipt
   retry without repository access.

Checkout and automatic delivery remain inactive until all four gates pass.

## 3. Approaches considered

### Selected — separate paid adapter pack over the Apache core

Keep previously Apache-licensed Trajecta kernel material identifiable and ship
the paid beta as a separately bounded adapter/release layer. The customer pays
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

**Price:** USD 19 one-time during private beta.

Included:

- one versioned Trajecta Verified Resume Beta Kit archive;
- the supported local file-adapter commands;
- one deterministic proof/demo;
- three reusable handoff recipes;
- a troubleshooting decision tree;
- checksums and a signed or digest-bound release receipt;
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
- Node.js 22.19 or newer in the Node 22 line;
- one local workspace and one active Trajecta writer at a time;
- a user-controlled JSON file as transport;
- English command output and English documentation;
- a bounded ChatGPT-planning to local-Codex resume recipe in which the user
  explicitly moves and approves the handoff file.

Windows, Linux, Intel macOS, hosted runtimes, direct account connectors,
multi-writer concurrency, and unattended resume are out of scope.

## 7. Customer workflow

### Step 1 — Download and verify

The buyer downloads `trajecta-verified-resume-beta-0.1.0.zip`, checks the
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

### Step 4 — Pair one exact workspace

```text
trajecta-beta codex pair
```

Pairing displays the normalized repository identity and current Git branch,
then creates one 30-minute single-use target card. It never exports an absolute
home path, credential, cookie, prompt, transcript, or Git remote token.

### Step 5 — Inspect and resume

```text
trajecta-beta inspect handoff.traj.json
trajecta-beta resume handoff.traj.json
```

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

The paid adapter exposes only:

- `doctor` — read-only environment and archive audit;
- `demo` — isolated verified-resume proof;
- `codex pair` — exact local target-card creation;
- `inspect <file>` — read-only bounded envelope inspection;
- `resume <file>` — validated, confirmed resume;
- `receipt <operation-id>` — read-only durable receipt lookup;
- `version` — release and support-window information.

There is no arbitrary command execution, URL following, transcript import,
background daemon, auto-update, telemetry, or implicit network access.

## 9. Customer archive

The release assembler creates exactly:

```text
trajecta-verified-resume-beta-0.1.0/
  START-HERE.html
  START-HERE.md
  packages/trajecta-beta-0.1.0.tgz
  recipes/01-chatgpt-to-codex.md
  recipes/02-stale-rejection.md
  recipes/03-inspect-retry-receipt.md
  TROUBLESHOOTING.md
  SUPPORTED-ENVIRONMENT.md
  LICENSES/CORE-APACHE-2.0.txt
  LICENSES/BETA-COMMERCIAL-TERMS.txt
  THIRD-PARTY-NOTICES.txt
  MANIFEST.json
  RELEASE-RECEIPT.json
  SHA256SUMS.txt
```

The archive excludes `.git`, GitHub configuration, internal specs/plans,
research notes, seller email, API keys, cookies, local state, test run folders,
buyer data, screenshots, marketing drafts, and unpublished repositories.

JavaScript or TypeScript distributed to a buyer must be treated as inspectable.
Minification or bundling may reduce clutter but is not a security or license
boundary.

## 10. Manifest and release receipt

`MANIFEST.json` records every archive-relative file, byte length, SHA-256
digest, and license class (`apache-core`, `commercial-beta`, `documentation`,
or `notice`). Entries are sorted by path and contain no absolute path.

`RELEASE-RECEIPT.json` records:

- schema and product version;
- build commit and deterministic manifest digest;
- supported environment;
- build and verification timestamps;
- acceptance test identifiers;
- highest proven receipt level;
- known limitations;
- support-window definition;
- seller-controlled public verification fingerprint.

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
- `TARGET_MISMATCH` — open the intended workspace/session;
- `TARGET_CONSUMED` — inspect the stored receipt or create a new target;
- `INTEGRITY_MISMATCH` — regenerate the handoff file;
- `BRANCH_MISMATCH` — return to the exact paired branch;
- `REVISION_CONFLICT` — inspect current work and export a fresh packet;
- `USER_ACCEPTANCE_REQUIRED` — no mutation occurred; explicitly confirm;
- `OPERATION_IN_DOUBT` — inspect durable operation state before retrying.

No error path silently selects another task, branch, repository, or session.

## 12. Security and privacy

- Treat every handoff field and recipe response as untrusted data.
- Never execute commands, open links, or load referenced files from packet
  content.
- Enforce size limits before JSON parsing and reject duplicate keys.
- Verify schema, bounded fields, canonical digest, expiry, target, workspace,
  active branch, expected revision, and explicit acceptance in that order.
- Use restrictive permissions and exclusive creation for target cards,
  operation records, and receipts.
- Strip credentials before normalizing Git remote identity.
- Keep all work state local by default.
- Collect no telemetry in beta v0.1.
- Never print secrets, absolute home paths, raw prompts, transcripts, or hidden
  agent state.

## 13. Customer-0 acceptance gate

The kit is sellable only when a fresh tester can complete all checks from the
assembled ZIP without access to the source repository or seller worktree:

1. archive checksum matches the published value;
2. archive audit finds no excluded seller/internal material;
3. offline local installation succeeds;
4. `doctor` passes on the supported environment;
5. `demo` writes real stale and accepted receipts;
6. `inspect` changes no state or receipt ledger;
7. a stale packet is rejected with identical before/after work state;
8. a wrong target and branchless packet reveal no unauthorized work revision;
9. one exact current packet resumes once;
10. equivalent retry returns the original receipt byte-for-byte;
11. altered operation reuse fails without a competing receipt;
12. target-card expiry and single-use behavior pass;
13. deleting the test directory removes all customer test state;
14. another fresh directory reproduces the same semantic proof;
15. a non-technical reader completes the quickstart without undocumented
    repository knowledge.

The acceptance record must include the archive digest, commands, exit status,
receipt IDs, observed revisions, tester friction, and any manual intervention.

## 14. Commercial activation gate

Do not connect the paid Payhip product to this archive until:

- Customer-0 acceptance passes all 15 checks;
- Ty approves the customer-facing commercial terms, refund/contact copy, and
  exact USD 19 offer;
- one non-revenue test order proves download and delivery;
- the delivered archive digest matches the accepted Customer-0 digest;
- support contact and version-replacement procedure are operational.

Marketing may describe only the receipt levels observed in acceptance. It may
not claim automatic ChatGPT integration, perfect memory, conflict-free agents,
or verified task completion.

## 15. Definition of done

This delivery program is complete when:

- the private adapter and assembler are reviewed and merged;
- the deterministic customer archive exists;
- Customer-0 passes from a fresh environment without repository access;
- all artifacts have coherent Apache/commercial notices;
- a release receipt binds the tested archive;
- the Payhip test order delivers those exact bytes;
- LWM records the outcome, remaining limitations, and the next validation
  branch.

Until then, Trajecta has a strong reviewed proof and a private repository, but
not yet a product that should accept money.
