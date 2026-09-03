# Trajecta Verified-Handoff Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-free static landing page whose interactive demo proves Trajecta's stale-handoff rejection and verified resume behavior.

**Architecture:** A semantic root `index.html` provides the complete product narrative without JavaScript. `styles.css` implements the Trajecta visual system and responsive trajectory. `demo.js` owns a pure four-state reducer plus a small DOM adapter, allowing the interaction contract to be tested with Node's existing test runner.

**Tech Stack:** HTML5, CSS, browser ES modules, Node 22 built-in test runner

**Spec:** `docs/superpowers/specs/2026-09-03-trajecta-verified-handoff-landing.md`

## Global Constraints

- No runtime dependencies, framework, build step, analytics, cookies, forms, external fonts, or third-party JavaScript.
- Primary CTA text is `Run the 90-second handoff demo`; secondary CTA links to the public GitHub repository.
- Product adapters must be labelled `in validation`; the browser interaction is an explanatory simulation.
- Keep the current Trajecta palette and exact `assets/mark.svg` brand mark.
- Preserve existing package behavior and keep `npm run check` green.

---

### Task 1: Deterministic demo state machine

**Files:**
- Create: `demo.js`
- Create: `test/site.test.ts`

**Interfaces:**
- Produces: `initialDemoState: DemoState`, `reduceDemo(state, event): DemoState`, and `describeDemo(state): DemoView`.
- `DemoState` is one of `ready | rejected | verified | resumed`.
- `DemoView` contains `tone`, `title`, `message`, `expectedRevision`, `currentRevision`, `branch`, `verification`, and `nextAction` strings.

- [ ] **Step 1: Write failing reducer tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { describeDemo, initialDemoState, reduceDemo } from "../demo.js";

test("stale revision is rejected before any resume", () => {
  const state = reduceDemo(initialDemoState, "TRY_STALE");
  assert.equal(state, "rejected");
  assert.equal(describeDemo(state).verification, "rejected");
  assert.equal(describeDemo(state).expectedRevision, "12");
  assert.equal(describeDemo(state).currentRevision, "14");
});

test("verified packet resumes the exact branch", () => {
  const selected = reduceDemo("rejected", "USE_VERIFIED");
  assert.equal(selected, "verified");
  const resumed = reduceDemo(selected, "RESUME");
  assert.equal(resumed, "resumed");
  assert.equal(describeDemo(resumed).branch, "launch-proof");
  assert.equal(describeDemo(resumed).currentRevision, "15");
});

