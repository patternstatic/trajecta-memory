# Architecture

Trajecta is a work-continuity kernel, not a transcript store and not a message
router. It keeps one durable trajectory available to multiple execution
surfaces while leaving transport, identity, authorization, and final truth to
the host application.

## Fast continuity loop

```text
surface request
  -> route cue against compact work metadata
  -> select one exact work ID
  -> build a bounded transfer packet
  -> resume with expected revision
  -> capture material deltas
  -> send an evidence-bearing outcome to the next surface
```

The fast loop may record goals, instructions, decisions, blockers,
corrections, branch transitions, handoffs, outcomes, and next actions. It must
not record prompts, hidden reasoning, raw tool output, or unchanged chatter.

## Storage law

`deltas.jsonl` is append-only. `state.json` is an atomically replaced current
projection. `operations.jsonl` reserves an operation before mutation and
commits its exact result afterward. Byte-equivalent retries return that result;
altered reuse fails closed, and an interrupted reservation requires inspection
instead of a blind retry.

Every mutation carries an expected revision. A stale surface receives a
`RevisionConflict` and cannot overwrite a newer cloud or local update.

The alpha file store expects one owning process to serialize mutations. A
multi-process adapter must add a lock or place the store behind one service.

## Cue-first retrieval

`route()` scores stable words from the work topic, goal, instruction, and
branch cues. It returns compact candidates only. `transfer()` requires one
exact work ID and then renders the selected state within a hard byte budget.

Contracts are excluded by default. A host must explicitly request the latest
contract anchor after the exact work item is selected.

## Branches and return points

A branch has a purpose, stable cues, and a return point. Parking a branch keeps
that information and its delta history. `parked` means preserved for return,
not completed or erased.

## Slow learning boundary

Work checkpoints are eligible evidence for a later learning review. They never
rewrite procedures or activate a skill on the response-critical path. A future
learning package should use immutable candidates, fixed-corpus validation, and
an explicit owner-authorized active pointer.

## Trust boundary

A packet proves only what the store recorded. It does not prove that the target
surface received, read, understood, or acted on it. Transport adapters must
return their own durable receipts when those guarantees matter.
