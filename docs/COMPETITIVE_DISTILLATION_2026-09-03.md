# Competitive Distillation: Trajecta Product Page

**Observed:** 2026-09-03
**Scope:** Public product pages, official documentation, and public repositories
**Decision status:** Research input for page design; not an implementation or pricing commitment

## Executive decision

Trajecta should not present itself as another universal AI memory product.
The strongest competitors already own the broad promises: one memory, every AI,
search everything, import all chats, and never start from scratch.

The product page should instead make one narrower failure visible and testable:

> A handoff can look complete and still resume the wrong work. Trajecta carries
> the exact branch, evidence, open loops, next action, and revision needed to
> continue safely.

The page should lead with a **broken handoff versus verified resume demo**, not
an architecture diagram or a feature grid. The conversion goal for the current
validation phase is a qualified demo/use, not a premature paid checkout.

## Evidence labels

- **FACT:** Directly observed on a current official page, official document, or
  public repository on the date above.
- **INFERENCE:** A product or design conclusion drawn from those observations.
- **HYPOTHESIS:** A claim Trajecta still needs to test with users.
- **UNKNOWN:** Evidence was unavailable or insufficient.

## Selected competitive set

### Tier A: Product and page benchmarks

| Product | Why it is formidable | Current public offer | What its page does well | Trajecta response |
|---|---|---|---|---|
| [ModelCaddy](https://modelcaddy.com/) | Closest overlap: local-first, source-backed, cross-model context packs for ChatGPT, Claude, Cursor, Codex, and others. | Free local vault plus Pro at EUR 24.95 early access, advertised as a one-time purchase with 12 months of updates. | Calm, humane presentation; outcome-led copy; interactive without/with product demo; source-backed trust; low-friction download; founder program. | **OUTBUILD** the handoff demo with stale-state rejection and exact branch recovery. Do not compete on general vault/search breadth yet. |
| [Supermemory](https://supermemory.ai/) | Strong developer credibility and distribution: its page displays 29.2K GitHub stars, 10,000+ personal users, SDKs, connectors, benchmarks, enterprise deployment, and compliance. | Free, USD 19/month Pro, USD 100/month Max, and USD 399/month Scale tiers. | Immediate technical category claim; copyable install command; customer logos; quantified latency and scale; benchmarks; security and deployment proof. | **ADAPT** proof density and developer immediacy. **REJECT** the broad “context cloud” category and enterprise scope for the validation page. |
| [MemoryPlugin](https://www.memoryplugin.com/) | Strong cross-tool consumer offer and conversion stack across 21+ tools. The page reports 5,803 users, customers in 69 countries, and 100+ reviews. | Core at USD 89/year and Pro at USD 180/year on the annual view, with a seven-day trial and 14-day refund. | Memorable problem headline; product footage in the hero; one dominant CTA; visible adoption and rating proof; comparison against built-in memory; free tools and migration guides as acquisition loops. | **ADAPT** the single pain-led headline, product-in-motion hero, and objection handling. **REJECT** “never start from scratch” and total-memory language. |
| [Context Pack](https://www.context-pack.com/) | Simple portable-context story with visible activity counters: 5.5K+ packs and 55K memories stored. | Free entry with no credit card advertised; detailed paid pricing was not verified in this pass. | Extremely scannable hero; three benefit checks; two clear CTAs; simple Import → Organize → Use Anywhere flow; product compatibility and security are visible early. | **ADAPT** its scanning speed and three-step comprehension. **OUTBUILD** its generic diagram with a truthful interactive handoff failure. |

### Tier B: Mechanism threats and cheap substitutes

| Product or substitute | Relevant observed behavior | Threat to Trajecta | Design consequence |
|---|---|---|---|
| [HandoffKit](https://github.com/kingkyylian/handoffkit) | Builds a deterministic, local-first Markdown/JSON resume packet from Git state, changed files, instructions, checks, and risk notes. | A simple CLI can solve much of the visible “make a handoff packet” job without a service. | The page must demonstrate why revision, branch, provenance, and stale-resume behavior matter beyond packet generation. |
| [BatonCode](https://github.com/renandlsantos/batoncode) | Proposes a local control plane for switching coding-agent CLIs with reviewable handoff bundles and runtime adapters. | Very close product thesis; broader runtime-control ambition could absorb the handoff story. | Keep Trajecta transport-neutral and focused. Show the kernel contract clearly without pretending adapters already ship. |
| [Agent Handoff](https://github.com/AniruddhaHumane/handoff) | Uses two small skills and plain files to save and merge continuation snapshots across Codex and Claude. | Reinforces the “structured files may be enough” validation risk. | Include a direct “Why not HANDOFF.md?” section and make the answer falsifiable. |
| [ChatGPT Projects](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt) | Keeps chats, files, instructions, and memory together inside a ChatGPT project. | Built-in project continuity is available to free and paid users, reducing demand for generic memory. | Position Trajecta at the seam **between** surfaces, not as better memory inside one surface. |
| [Claude Code sessions](https://code.claude.com/docs/en/sessions) | Supports resume, named sessions, branching, transcript export, and structured programmatic access. | Native resume is better than any external tool when the user stays in Claude Code. | Show a cloud-planning → different local-agent handoff. Do not imply native session resume is broken. |

## Distillation by competitor

### 1. ModelCaddy — closest product benchmark

**FACT**

- The hero sells a private local memory, then supports it with “real files,”
  “on-device AI,” “source-backed,” and “no ModelCaddy cloud.”
- A page-level interaction switches between a cold-start prompt and a context
  pack loaded state before revealing the continued response.
- The product story uses four verbs: Capture, Understand, Recall, Continue.
- Pricing, refund language, FAQs, and a limited founder edition all reduce risk
  and create multiple conversion paths.

**KEEP**

- Humane visual restraint and plain-language explanations.
- Trust claims attached to concrete architecture.
- A playable “without / with” comparison instead of a static feature claim.
- A founder/design-partner path appropriate to early product maturity.

**REJECT**

- General-purpose vault, universal search, and “one memory for all AI work” as
  Trajecta's leading category.
- A long page that repeats portability before proving the unique failure mode.

**OUTBUILD**

- The demo should not merely preload a better prompt. It should expose the
  stale revision, name the wrong branch, show why acceptance fails, and then
  resume from the verified packet.
- Every visible state should carry a clickable or inspectable provenance label.

### 2. Supermemory — authority and developer-experience benchmark

**FACT**

- The hero combines a large category claim, two CTAs, and a copyable setup
  command.
- The page layers product catalog, SDKs, benchmarks, customer logos, deployment
  options, compliance, testimonials, pricing, and a detailed billing FAQ.
- It serves both developer infrastructure and a personal-memory app from one
  brand.

**KEEP**

- A real command near the first viewport.
- Quantified and verifiable proof instead of decorative claims.
- Strong hierarchy and progressive depth for technical evaluators.

**REJECT**

- Enterprise breadth, benchmark theater, blue-cloud visual language, and a
  nine-catalog product story before Trajecta has adapter evidence.

**OUTBUILD**

- Make the product legible in one concrete scenario faster than Supermemory's
  broad catalog can be understood.
- Prefer a small inspectable event trail over aggregate performance claims.

### 3. MemoryPlugin — conversion benchmark

**FACT**

- The hero states a familiar pain in large emotional language, shows product
  footage, offers one dominant free-trial CTA, and immediately displays user,
  geography, recent-plan, and review proof.
- The funnel is reinforced by migration guides, free conversion tools,
  platform pages, comparisons, refund language, and repeated trial CTAs.
- Its promise is broad continuity of memory and chat history across 21+ tools.

**KEEP**

- One dominant job-to-be-done in the hero.
- Product motion beside the promise.
- Proof and objection handling before a long feature tour.
- Acquisition content that solves a small adjacent job for free.

**REJECT**

- Universal or absolute promises such as “never” and “every.”
- Subscription pressure before the activation path is proven.

**OUTBUILD**

- Replace vanity adoption counters with an auditable demo receipt: selected
  task, expected revision, rejected stale attempt, accepted continuation, and
  final verification state.

### 4. Context Pack — simplicity benchmark

**FACT**

- The first viewport explains portability through a headline, three checked
  benefits, two CTAs, product logos, and activity counters.
- The main flow is reduced to Import → Organize → Use Anywhere.
- It emphasizes exportability, plain-text output, and security controls.

**KEEP**

- Five-second comprehension and a short three-stage flow.
- Free/no-card friction reduction.
- Compatibility and trust surfaced before deep detail.

**REJECT**

- Generic black/purple AI aesthetics and floating integration tiles.
- “Thousands of chats” as the value unit; Trajecta intentionally preserves
  material work state rather than bulk conversation history.

**OUTBUILD**

- A directional trajectory visual where branch and revision change as the user
  interacts, rather than an integration constellation.

## Market pattern and open wedge

### Facts

- Broad cross-AI memory and portable context are already crowded promises.
- Local ownership, source links, plain-text export, MCP support, and multi-tool
  compatibility are no longer sufficient differentiation on their own.
- Native platforms cover continuity well inside their own projects or sessions.
- Several free, local, file-backed tools already produce handoff summaries.

### Inference

The defensible message is not “Trajecta remembers more.” It is:

> Trajecta knows which work is current, what changed, and whether the next
> surface is allowed to resume from that state.

The strongest white space is **visible verification at the boundary**:

1. select one exact work item by stable cue;
2. expose its current branch and revision;
3. reject or flag a stale continuation;
4. load only the bounded material state;
5. return a verified outcome and next action.

### Hypothesis

A qualified builder will understand and value Trajecta faster after interacting
with one stale-handoff demo than after reading a list of memory features.

### Unknowns to preserve

- Whether the pain occurs often enough to justify installation.
- Whether a well-maintained `HANDOFF.md` is sufficient for most buyers.
- Whether buyers value the kernel, adapters, onboarding, or support.
- Whether the current alpha can produce the full page demo without pretending
  product adapters are already available.

## Proposed page job

The page has one job: move a qualified AI-native builder from “I already write
handoff notes” to “I want to test whether verified resume prevents a failure I
actually have.”

### Recommended first viewport

- **Eyebrow:** `VERIFIED WORK HANDOFFS FOR AI AGENTS`
- **Headline direction:** `Switch agents. Keep the exact work.`
- **Support:** Plan in ChatGPT or Claude. Build in Codex, Claude Code, or Cursor.
  Trajecta carries the current branch, evidence, open loops, and next action—and
  refuses stale resumes instead of guessing.
- **Primary CTA:** `Run the 90-second handoff demo`
- **Secondary CTA:** `Inspect the source`
- **Truth label:** `Alpha kernel · local-first · adapters in validation`

These are research hypotheses, not approved final copy.

## Recommended page UX

1. **Hero with live trajectory rail** — the visitor sees Cloud Plan → Transfer
   Packet → Local Build, with the exact revision and branch visible.
2. **Failure first** — a stale packet attempts to resume and receives a concise
   rejection explaining what changed.
3. **Verified recovery** — the correct cue-selected packet restores objective,
   decision, evidence, open loops, and next action.
4. **Inspect the receipt** — expand the small event trail rather than asking the
   user to trust an animation.
5. **Why not memory / HANDOFF.md?** — compare native memory, static notes, broad
   memory layers, and Trajecta without insulting useful substitutes.
6. **How it works** — Open → Checkpoint → Handoff → Accept → Verify.
7. **Current reality** — clearly separate shipped alpha kernel, validation work,
   and future adapters.
8. **Design-partner CTA** — invite a real cross-surface handoff, with GitHub as
   the lower-friction alternative.

## Recommended visual direction

**KEEP from Trajecta**

- Deep ink (`#0B1020`), warm paper (`#F4EFE6`), coral branch, teal accepted
  path, and restrained gold anchor.
- The trajectory line and branch topology as the native brand primitive.
- Monospace only for events, revisions, cues, receipts, and commands.

**ADAPT from the benchmark set**

- ModelCaddy's calm spacing and humane copy rhythm.
- Supermemory's immediate technical action and proof density.
- MemoryPlugin's product-in-motion hero and conversion clarity.
- Context Pack's fast scanning and three-step structure.

**REJECT**

- Brain, cloud, galaxy, neuron, and floating-logo metaphors.
- Generic black-and-purple AI gradients.
- Fake terminal noise, unverified counters, partner-logo wallpaper, and
  enterprise security claims Trajecta cannot yet substantiate.
- Long feature-card grids before the user sees the handoff failure.

**OUTBUILD**

- Turn Trajecta's line into an interactive state machine, not decoration.
- Make error, correction, acceptance, and provenance visually distinct.
- Keep the interface calm while letting technical users inspect every claim.
- On mobile, collapse the rail into a vertical event timeline without losing
  branch, revision, or verification meaning.

## Page success criteria

The design is successful only if a first-time qualified visitor can answer,
without reading the README:

1. What specific failure does Trajecta prevent?
2. How is it different from generic memory or a static handoff note?
3. What exists today versus what is still being validated?
4. What can I do now to test it?
5. Can I inspect the evidence behind the result?

The commercial validation gate in
[`PRODUCT_DIRECTION_CHECKPOINT.md`](PRODUCT_DIRECTION_CHECKPOINT.md) remains in
force. The page must not add paid claims, adapter claims, a domain purchase, or
scope expansion before evidence supports them.

## Source log

- [ModelCaddy official site](https://modelcaddy.com/), including its interactive
  cold-start/hot-start demo and current pricing section.
- [Supermemory official site](https://supermemory.ai/), including product,
  benchmark, deployment, proof, and pricing sections.
- [MemoryPlugin official MCP/product page](https://www.memoryplugin.com/platforms/mcp),
  including current annual pricing, comparison, trial, and FAQ sections.
- [Context Pack official site](https://www.context-pack.com/), including the
  current hero, activity counters, workflow, and security sections.
- [HandoffKit public repository](https://github.com/kingkyylian/handoffkit).
- [BatonCode public repository](https://github.com/renandlsantos/batoncode).
- [Agent Handoff public repository](https://github.com/AniruddhaHumane/handoff).
- [ChatGPT Projects official help](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt).
- [Claude Code session management official documentation](https://code.claude.com/docs/en/sessions).
