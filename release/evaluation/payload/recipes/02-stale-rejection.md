# See a stale handoff rejected

Run `trajecta-beta demo --state-root ./stale-test-state` using a new directory. The demo creates work, exports a handoff, then advances the work before trying the old handoff.

Expected: `STALE REJECTED REVISION_CONFLICT`, revision 3 → 3. The target remains available for the current packet. A rejection does not authorize applying old instructions or overwriting newer work.
