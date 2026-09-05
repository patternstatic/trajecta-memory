import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNewOutputDirectory,
  assertSafeArchivePath,
  parseEvaluationReceipt,
  parseCommitDigest,
  parseManifest,
  parseReleaseInstant,
  parseVerificationInstant,
  parseReleasePins,
  resolveReleaseKind,
  parseSha256,
} from "../src/contracts.ts";
import { canonicalJsonLf, sha256Hex } from "../src/canonical.ts";

const receipt = {
  schema: "trajecta.release-integrity-evaluation/v1",
  product: "Trajecta Verified Resume SDK Beta",
  version: "0.1.0",
  buildCommit: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  supportedEnvironment: {
    platform: "macOS",
    architecture: "Apple Silicon",
    node: ">=22.19 <23",
    workspace: "one local workspace and one active Trajecta writer",
    transport: "user-controlled JSON file",
    outputLanguage: "English",
  },
  releaseInstant: "2026-09-05T00:00:00Z",
  verificationInstant: "2026-09-05T00:00:01Z",
  testScopeIds: [
    "release-contracts-v1",
    "release-source-preflight-v1",
    "release-stage-layout-v1",
    "release-tgz-audit-v1",
    "release-offline-npm-v1",
    "release-archive-audit-v1",
    "release-reproducibility-v1",
  ],
  highestProvenReceiptLevel: "production-local-sdk",
  limitations: ["Customer-0-not-run", "not-for-sale", "no-commercial-activation"],
  supportDefinition: "30 calendar days of bug-fix builds from purchase and one email thread for installation clarification",
  keyId: "ed25519:fixture",
  publicKeyFingerprint: "c".repeat(64),
};

test("release kind defaults only to evaluation and rejects unknown profiles", () => {
  assert.equal(resolveReleaseKind(undefined), "evaluation");
  assert.equal(resolveReleaseKind("evaluation"), "evaluation");
  assert.equal(resolveReleaseKind("commercial-candidate"), "commercial-candidate");
  assert.throws(() => resolveReleaseKind("commercial" as never), { code: "INVALID_RELEASE_KIND" });
});

test("canonical bytes are sorted UTF-8 JSON with one LF and stable SHA-256", () => {
  // Would fail if a later receipt or manifest depends on object insertion order or platform line endings.
  const bytes = canonicalJsonLf({ z: "é", a: [true, null] });
  assert.equal(bytes.toString("utf8"), "{\"a\":[true,null],\"z\":\"é\"}\n");
  assert.equal(sha256Hex(bytes), "a8ba5ecd384a0bb6bb9d2df480abae6c2cf437e5bfb75eeba9133fe92f3d4f2d");
});

test("contracts admit only safe archive paths and lowercase SHA-256 commit digests", () => {
  // Would fail if an archive could contain traversal, escaping, case-ambiguous, or malformed digest evidence.
  assert.equal(assertSafeArchivePath("packages/trajecta-beta-0.1.0.tgz"), "packages/trajecta-beta-0.1.0.tgz");
  assert.equal(parseCommitDigest("a".repeat(40)), "a".repeat(40));
  for (const unsafe of ["", "/absolute", "a//b", "a/../b", "a/./b", "a\\b", "a/", "a\n", "a space"]) {
    assert.throws(() => assertSafeArchivePath(unsafe), undefined, unsafe);
  }
  for (const bad of ["A".repeat(40), "a".repeat(39), "g".repeat(40)]) {
    assert.throws(() => parseCommitDigest(bad), undefined, bad);
  }
});

test("release instant is strict UTC RFC 3339 in ZIP DOS range with zero milliseconds and even seconds", () => {
  // Would fail if byte reproduction could silently pick an invalid or lossy ZIP timestamp.
  assert.equal(parseReleaseInstant("2026-09-05T00:00:00Z").toISOString(), "2026-09-05T00:00:00.000Z");
  for (const bad of [
    "1979-12-31T23:59:58Z", "2108-01-01T00:00:00Z", "2026-09-05T00:00:01Z",
    "2026-09-05T00:00:00.001Z", "2026-09-05T00:00:00+00:00", "2026-09-05T00:00:00.000Z",
  ]) assert.throws(() => parseReleaseInstant(bad), undefined, bad);
});

