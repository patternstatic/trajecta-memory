# Marketing Learning: Trajecta

**Observed:** 2026-09-04  
**Audience:** Trajecta product owner and future launch operator  
**Decision status:** working marketing axis; no campaign or spend authorized  
**Scope:** developer-tool acquisition, activation, and evidence loops for the
current public alpha  

## Executive settlement

Trajecta should use **proof-led, founder-led developer marketing** before broad
social distribution.

The first marketing job is not “get views.” It is:

> Find builders who regularly plan in one AI and implement in another, let them
> experience a stale or wrong-work handoff, then prove that Trajecta resumes the
> exact branch with an inspectable receipt.

The current priority order is:

1. make one real adapter easy to try;
2. turn its failure/recovery trace into a repeatable proof artifact;
3. recruit five qualified handoffs through GitHub and founder-led conversations;
4. learn whether users repeat without prompting;
5. only then prepare a coordinated launch or paid offer.

TikTok and broad consumer-style UGC are parked. They may fit a softer companion
product later, but they are not the primary acquisition channel for Trajecta's
current technical buyer.

## Evidence labels

- **FACT:** observed on an official company, platform, documentation, or public
  repository page on the date above.
- **INFERENCE:** a product or marketing conclusion drawn from those facts.
- **HYPOTHESIS:** a claim Trajecta must test with real users.
- **UNKNOWN:** evidence is not yet sufficient.

## What strong developer products actually market

### 1. A usable artifact, not a promise