test("replay returns every state to ready", () => {
  assert.equal(reduceDemo("resumed", "REPLAY"), "ready");
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `node --experimental-strip-types --test test/site.test.ts`  
Expected: FAIL because `demo.js` does not exist.

- [ ] **Step 3: Implement the pure state machine**

```js
export const initialDemoState = "ready";

const transitions = {
  ready: { TRY_STALE: "rejected", USE_VERIFIED: "verified", REPLAY: "ready" },
  rejected: { TRY_STALE: "rejected", USE_VERIFIED: "verified", REPLAY: "ready" },
  verified: { RESUME: "resumed", TRY_STALE: "rejected", REPLAY: "ready" },
  resumed: { TRY_STALE: "rejected", USE_VERIFIED: "verified", REPLAY: "ready" },
};

export function reduceDemo(state, event) {
  return transitions[state]?.[event] ?? state;
}
```

Define immutable view data for all four states, using revisions 12, 14, and 15 and branch `launch-proof`; return a cloned view from `describeDemo`.

- [ ] **Step 4: Run the focused tests**

Run: `node --experimental-strip-types --test test/site.test.ts`  
Expected: PASS with three tests.

- [ ] **Step 5: Commit the state machine**

```bash
git add demo.js test/site.test.ts
git commit -m "feat: model the verified handoff demo"
```

### Task 2: Semantic page and truthful product narrative

**Files:**
- Create: `index.html`
- Modify: `test/site.test.ts`

**Interfaces:**
- Consumes: `demo.js` as a browser ES module.
- Produces: stable DOM hooks `[data-demo-root]`, `[data-action]`, `[data-field]`, and `[data-panel]` for the DOM adapter.

- [ ] **Step 1: Add failing static-contract tests**

```ts
import fs from "node:fs";

test("landing page exposes honest conversion and demo hooks", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Run the 90-second handoff demo/);
  assert.match(html, /Adapters in validation/i);
  assert.match(html, /data-demo-root/);
  assert.match(html, /data-action="TRY_STALE"/);
  assert.match(html, /data-action="USE_VERIFIED"/);
  assert.match(html, /data-action="RESUME"/);
  assert.doesNotMatch(html, /connects live (ChatGPT|Claude|Codex|Cursor)/i);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-page failure**

Run: `node --experimental-strip-types --test test/site.test.ts`  
Expected: FAIL because `index.html` does not exist.

- [ ] **Step 3: Build the semantic document**

Create one `h1`, a skip link, header/nav, hero, demo, comparison, how-it-works,
shipped/validation, design-partner, and footer landmarks. Use `assets/mark.svg`
for the logo, link GitHub to `https://github.com/tamvi-journal/trajecta-memory`,
load `styles.css`, and load `demo.js` with `type="module"`.

- [ ] **Step 4: Add the browser DOM adapter**

In `demo.js`, guard DOM access with `if (typeof document !== "undefined")`.
Bind `[data-action]` clicks to `reduceDemo`, render all `[data-field]` values,
toggle `data-state` on `[data-demo-root]`, disable impossible actions, and send
the current message to an `aria-live="polite"` region.

- [ ] **Step 5: Run the focused tests**

Run: `node --experimental-strip-types --test test/site.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit the semantic page**

```bash
git add index.html demo.js test/site.test.ts
git commit -m "feat: add the Trajecta product narrative"
```

### Task 3: Responsive Trajecta visual system

**Files:**
- Create: `styles.css`
- Modify: `test/site.test.ts`

**Interfaces:**
- Consumes: semantic classes and `data-state` values from `index.html` and `demo.js`.
- Produces: desktop split hero, mobile vertical timeline, focus states, state transitions, and reduced-motion behavior.

- [ ] **Step 1: Add failing visual-contract tests**

```ts
test("stylesheet preserves brand, accessibility, and mobile behavior", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const token of ["#0b1020", "#f4efe6", "#4fd1c5", "#ff6b5e", "#d6a85f"])
    assert.match(css.toLowerCase(), new RegExp(token));
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media[^}]*max-width/s);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-stylesheet failure**

Run: `node --experimental-strip-types --test test/site.test.ts`  
Expected: FAIL because `styles.css` does not exist.

- [ ] **Step 3: Implement tokens and layout**

Define CSS custom properties for the five brand colors, spacing, radii, and
shadows. Build a max-width 1200px shell, sticky translucent nav, two-column
hero, warm-paper demo console, and bounded content sections. Use system fonts
and reserve monospace for machine state.

- [ ] **Step 4: Implement state and responsive styling**

Map `data-state="rejected"` to coral and `verified|resumed` to teal. Animate
only opacity, color, and line progress. Below 760px, use one column and convert
the horizontal trajectory to a vertical timeline. Disable nonessential motion
inside `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 5: Run the focused tests**

Run: `node --experimental-strip-types --test test/site.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit the visual system**

```bash
git add styles.css test/site.test.ts
git commit -m "feat: style the verified handoff experience"
```

### Task 4: Full verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `test/site.test.ts`

**Interfaces:**
- Consumes: the completed static site.
- Produces: a documented local preview path and final acceptance evidence.

- [ ] **Step 1: Add link-integrity assertions**

Read every local `href` and `src` from `index.html`, ignore anchors and absolute
URLs, resolve each against the repository root, and assert `fs.existsSync(path)`.

- [ ] **Step 2: Document the preview**

Add a `Product page` paragraph to `README.md` with:

```bash
python3 -m http.server 4173
```

and `http://localhost:4173/`, while retaining the existing quick start.

- [ ] **Step 3: Run all repository verification**

Run: `npm run check`  
Expected: all Node tests pass and the cloud/local relay demo finishes.

- [ ] **Step 4: Run whitespace verification**

Run: `git diff --check`  
Expected: no output.

- [ ] **Step 5: Inspect the desktop and mobile page**

Serve the repository on port 4173. Verify the initial, rejected, verified, and
resumed states at 1440×900 and 390×844. Confirm no horizontal scroll, no missing
mark, visible keyboard focus, truthful alpha labels, and readable receipt data.

- [ ] **Step 6: Commit documentation and verification**

```bash
git add README.md test/site.test.ts
git commit -m "docs: document the Trajecta product page"
```