test("verification instant is separately frozen UTC receipt data", () => {
  // Would fail if a receipt could silently obtain wall-clock data or blur ZIP time with verification time.
  assert.equal(parseVerificationInstant("2026-09-05T00:00:01Z").toISOString(), "2026-09-05T00:00:01.000Z");
  for (const bad of ["2026-09-05T00:00:01.001Z", "2026-09-05T00:00:01+00:00", "not-an-instant"]) {
    assert.throws(() => parseVerificationInstant(bad), undefined, bad);
  }
});

test("manifest is lexically unique, keeps one package-only mixed container, and receipt has only fixed evaluation claims", () => {
  // Would fail if mixed license evidence escaped the package container or a receipt claimed unproven outcomes.
  const packageLedger = [{ path: "beta/src/cli.ts", bytes: 1, sha256: "b".repeat(64), mode: "0644", originalClass: "commercial-beta" }];
  assert.doesNotThrow(() => parseManifest({
    schema: "trajecta.release-manifest/v1",
    members: [
      { path: "LICENSE", bytes: 1, sha256: "a".repeat(64), originalClass: "notice" },
      { path: "packages/trajecta-beta-0.1.0.tgz", bytes: 2, sha256: "c".repeat(64), originalClass: "mixed-container", memberLedger: packageLedger },
    ],
  }));
  assert.throws(() => parseManifest({ schema: "trajecta.release-manifest/v1", members: [{ path: "LICENSE", bytes: 1, sha256: "a".repeat(64), originalClass: "mixed-container", memberLedger: packageLedger }] }));
  assert.throws(() => parseManifest({ schema: "trajecta.release-manifest/v1", members: [{ path: "packages/trajecta-beta-0.1.0.tgz", bytes: 2, sha256: "c".repeat(64), originalClass: "mixed-container", memberLedger: [{ ...packageLedger[0], originalClass: "mixed-container" }] }] }));
  assert.throws(() => parseManifest({ schema: "trajecta.release-manifest/v1", members: [
    { path: "packages/trajecta-beta-0.1.0.tgz", bytes: 2, sha256: "c".repeat(64), originalClass: "mixed-container", memberLedger: packageLedger },
    { path: "LICENSE", bytes: 1, sha256: "a".repeat(64), originalClass: "notice" },
  ] }));
  assert.throws(() => parseManifest({ schema: "trajecta.release-manifest/v1", members: [
    { path: "LICENSE", bytes: 1, sha256: "a".repeat(64), originalClass: "notice" },
    { path: "LICENSE", bytes: 1, sha256: "a".repeat(64), originalClass: "notice" },
    { path: "packages/trajecta-beta-0.1.0.tgz", bytes: 2, sha256: "c".repeat(64), originalClass: "mixed-container", memberLedger: packageLedger },
  ] }));
  assert.throws(() => parseManifest({ schema: "trajecta.release-manifest/v1", members: [
    { path: "MANIFEST.json", bytes: 1, sha256: "a".repeat(64), originalClass: "notice" },
    { path: "packages/trajecta-beta-0.1.0.tgz", bytes: 2, sha256: "c".repeat(64), originalClass: "mixed-container", memberLedger: packageLedger },
  ] }));
  assert.throws(() => parseManifest({ schema: "trajecta.release-manifest/v1", members: [
    { path: "LICENSE", bytes: 1, sha256: "a".repeat(64), originalClass: "notice" },
    { path: "packages/trajecta-beta-0.1.0.tgz", bytes: 2, sha256: "c".repeat(64), originalClass: "mixed-container", memberLedger: [{ path: "z.ts", bytes: 1, sha256: "b".repeat(64), mode: "0644", originalClass: "commercial-beta" }, { path: "a.ts", bytes: 1, sha256: "b".repeat(64), mode: "0644", originalClass: "commercial-beta" }] },
  ] }));
  assert.doesNotThrow(() => parseEvaluationReceipt(receipt));
  assert.throws(() => parseEvaluationReceipt({ ...receipt, status: "passed" }));
  assert.throws(() => parseEvaluationReceipt({ ...receipt, testScopeIds: receipt.testScopeIds.slice(0, -1) }));
  assert.throws(() => parseEvaluationReceipt({ ...receipt, highestProvenReceiptLevel: "release-integrity" }));
  assert.throws(() => parseEvaluationReceipt({ ...receipt, limitations: [...receipt.limitations, "installed"] }));
  assert.throws(() => parseEvaluationReceipt({ ...receipt, supportedEnvironment: { ...receipt.supportedEnvironment, platform: "Linux" } }));
  assert.throws(() => parseEvaluationReceipt({ ...receipt, supportDefinition: "support forever" }));
  assert.doesNotThrow(() => parseReleasePins({ schema: "trajecta.release-pins/v1", archiveSha256: "d".repeat(64), keyFingerprint: "e".repeat(64), archiveAudit: "passed", reproducibility: "passed" }));
});

