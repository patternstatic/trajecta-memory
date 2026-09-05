# See a stale handoff rejected

First complete recipe 1. Stay in the same test folder and run:

```sh
./node_modules/.bin/trajecta-beta inspect ./trial-state/stale.json --state-root ./trial-state
./node_modules/.bin/trajecta-beta resume ./trial-state/stale.json --state-root ./trial-state --accept
```

Expected: inspection reports the old expected revision and the newer current
revision. Resume prints a rejected receipt with `REVISION_CONFLICT` and exits
with code 2. That exit code is the expected result, not a broken installation.
The receipt's `observedRevisionBefore` and `observedRevisionAfter` are both 3.
No work revision advances; a rejection receipt is deliberately saved for audit.
The target remains available for the current packet.

Do not force the old packet through or overwrite newer work. Continue with the
current packet in recipe 3. Outside this trial, inspect current work and export
a fresh packet instead of manually changing the expected revision.
