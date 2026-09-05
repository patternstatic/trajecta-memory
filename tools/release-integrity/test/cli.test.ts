import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseCli } from "../src/cli.ts";

const required = ["--private-key", "/outside/private.pem", "--public-key", "/outside/public.pem", "--git-bin", "/usr/bin/git", "--npm-cli", "/outside/npm-cli.js", "--build-commit", "a".repeat(40), "--release-instant", "2026-09-05T00:00:00Z", "--verification-instant", "2026-09-05T00:00:00Z", "--output-dir", "/outside/out"];

test("build CLI accepts one complete explicit frozen input set", () => {
  // Would fail if seller builds could fill security or reproducibility inputs from ambient state.
  assert.deepEqual(parseReleaseCli(["build", ...required]), {
    command: "build", privateKey: "/outside/private.pem", publicKey: "/outside/public.pem", gitBin: "/usr/bin/git", npmCli: "/outside/npm-cli.js", buildCommit: "a".repeat(40), releaseInstant: "2026-09-05T00:00:00Z", verificationInstant: "2026-09-05T00:00:00Z", outputDir: "/outside/out",
  });
});

test("CLI rejects unknown, duplicate, empty, and missing frozen flags", () => {
  // Would fail if an ambiguous command selected an unreviewed default or silently ignored operator input.
  for (const argv of [["build", ...required, "--unknown", "x"], ["build", ...required, "--git-bin", "/again"], ["build", ...required.slice(0, -2)], ["build", ...required.map(value => value === "/outside/out" ? "" : value)]]) assert.throws(() => parseReleaseCli(argv));
});