test("output directory must be a new absolute non-source path with no symlink ancestry", () => {
  // Would fail if a build could overwrite an existing directory or write inside the source tree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-contracts-"));
  const sourceRoot = path.join(root, "source");
  const outside = path.join(root, "outside", "release");
  fs.mkdirSync(sourceRoot, { recursive: true });
  try {
    assert.equal(assertNewOutputDirectory(outside, sourceRoot), path.resolve(outside));
    fs.mkdirSync(outside, { recursive: true });
    assert.throws(() => assertNewOutputDirectory(outside, sourceRoot));
    assert.throws(() => assertNewOutputDirectory(path.join(sourceRoot, "out"), sourceRoot));
    assert.throws(() => assertNewOutputDirectory("relative", sourceRoot));
    const linked = path.join(root, "linked");
    fs.symlinkSync(sourceRoot, linked);
    assert.throws(() => assertNewOutputDirectory(path.join(linked, "out"), sourceRoot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private package template has the exact dependency-free staged publication boundary", () => {
  // Would fail if release packaging added install-time authority or omitted a required staged notice/boundary file.
  const template = JSON.parse(fs.readFileSync(new URL("../../../release/trajecta-beta.package.json", import.meta.url), "utf8"));
  assert.equal(template.name, "@patternstatic/trajecta-beta");
  assert.equal(template.version, "0.1.0");
  assert.equal(template.private, true);
  assert.equal(template.type, "module");
  assert.equal(template.engines.node, ">=22.19 <23");
  for (const forbidden of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "scripts"]) assert.equal(Object.hasOwn(template, forbidden), false, forbidden);
  assert.deepEqual(template.files, ["bin/trajecta-beta", "beta/DEVELOPMENT-BOUNDARY.md", "beta/src", "core/src", "LICENSE", "NOTICE", "BETA-COMMERCIAL-TERMS.txt", "LICENSES/CORE-MODIFICATIONS.txt"]);
});

test("payload policy names the frozen construction inputs, staged paths, and exclusions", () => {
  // Would fail if a release input could bypass the commit-tree allowlist or a seller-only file entered staging.
  const policy = JSON.parse(fs.readFileSync(new URL("../../../release/payload-policy.json", import.meta.url), "utf8"));
  assert.equal(policy.schema, "trajecta.release-payload-policy/v1");
  for (const input of ["tools/release-integrity/src/**/*.ts", "release/trajecta-beta.package.json", "release/evaluation/**/*", "release/commercial-candidate/**/*", "src/**/*.ts", "packages/trajecta-beta/src/**/*.ts", "packages/trajecta-beta/bin/trajecta-beta", "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md", "LICENSE", "NOTICE", "release/payload-policy.json", "release/license-map.json"]) assert.ok(policy.sourceRoots.includes(input), input);
  for (const staged of ["package/package.json", "package/bin/trajecta-beta", "package/beta/DEVELOPMENT-BOUNDARY.md", "package/LICENSES/CORE-MODIFICATIONS.txt"]) assert.ok(policy.stagedPaths.includes(staged), staged);
  for (const excluded of ["tools/release-integrity/test/**", "packages/trajecta-beta/test/**", ".git/**"]) assert.ok(policy.exclusionList.includes(excluded), excluded);
});
