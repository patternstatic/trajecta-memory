# Trajecta Verified-Handoff Landing Page Specification

**Status:** Approved direction, implementation pending visual draft review
**Research:** [`COMPETITIVE_DISTILLATION_2026-09-03.md`](../../COMPETITIVE_DISTILLATION_2026-09-03.md)

## Goal

Build a fast, static product page that lets an AI-native solo builder understand
and interact with Trajecta's verified-handoff wedge in under 90 seconds.

## Audience and conversion

The primary audience plans work in ChatGPT or Claude and implements it in Codex,
Claude Code, Cursor, or another local coding agent.

- Primary CTA: **Run the 90-second handoff demo**.
- Secondary CTA: **Inspect the source** on GitHub.
- Final CTA: invite a qualified user to test one real handoff as a design partner.
- No checkout, paid plan, domain purchase, account creation, or adapter claim.

## Product truth

The page may claim that the alpha kernel currently implements work lifecycle,
cue routing, append-only deltas, branches, immutable contract anchors, bounded
transfer packets, revision-CAS resume, and a tested cloud/local round trip.

The page must label product adapters as being in validation. It must not imply
that clicking the browser demo connects live ChatGPT, Claude, Codex, or Cursor.
The demo is an explanatory simulation derived from behavior covered by the
repository test suite.

## Page narrative

1. Hero: “Switch agents. Keep the exact work.”
2. Immediate interactive trajectory showing Cloud Plan → Transfer → Local Build.
3. A stale packet attempts revision 12 while the current work is revision 14.
4. Trajecta rejects the stale resume and explains the mismatch.
5. The visitor selects the verified packet, restoring the current branch,
   evidence, open loops, and exact next action.
6. An inspectable receipt shows the accepted revision and verification state.
7. A concise comparison explains native memory, `HANDOFF.md`, broad memory
   products, and Trajecta's narrower role.
8. Shipped-now versus validating-next prevents roadmap claims from reading as
   current features.
9. The page closes with design-partner and GitHub actions.

## Interaction contract

The demo has four deterministic states:

- `ready`: both candidate packets are visible; the stale packet is selected.
- `rejected`: revision 12 is rejected because current revision is 14.
- `verified`: the current packet for branch `launch-proof` is selected.
- `resumed`: local build resumes at revision 15 and shows the next action.

Controls:

- `Try stale handoff` moves `ready` or `resumed` to `rejected`.
- `Use verified packet` moves `rejected` or `ready` to `verified`.
- `Resume local agent` moves `verified` to `resumed`.
- `Replay demo` returns any state to `ready`.

State changes must update status text, trajectory color, packet selection,
receipt fields, button availability, and an `aria-live` announcement.

## Visual system

- Background: deep ink `#0B1020` with warm paper `#F4EFE6` content surfaces.
- Accepted/current state: teal `#4FD1C5`.
- Stale/error branch: coral `#FF6B5E`.
- Contract/anchor: muted gold `#D6A85F`.
- Secondary text: slate `#91A0B9`.
- Typography: system sans for narrative; system monospace only for cues,
  revisions, event IDs, commands, and receipts.
- Use Trajecta's existing mark and trajectory line. No brain, galaxy, neuron,
  cloud, glassmorphism, purple-gradient, or fake-terminal imagery.
- Layout is typography-first and high contrast, but calmer and less brutalist
  than the selected style reference.
- Motion explains state change; respect `prefers-reduced-motion`.

## Responsive and accessibility requirements

- Desktop: split hero with narrative at left and live demo at right.
- Mobile: a vertical event timeline with all branch/revision meaning preserved.
- Fully usable at 320 CSS pixels without horizontal scrolling.
- Keyboard-accessible controls and visible focus states.
- Semantic landmarks, one `h1`, ordered heading levels, descriptive link text,
  and WCAG AA color contrast.
- No JavaScript dependency for reading the value proposition; JavaScript only
  enhances the demo.

## Technical shape

- Static files at repository root: `index.html`, `styles.css`, and `demo.js`.
- `demo.js` exports a pure reducer and state descriptions so behavior can be
  tested with Node's existing test runner.
- No runtime dependencies, framework, build step, analytics, cookies, forms,
  external fonts, or third-party JavaScript.
- Existing `npm test`, `npm run demo`, and package behavior must remain intact.

## Acceptance criteria

- A visitor can complete the stale → verified → resumed path.
- The stale attempt never displays an accepted state.
- Each state exposes branch, expected revision, current revision, provenance,
  next action, and verification status where relevant.
- All claims distinguish shipped alpha behavior from validation work.
- The page works without network access after checkout.
- `npm run check` passes.
- The new site behavior tests pass.
- HTML has no dead local links or missing referenced assets.
