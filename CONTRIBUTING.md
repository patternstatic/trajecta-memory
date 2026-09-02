# Contributing

Trajecta favors small, inspectable mechanisms over broad autonomous memory.

Before opening a pull request:

1. keep the core transport-neutral and consumer-neutral;
2. preserve append-only history and revision compare-and-swap;
3. add tests for both cloud-to-local and local-to-cloud behavior when changing transfer semantics;
4. do not add transcript ingestion, hidden-state claims, or implicit authority;
5. run `npm run check`.

Adapters should live outside the core unless their contract is product-neutral.
