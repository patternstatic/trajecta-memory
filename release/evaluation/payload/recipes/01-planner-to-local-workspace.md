# Planner to local workspace

This hands-on trial uses the installed SDK, not the repository. It prepares two
packets in your own test folder so you can inspect and accept them yourself.
Allow about ten minutes. It simulates the planner locally; it does not prove
cross-account transport or an external AI's authorship.

## 1. Prepare a disposable workspace

Stay in the new test folder where you installed the package. These commands are
only for that new folder, not an existing project. The example remote is an
identity label; no request is sent to it.

```sh
git init -b main
git -c user.name="Trajecta Trial" -c user.email="trial@example.invalid" commit --allow-empty -m "Start local trial"
git remote add origin https://example.invalid/customer/workspace.git
mkdir -m 700 trial-state
./node_modules/.bin/trajecta-beta doctor --state-root ./trial-state
./node_modules/.bin/trajecta-beta host init --state-root ./trial-state --out ./trial-state/target.json
```

Expected: doctor prints `"code":"OK"`; host initialization displays
`example.invalid/customer/workspace` and `main`. The private target expires in
30 minutes. Stop if the identity is different. All handoff and receipt files in
this recipe stay under `trial-state`.

## 2. Prepare an old and a current handoff

Copy this entire block into Terminal once. It uses the included SDK API to
create a small work item, save its first handoff, advance the plan, and save a
new handoff. It does not execute either next action. There is no graphical
packet editor in this beta.

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TrajectaStore, withWriterLock, buildLocalResumeEnvelope } from './node_modules/@patternstatic/trajecta-beta/beta/src/index.js';
const stateRoot = path.resolve('trial-state');
if (existsSync(path.join(stateRoot, 'stale.json')) || existsSync(path.join(stateRoot, 'current.json'))) {
  throw new Error('Trial packets already exist. Keep them and continue to inspection.');
}
const target = JSON.parse(readFileSync(path.join(stateRoot, 'target.json'), 'utf8'));
if (Date.parse(target.expiresAt) <= Date.now()) throw new Error('Target expired. Start again in a new test folder.');
const id = prefix => `${prefix}:${randomUUID()}`;
const surface = { kind: 'cloud', name: 'Manual planner trial', session: 'cloud:manual-trial' };
const store = new TrajectaStore(path.join(stateRoot, 'kernel'));
const packets = await withWriterLock({ stateRoot, operationId: id('operation') }, () => {
  const { work } = store.open({ operationId: id('operation'), topic: 'Prepare a product test', goal: 'Continue the current test plan once', surface,
    initialBranch: { label: 'main', purpose: 'Try a verified local handoff', cues: ['trial'], returnPoint: 'Read the saved receipt' } });
  store.capture({ operationId: id('operation'), workId: work.id, expectedRevision: work.revision, surface,
    kind: 'handoff', summary: 'First draft', provenance: ['artifact:manual-trial'], nextAction: 'Review the old draft', targetSurface: 'local' });
  const stale = store.transfer(work.id, 'resume', 'local');
  store.capture({ operationId: id('operation'), workId: work.id, expectedRevision: store.getWork(work.id).revision, surface,
    kind: 'decision', summary: 'Use the revised test plan', provenance: ['artifact:revised-trial'], nextAction: 'Review the current plan' });
  return { stale, current: store.transfer(work.id, 'resume', 'local') };
});
for (const [name, packet] of Object.entries(packets)) {
  const envelope = buildLocalResumeEnvelope({ schema: 'trajecta.local-resume-envelope/v1', envelopeId: id('envelope'), operationId: id('operation'),
    createdAt: new Date().toISOString(), expiresAt: target.expiresAt, target, packet });
  writeFileSync(path.join(stateRoot, `${name}.json`), JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log('Prepared trial-state/stale.json and trial-state/current.json. No work has been resumed.');
JS
```

Next, follow [stale rejection](02-stale-rejection.md), then
[inspect, accept, and retry](03-inspect-retry-receipt.md). Do not edit a packet's
revision, target, operation ID, or digest by hand.

## Use with your own planner later

The work store is authoritative; a transfer packet is a candidate projection.
An external planner must work from a packet exported from that same store and
return a bounded envelope using `buildLocalResumeEnvelope`. You manually move
the JSON file, inspect it locally, then explicitly accept it. Writing `cloud`
in a packet does not authenticate its author. Target cards are private bearer
capabilities: share only with a planner you intend to authorize. This SDK does
not establish a ChatGPT account or Codex task connection for you.
