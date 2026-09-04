import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResumeAttempt,
  digestResumeAttempt,
  stableSerialize,
} from "../src/index.ts";

test("proof digest is independent of object insertion order", () => {
  const left = { z: 1, nested: { b: true, a: "x" }, list: [2, 1] };
  const right = { list: [2, 1], nested: { a: "x", b: true }, z: 1 };
  assert.equal(stableSerialize(left), stableSerialize(right));
});

test("proof digest changes when a material attempt field changes", () => {
  const base = {
    schema: "trajecta.resume-attempt/v1" as const,
    operationId: "operation:proof-attempt",
    packet: { schema: "trajecta.transfer/v1" },
    target: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    expectedTarget: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    acceptedByUser: true,
  };
  assert.notEqual(digestResumeAttempt(base as never), digestResumeAttempt({ ...base, acceptedByUser: false } as never));
});

test("attempt validation rejects unsupported schemas and unbounded fields", () => {
  assert.throws(() => assertResumeAttempt({ schema: "wrong" } as never), /attempt schema/i);
  assert.throws(() => assertResumeAttempt({
    schema: "trajecta.resume-attempt/v1",
    operationId: `operation:${"x".repeat(300)}`,
    packet: { schema: "trajecta.transfer/v1" },
    target: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    expectedTarget: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    acceptedByUser: true,
  } as never), /operation/i);
});
