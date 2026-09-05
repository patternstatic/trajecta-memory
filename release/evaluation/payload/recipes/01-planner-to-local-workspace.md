# Planner to local workspace

Initialize a target from the intended Git workspace with `trajecta-beta host init --out target.json`. A planner can use the SDK's `buildLocalResumeEnvelope` with that target and a transfer packet from the same work store. The SDK validates the packet's work, branch, expected revision, digest and deadline.

Run `trajecta-beta inspect handoff.json` first. Compare the next action and current revision. Only then run `trajecta-beta resume handoff.json --accept`.

There is currently no graphical packet editor or automatic account connector. For the fully prepared example, use `trajecta-beta demo --state-root ./new-demo-state`. Preparing your own packet requires the exported SDK API; do not edit its digest by hand.
