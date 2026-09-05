# Inspect, accept, retry

After recipes 1 and 2, stay in the same test folder:

```sh
./node_modules/.bin/trajecta-beta inspect ./trial-state/current.json --state-root ./trial-state
```

Inspection is read-only. Check that the next action is `Review the current plan`
and the expected/current revision is 3. If it differs, stop and inspect why.
Acceptance records a continuation; it does not execute the text of that action.

```sh
./node_modules/.bin/trajecta-beta resume ./trial-state/current.json --state-root ./trial-state --accept > ./trial-state/accepted-receipt.json
./node_modules/.bin/trajecta-beta resume ./trial-state/current.json --state-root ./trial-state > ./trial-state/retry-receipt.json
cmp ./trial-state/accepted-receipt.json ./trial-state/retry-receipt.json
```

`cmp` prints nothing and exits successfully when the bytes are identical. The
accepted receipt says `RESUMED`, `accepted`, and revision 3 → 4. The retry needs
no new acceptance because it returns the existing receipt instead of resuming
again. The target is now consumed for other operations.

To retrieve that same receipt directly:

```sh
trial_operation=$(node --input-type=module -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync('trial-state/current.json','utf8')).operationId)")
./node_modules/.bin/trajecta-beta receipt "$trial_operation" --state-root ./trial-state > ./trial-state/looked-up-receipt.json
cmp ./trial-state/accepted-receipt.json ./trial-state/looked-up-receipt.json
```

Changing input while reusing its operation ID must fail, not create a competing
receipt. Preserve the original packet and receipts for inspection. For another
trial, use a new folder. To remove this trial's work state later, move only its
`trial-state` folder to Trash; do not remove any real project state.
