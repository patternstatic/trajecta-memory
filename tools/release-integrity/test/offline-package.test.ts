import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packPackage } from "../src/pack-package.ts";
import { stagePackage } from "../src/stage-package.ts";
import { ReleaseIntegrityError } from "../src/errors.ts";
import { runControlledOfflineInstall } from "../src/run.ts";
import type { SourceSnapshot } from "../src/preflight-source.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const instant = "2026-09-05T00:00:00Z";
let sequence = 0;
const npmCli = path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

function directory(label: string): string {
  return path.join(os.tmpdir(), `trajecta-offline-${label}-${process.pid}-${Date.now()}-${sequence++}`);
}

function recursiveTypescriptFiles(root: string, relative: string): string[] {
  const result: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const child = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(child);
    }
  };
  walk(relative);
  return result.sort();
}

function snapshotFrom(root = repository): SourceSnapshot {
  const files = [
    "release/payload-policy.json", "release/trajecta-beta.package.json", "release/license-map.json", "release/evaluation/LICENSES/BETA-COMMERCIAL-TERMS.txt", "LICENSE", "NOTICE",
    "packages/trajecta-beta/DEVELOPMENT-BOUNDARY.md", "packages/trajecta-beta/bin/trajecta-beta",
    ...recursiveTypescriptFiles(root, "packages/trajecta-beta/src"),
    "src/index.ts", "src/relay.ts", "src/store.ts", "src/types.ts",
    ...fs.readdirSync(path.join(root, "src/adapters/proof")).filter(name => name.endsWith(".ts")).map(name => `src/adapters/proof/${name}`),
  ].sort();
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-offline-snapshot-"));
  const entries = files.map(relative => {
    const bytes = fs.readFileSync(path.join(root, relative));
    const destination = path.join(snapshotRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { mode: 0o400 });
    return Object.freeze({ path: relative, bytes: bytes.length, mode: "0644", sha256: createHash("sha256").update(bytes).digest("hex") });
  });
  return Object.freeze({ root: snapshotRoot, buildCommit: "a".repeat(40), entries: Object.freeze(entries) });
}

function packageUnderTest() {
  const staged = stagePackage({ snapshot: snapshotFrom(), stageDirectory: directory("stage") });
  return packPackage({ packageRoot: staged.packageRoot, members: staged.members, releaseInstant: instant });
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ReleaseIntegrityError && error.code === code);
}

test("installs an audited tgz offline in an independent Git customer workspace and runs its bin", () => {
  const packed = packageUnderTest();
  const poisoned = directory("poisoned-config");
  fs.mkdirSync(poisoned, { recursive: true });
  const poisonedConfig = path.join(poisoned, "npmrc");
  fs.writeFileSync(poisonedConfig, "registry=https://poisoned.invalid/\nproxy=http://poisoned.invalid\n_auth=poisoned\nignore-scripts=false\n");
  const result = runControlledOfflineInstall({
    tgz: packed.tgz, memberLedger: packed.memberLedger, releaseInstant: instant, npmCli,
    environment: { ...process.env, NPM_CONFIG_USERCONFIG: poisonedConfig, npm_config_registry: "https://poisoned.invalid/", HTTPS_PROXY: "http://poisoned.invalid", npm_config_ignore_scripts: "false" },
  });
  assert.equal(result.npmVersion, "10.9.8");
  assert.equal(result.customerBranch, "main");
  assert.match(result.version, /Trajecta Verified Resume SDK Beta 0\.1\.0/);
  assert.match(result.doctor, /"code":"OK"/);
  assert.match(result.demo, /STALE     REJECTED REVISION_CONFLICT/);
  assert.match(result.demo, /RETRY     same receipt bytes/);
  assert.equal(result.modificationNoticeSha256, packed.memberLedger.find(member => member.path === "LICENSES/CORE-MODIFICATIONS.txt")!.sha256);
  assert.ok(!result.customerWorkspace.startsWith(repository));
  assert.ok(!fs.existsSync(path.join(result.customerWorkspace, ".npmrc")));
});

test("rejects a pre-install runtime source import capable of network I/O", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-offline-network-package-"));
  const entries: Array<[string, string, "0644" | "0755", "commercial-beta" | "documentation" | "notice"]> = [
    ["package.json", "{\"name\":\"@patternstatic/trajecta-beta\",\"version\":\"0.1.0\",\"private\":true,\"type\":\"module\",\"bin\":{\"trajecta-beta\":\"bin/trajecta-beta\"}}\n", "0644", "commercial-beta"],
    ["bin/trajecta-beta", "#!/usr/bin/env node\n", "0755", "commercial-beta"],
    ["beta/DEVELOPMENT-BOUNDARY.md", "Boundary.\n", "0644", "documentation"],
    ["beta/src/cli.ts", "import 'node:https';\n", "0644", "commercial-beta"],
    ["LICENSES/CORE-MODIFICATIONS.txt", "None.\n", "0644", "notice"],
  ];
  const members = entries.map(([memberPath, content, mode, originalClass]) => {
    const bytes = Buffer.from(content);
    const target = path.join(root, memberPath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { mode: Number.parseInt(mode, 8) }); fs.chmodSync(target, Number.parseInt(mode, 8));
    return { path: memberPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode, originalClass };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const packed = packPackage({ packageRoot: root, members, releaseInstant: instant });
  expectCode(() => runControlledOfflineInstall({ tgz: packed.tgz, memberLedger: packed.memberLedger, releaseInstant: instant, npmCli }), "FORBIDDEN_NETWORK_IMPORT");
});

test("fails closed for non-absolute, symlinked, or wrong-version npm CLI paths", () => {
  const packed = packageUnderTest();
  for (const npmCli of ["npm", path.join(os.tmpdir(), "missing-npm-cli")]) {
    expectCode(() => runControlledOfflineInstall({ tgz: packed.tgz, memberLedger: packed.memberLedger, releaseInstant: instant, npmCli }), "INVALID_NPM_CLI");
  }
  const link = path.join(os.tmpdir(), `trajecta-npm-cli-link-${process.pid}-${sequence++}`);
  fs.symlinkSync(npmCli, link);
  expectCode(() => runControlledOfflineInstall({ tgz: packed.tgz, memberLedger: packed.memberLedger, releaseInstant: instant, npmCli: link }), "INVALID_NPM_CLI");
  const wrong = path.join(os.tmpdir(), `trajecta-npm-cli-wrong-${process.pid}-${sequence++}.js`);
  fs.writeFileSync(wrong, "process.stdout.write('0.0.0\\n');\n", { mode: 0o700 });
  expectCode(() => runControlledOfflineInstall({ tgz: packed.tgz, memberLedger: packed.memberLedger, releaseInstant: instant, npmCli: wrong }), "NPM_VERSION_MISMATCH");
});
