# Commercial preparation: consuming-path inspection

Inspected at implementation HEAD 638d708. No runtime changes made in this pass.

The existing evaluation boundary is structural, not just marketing copy:

- `tools/release-integrity/src/build.ts`: documents and terms are selected from
  `release/evaluation`; two independent source snapshots must produce identical
  ZIP bytes; controlled offline install gates publication.
- `tools/release-integrity/src/stage-package.ts`: evaluation terms are also
  embedded in the installed package. Changing only outer documentation leaves
  contradictory inner licensing.
- `tools/release-integrity/src/signing.ts`: constructs only evaluation receipts,
  fixed limitations include Customer-0-not-run, not-for-sale and no-commercial-
  activation. Signing also invokes the strict evaluation parser.
- `packages/trajecta-beta/src/release/signature-verification.ts`: installed buyer
  verification invokes the same strict evaluation parser before signature and
  manifest binding verification.
- `packages/trajecta-beta/src/release/contracts.ts`: exact schema, field set,
  scope and limitations are enforced. Relaxing these globally would weaken the
  old evidence contract and is not an acceptable commercial-mode shortcut.
- `packages/trajecta-beta/src/acceptance.ts`: evidence labels evaluation as
  not-for-sale unconditionally. New commercial-candidate output must distinguish
  technical acceptance from seller approval and actual commercial activation.

Implementation direction: preserve existing evaluation behavior and exact
validation; add an explicit commercial-candidate profile routed consistently
through source selection, inner terms, assembly, signed receipt, installed
verification and acceptance evidence. It must not claim completed Customer-0
before testing its own frozen bytes, or claim checkout activation from a local
signature. Price/support/refund approval is already given by Ty; do not re-ask.

A bounded read-only independent consumer-map review is running to identify
additional seams before writing the executable plan. No remote action, private
key read, commercial artifact or public claim was made in this inspection.
