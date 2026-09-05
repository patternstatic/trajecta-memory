# Inspect, accept, retry

For a prepared current handoff, run `trajecta-beta inspect handoff.json`. Inspection does not advance work. Run `trajecta-beta resume handoff.json --accept` after checking the displayed work and revision.

Retry the identical file with the same operation ID. It returns the original receipt bytes; revision must not increase again. Retrieve the stored receipt with `trajecta-beta receipt operation:YOUR-ID`.

Changing the file while reusing its operation ID is a conflict. The included demo exercises an identical retry even after the target expires.
