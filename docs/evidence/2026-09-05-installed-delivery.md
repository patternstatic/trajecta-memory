# Installed delivery checkpoint — 2026-09-05

## Direction

The goal remains a maintained private delivery slice that a fresh customer can
install and use. Release cryptography is supporting work, not the product's
acceptance gate. Commercial activation and public marketing remain excluded.

## Verified progress

- Production SDK integration exists at merge commit `a59e187` (private PR 2).
- A real npm installation first exposed the missing `package/` tar prefix,
  Node's refusal to strip TypeScript under `node_modules`, and the relocated
  CLI's no-op launcher guard. Repository-local tests did not detect these.
- `20bbb48` and `bbcbff6` correct the npm format and generate runtime JavaScript
  with an explicit CLI invocation. The installed package has no dependencies
  or lifecycle scripts; the install uses npm 10.9.8 offline mode.
- At `69cb62d`, two independent frozen snapshots produced the same signed ZIP.
  ZIP SHA-256: `6e852b5bac24b196e4f422e92ffd2c4ef11e3b59e8b217eed8a5b77293a802f5`.
  This is an earlier evaluation artifact, **not the final customer build**.
- Final-file audit and offline install evidence were saved outside the source
  tree in the `trajecta-real-build.vUaUeh` evaluation directory. The signing key
  remains outside the repository; no key is included in this note.
- Actual installed `version`, `doctor`, and `demo` pass on macOS arm64,
  Node 22.23.1. The demo rejects stale work at revision 3, accepts current work
  to revision 4, and returns the original receipt on retry.
- The revised recipes were executed verbatim against the package extracted
  from that ZIP in a separate clean customer folder (`trajecta-manual-recipe-rq77Mm`).
  Doctor and host init passed; stale inspection showed expected 2/current 3;
  stale resume exited 2 with `REVISION_CONFLICT`, before/after 3; current resume
  succeeded; both retry and direct lookup compared byte-identical to the
  accepted receipt. Recipe 1 uses the shipped SDK API, not a source checkout.
- A fresh `npm run check` completed successfully: core tests, core demo/proof,
  all 199 beta tests, and the beta demo. The release checks are tracked
  separately because the archive-pin CLI correction was in progress during
  their first aggregate run.

## Corrections from integration review

- The real seller command must be tested, not merely its argument parser.
- Offline installation must pass before a signed output ZIP is published.
- A valid signature does not replace exact manifest-schema validation.
- Verification must take an independent archive digest, never derive its own
  expected digest from the same archive.
- Generated-JavaScript reproducibility requires a frozen seller Node version;
  customer support and seller build toolchain are distinct contracts.

## Still not proven / next work

1. Rebuild the final evaluation artifact after all review corrections and
   current recipes are committed; audit and install those exact bytes.
2. Implement and test the specified customer `verify-acceptance` command and
   its evidence set. It is not currently exposed by the shipped SDK.
3. Complete all 15 Customer-0 checks, including wrong target, branchless input,
   altered reuse, expiry/single-use, read-only inspection, state-path audit,
   second-directory semantic reproduction, and a fresh-context operator.
4. An internal trial is not real customer demand, a verified remote AI
   connection, paid use, delivery after payment, or an external usability study.
5. Ty's approval of final terms/refund/contact copy and offer, plus a non-revenue
   delivery test, remain necessary before commercial activation.

No narrower completion claim should replace those open requirements.

## Rebuilt evaluation artifact

At clean build commit `fe639b30573a7ad169b9fe9d4687d9086d36c521`, the real seller
executable rebuilt two matching archives using pinned Node 22.23.1/npm 10.9.8.
All 47 release tests passed. The controlled offline install passed before
output publication. The final ZIP was read back and audited before external
pins and evidence were written.

- ZIP: `Downloads/trajecta-evaluation-20260905-0630/trajecta-verified-resume-sdk-beta-0.1.0.zip`
- SHA-256: `d175105fe80c73ec3bf727d65135b137f99d61f22b77f31ce0ddbe8417288347`
- Independently retained evaluation-key fingerprint:
  `eab52d34e247dd0f2b0b0972bab6368d52cc372321828859f39e51533f685c1b`
- Release instant: `2026-09-05T06:30:00Z`.
- A separate executable `verify` invocation supplied that literal digest and
  independent public key, then extracted all 17 allowed files to a new private
  directory. The archive now contains the executed manual recipes.
- A fresh-context AI operator received only this ZIP, independent trust values,
  and permission to follow its instructions; its outcome is not yet asserted
  by this checkpoint.

This is a ready-to-try **evaluation**, not completed Customer-0 acceptance and
not authorized for sale. The original signed limitations remain unchanged.