**FACT:** Hacker News says a Show HN must be something people can try, ideally
without signup or email barriers; landing pages and fundraisers are not Show HN
material. Early-stage and visually rough work is acceptable when it is real and
the maker is present to discuss it. ([Show HN Guidelines](https://news.ycombinator.com/showhn.html))

**FACT:** Product Hunt's current guidance similarly requires a live or credibly
usable product and warns against spam, paid promotion, and asking directly for
upvotes. It recommends measurable launch goals rather than treating leaderboard
rank as the only outcome. ([Product Hunt launch guide](https://www.producthunt.com/launch),
[pre-launch guidance](https://www.producthunt.com/launch/before-launch),
[2026 featuring guidelines](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines))

**INFERENCE:** Trajecta is not ready for Show HN or a main Product Hunt launch
until the file-based ChatGPT→Codex adapter can be tried end to end. The current
landing demo is useful for comprehension, not sufficient product evidence.

### 2. Product mechanics that generate distribution

**FACT:** MemoryPlugin uses free adjacent utilities and migration education as
acquisition loops: a free ChatGPT-memory export tool, import guides, a macOS sync
app, and open-source skills for coding agents. ([MemoryPlugin](https://www.memoryplugin.com/))

**FACT:** Supermemory combines an open-source repository, reproducible memory
benchmarks, a free builder tier, connectors, documentation, and a startup/research
program. These artifacts give different audiences a low-friction entry point
before a paid plan. ([Supermemory repository](https://github.com/supermemoryai/supermemory),
[Supermemory pricing](https://supermemory.ai/pricing/))

**FACT:** ModelCaddy uses a narrow category statement, local/private architecture,
explicit values, an early-access list, and a limited founder program rather than
pretending broad adoption. ([ModelCaddy about](https://modelcaddy.com/about))

**INFERENCE:** Trajecta needs its own acquisition object. The strongest candidate
is not another memory guide; it is a free **Handoff Autopsy** that accepts two
sanitized packets and explains which one is stale, what evidence is missing, and
whether resume is safe. The tool should lead naturally to the full adapter.

### 3. Opinion and utility beat generic content volume

**FACT:** PostHog's developer-marketing lessons emphasize a remarkable product,
an opinionated position, language developers actually use, useful technical
content, and treating the website as a product. It explicitly contrasts this
with generic content, ads, and email spam. ([PostHog: 40 developer-marketing lessons](https://newsletter.posthog.com/p/40-things-weve-learned-about-marketing))

**FACT:** Google recommends people-first content with original information,
first-hand experience, clear sourcing, and substantial value beyond rewriting
other sources; it warns against mass-producing trend-driven search content.
([Google helpful-content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content))

**INFERENCE:** Every Trajecta post should contain at least one artifact a builder
can inspect: a failing trace, receipt, diff, test, packet example, or runnable
command. “Five tips for AI memory” content would dilute the category.

## The marketable category

Trajecta should not enter the crowded category **portable AI memory**.

Use this frame instead:

> Verified work handoffs for AI agents.

The category contrast is:

| Existing answer | What it does | Remaining seam |
|---|---|---|
| Native agent memory | Remembers within one product | Does not verify a cross-product resume |
| `HANDOFF.md` | Describes continuation state | Can be stale, ambiguous, or mis-targeted |
| Broad memory layer | Retrieves long-lived context | Does not necessarily protect current work revision |
| Trajecta | Carries bounded work state | Verifies target, branch, provenance, revision, and receipt |

Candidate message:

> Your agent did not forget. It resumed the wrong work.

Support:

> Trajecta carries the current branch, evidence, open loops, and next action—and
> refuses stale resumes instead of guessing.

This remains a hypothesis until real users repeat the workflow.

## Ideal first customer

**Primary ICP:** an AI-native solo builder or technical founder who:

- plans in ChatGPT or Claude;
- implements in Codex, Claude Code, or Cursor;
- changes surfaces at least twice per week;
- works across multiple repositories or branches;
- has lost time to stale instructions, ambiguous next actions, or wrong-context
  continuation;
- can inspect a JSON/Markdown receipt and give mechanism-level feedback.

**Disqualifiers for the first cohort:** people seeking a general companion,
conversation archive, team knowledge base, or magical automatic memory.

## The funnel Trajecta should measure

The unit of value is a **completed verified handoff**, not a page view.

```text
qualified visitor
  → starts handoff demo
  → inspects stale rejection
  → pairs a real Codex target
  → resumes one exact work item
  → completes and returns an outcome
  → performs a second handoff without prompting
  → asks for onboarding, support, or a paid package
```

### North-star learning signal

`repeat_verified_handoff_within_7d`

### Supporting signals

- qualified handoff conversations;
- real adapter starts;
- target pair completed;
- stale packet correctly rejected;
- current packet resumed;
- outcome returned;
- time to first handoff;
- second handoff without prompting;
- `HANDOFF.md was enough` response;
- paid commitment or precommit.

Do not install analytics merely to collect page views. Tracking implementation
remains parked; these names preserve the future measurement contract.

When tracking is activated, use one lowercase UTM vocabulary consistently.
Plausible's current documentation supports standard source, medium, campaign,
content, and term parameters and goal attribution, while noting that source
quality matters beyond visit count. ([Plausible UTM documentation](https://plausible.io/docs/manual-link-tagging),
[traffic and campaign documentation](https://plausible.io/docs/top-referrers))

Recommended future convention:

```text
utm_source=x | github | hackernews | producthunt | reddit | direct_outreach
utm_medium=organic_social | community | repository | referral
utm_campaign=adapter_v1_validation
utm_content=stale_demo | receipt_trace | handoff_autopsy | founder_note
```

## Channel order

### 0. GitHub — product surface and trust base

Before active distribution:

- make README first-screen copy match the narrow category;
- add a 30-second runnable or inspectable proof;
- add a social preview image sized for link sharing;
- add a structured “Design partner handoff” issue form;
- publish releases with honest shipped/experimental boundaries;
- keep the live demo and adapter install path one click away.

GitHub supports custom social preview images, structured issue forms, releases,
and repository discussions as native project/community surfaces.
([GitHub social previews](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview),
[issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates),
[releases](https://docs.github.com/en/repositories/releasing-projects-on-github),
[discussions](https://docs.github.com/en/discussions/collaborating-with-your-community-using-discussions/about-discussions))

### 1. Founder-led X and direct conversations

Use `@patternstatic` as a technical founder/builder voice. Do not post generic
announcements repeatedly. The working loop is:

1. show one specific handoff failure;
2. explain the invariant it violates;
3. link the runnable proof or receipt;
4. ask one concrete question;
5. invite one real handoff, not a follow.

Replies to builders already discussing Codex, Claude Code, Cursor, agent memory,
or context loss are higher-signal than cold broadcast. No automated posting or
reply campaign is authorized by this note.

### 2. Hacker News and focused developer communities

Use only after the adapter is runnable without account creation. The submission
should lead to the repository or runnable demo, explain why the project exists,
name limitations, and keep Lam available for technical questions. Do not ask
friends for votes or manufacture comments.

Focused Reddit or community participation should begin with failure analysis or
a useful tool, disclose project affiliation, and obey each community's current
self-promotion rules. Those rules must be verified immediately before posting.

### 3. Product Hunt

Treat Product Hunt as an amplification event, not the discovery of whether the
product works. Enter only after:

- five real handoffs are complete;
- at least three users repeat;
- onboarding and screenshots are prepared;
- a maker first comment tells the honest build story;
- launch success is defined by qualified users, completed handoffs, and replies,
  not rank alone.

### 4. Search and durable technical content

Write from actual product evidence, one page per real question:

- `ChatGPT to Codex handoff: a reproducible workflow`;
- `Why HANDOFF.md becomes stale—and when it is enough`;
- `Agent memory vs work continuity`;
- `How revision CAS prevents stale agent resumes`;
- `A handoff receipt schema for AI coding agents`.

Each page should include a working example, source, test, or downloadable
fixture. Avoid high-volume AI-generated SEO pages.

### 5. Short-form video and TikTok

Park for now. When revisited, the useful format is not a talking-head feature
tour. It is a 20–35 second visual failure/recovery story:

```text
wrong agent resumes stale branch
→ visible rejection
→ verified packet selected
→ exact next action restored
```

Trajecta's technical ICP is more likely to convert through GitHub/X/HN first.
TikTok can later test reach or a softer product lane without being treated as
evidence for developer willingness to pay.

## Content engine: one build delta, many truthful artifacts

Every material product delta can produce:

1. **Proof clip** — 20–45 seconds of failure → verification → outcome.
2. **Receipt card** — branch, expected/current revision, provenance, result.
3. **Builder note** — why the invariant exists and what failed before it.
4. **Runnable fixture** — sanitized packet plus expected output.
5. **Objection page** — “Why not native memory/HANDOFF.md?”
6. **Design-partner prompt** — one real handoff worth testing.

This is not content repurposing for volume. Each artifact serves a different
step of the same learning loop.

## Message pillars

### Pillar A — Wrong-work failures

- stale branch;
- completed decision missing from the next agent;
- correct task, wrong revision;
- plausible summary, wrong next action;
- transport accepted but target never resumed.

### Pillar B — Inspectable proof

- bounded packet;
- exact target;
- revision CAS;
- provenance;
- receipt levels;
- outcome evidence.

### Pillar C — Honest boundaries

- what native memory already solves well;
- when a plain `HANDOFF.md` is sufficient;
- what Trajecta does not store;
- what the alpha does not automate;
- why fewer claims create more trust.

## First five design-partner conversations

Do not pitch the architecture first. Ask:

1. “Show me the last time you moved work between two AI tools.”
2. “What did you manually copy?”
3. “How did the receiving agent know the branch was current?”
4. “What went wrong or had to be re-explained?”
5. “Would a checked handoff have saved enough time to install something?”
6. “Would a maintained `HANDOFF.md` solve this just as well?”

Then run one real handoff. Record behavior, not compliments.

## Marketing gates

### Gate 1 — Proof ready

- runnable adapter;
- stale/current fixture;
- inspectable receipt;
- setup under five minutes;
- no signup required for local test.

### Gate 2 — Problem observed

- five qualified users complete a handoff;
- at least three identify a real prior failure;
- at least two say the verified mechanism matters beyond a static note.

### Gate 3 — Repeat and payment

- three repeat within seven days without prompting;
- two paid commitments or precommits;
- acquisition source and handoff completion are attributable.

Only then prepare a concentrated launch calendar, tracking deployment, UGC
batch, or time-limited marketing trial.

## What not to do

- Do not buy a domain to manufacture legitimacy.
- Do not run paid ads before a repeated-use signal.
- Do not claim “never lose context” or “memory for every AI.”
- Do not optimize for followers, impressions, stars, or upvotes as the primary
  outcome.
- Do not launch on every community in the same week.
- Do not mass-produce generic AI-memory content.
- Do not hide manual file transport or alpha limitations.
- Do not use a companion audience as proof of technical buyer demand.

## Ordered backlog

1. Ship Adapter v1 Slice 1–4 and preserve sanitized proof receipts.
2. Tighten README around one runnable handoff.
3. Add GitHub social preview and design-partner issue form.
4. Build the free Handoff Autopsy artifact.
5. Conduct five founder-led design-partner handoffs.
6. Write the first two evidence-backed technical pages.
7. Produce one proof clip and one receipt card from a real fixture.
8. Decide whether HN is ready; keep Product Hunt later.
9. Prepare tracking, UGC, and launch calendar only after Gate 2.
10. Activate any time-limited marketing tool only when the complete campaign is
    ready to run inside its trial window.

## Claim-to-source ledger

| Claim family | Source | Publisher | Accessed | Confidence |
|---|---|---|---|---|
| Show HN requires a tryable artifact and discourages barriers/vote requests | [Show HN Guidelines](https://news.ycombinator.com/showhn.html) | Y Combinator / Hacker News | 2026-09-04 | High |
| Product Hunt favors live, useful products and authentic measurable launches | [Launch guide](https://www.producthunt.com/launch), [preparation](https://www.producthunt.com/launch/before-launch), [featuring](https://help.producthunt.com/en/articles/9883485-product-hunt-featuring-guidelines) | Product Hunt | 2026-09-04 | High |
| Useful technical content and product quality outperform generic developer marketing | [40 lessons](https://newsletter.posthog.com/p/40-things-weve-learned-about-marketing) | PostHog | 2026-09-04 | Medium-high; first-party experience |
| Free tools, guides, OSS, benchmarks, and programs are competitor acquisition loops | [MemoryPlugin](https://www.memoryplugin.com/), [Supermemory repo](https://github.com/supermemoryai/supermemory), [pricing](https://supermemory.ai/pricing/), [ModelCaddy](https://modelcaddy.com/about) | Respective vendors | 2026-09-04 | High for observed offers; not independent performance proof |
| GitHub offers native trust/community packaging surfaces | [GitHub Docs](https://docs.github.com/en/repositories/releasing-projects-on-github) | GitHub | 2026-09-04 | High |
| People-first, original, first-hand content is the safer search strategy | [Helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) | Google Search Central | 2026-09-04 | High for stated platform guidance |
| Standard UTMs and goals support aggregate campaign attribution | [UTM docs](https://plausible.io/docs/manual-link-tagging), [campaign docs](https://plausible.io/docs/top-referrers) | Plausible | 2026-09-04 | High for product behavior |

## Limitations and stop condition

This pass studied public first-party guidance and visible competitor mechanisms;
it did not verify competitor conversion rates, acquisition costs, retention, or
private campaign performance. Public offers reveal tactics, not causation.

Research stopped because the immediate decision is now sufficiently supported:
finish a tryable adapter, use the verified handoff as the marketing object, and
run founder-led design-partner conversations before broad launch machinery.
Another broad source sweep is unlikely to change that ordering; the next useful
evidence must come from Trajecta users.
