import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { describeDemo, initialDemoState, reduceDemo } from "../demo.js";

test("stale revision is rejected before any resume", () => {
  const state = reduceDemo(initialDemoState, "TRY_STALE");
  assert.equal(state, "rejected");
  assert.equal(describeDemo(state).verification, "rejected · revision mismatch");
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

test("replay returns every state to ready", () => assert.equal(reduceDemo("resumed", "REPLAY"), "ready"));

test("every demo view exposes the handoff receipt contract", () => {
  for (const state of ["ready", "rejected", "verified", "resumed"]) {
    const view = describeDemo(state);
    for (const field of ["branch", "provenance", "evidence", "openLoops", "nextAction", "verification", "selectedPacket", "tone"]) assert.ok(view[field], `${state} missing ${field}`);
  }
  assert.equal(describeDemo("ready").selectedPacket, "stale");
  assert.equal(describeDemo("verified").selectedPacket, "current");
  assert.equal(describeDemo("resumed").currentRevision, "15");
});

test("site exposes an honest sample workspace and working local guide", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Sample data · runs in your browser/);
  assert.match(html, /Illustrative workflow · no agent connected/);
  assert.match(html, /href="guide.html"/);
  assert.match(html, /Checkout is not open yet/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /github.com\/patternstatic/);
});
test("site supports focus visibility, reduced motion and responsive layouts", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media[^}]*max-width/s);
});
test("both site pages link only to existing local files or valid page anchors", () => {
  for (const page of ["index.html","guide.html"]) {
    const html=fs.readFileSync(new URL("../"+page,import.meta.url),"utf8");
    const refs=[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match=>match[1]);
    for(const ref of refs){
      if(/^[a-z]+:/i.test(ref)||ref.startsWith("//"))continue;
      const [file,anchor]=ref.split("#");
      const destination=new URL("../"+(file||page),import.meta.url);
      assert.ok(fs.existsSync(destination),"missing local reference: "+ref);
      if(anchor)assert.ok(fs.readFileSync(destination,"utf8").includes('id="'+anchor+'"'),"missing anchor: "+ref);
    }
  }
});
