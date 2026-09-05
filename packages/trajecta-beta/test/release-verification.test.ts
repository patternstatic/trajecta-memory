import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyDeliveredBundle, type DeliveredBundleInput } from "../src/release/archive-verification.ts";
import { assembleBundle, BUNDLE_ROOT, DOCUMENT_PATHS } from "../../../tools/release-integrity/src/assemble.ts";
import { sha256Hex } from "../../../tools/release-integrity/src/canonical.ts";
import { createDeterministicTgz } from "../../../tools/release-integrity/src/deterministic-tgz.ts";
import { readZip } from "../../../tools/release-integrity/src/deterministic-zip.ts";

const RELEASE_INSTANT = "2026-09-05T00:00:00Z";

interface Fixture {
  root: string;
  input: DeliveredBundleInput;
  archiveSha256: string;
  publicKeyFingerprint: string;
  runtimePath: string;
}

function writeRegular(file: string, bytes: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
}

function treeState(root: string): string[] {
  return fs.readdirSync(root, { recursive: true }).map(String).sort().map((relative) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return `${relative}\0link\0${fs.readlinkSync(absolute)}`;
    if (stat.isDirectory()) return `${relative}\0directory\0${stat.mode & 0o777}`;
    if (stat.isFile()) return `${relative}\0file\0${stat.mode & 0o777}\0${sha256Hex(fs.readFileSync(absolute))}`;
    return `${relative}\0special`;
  });
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-delivered-verifier-"));
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const entries = [
    { path: "BETA-COMMERCIAL-TERMS.txt", bytes: Buffer.from("Evaluation terms\n"), mode: "0644" as const, originalClass: "commercial-beta" as const },
    { path: "LICENSE", bytes: Buffer.from("Core license\n"), mode: "0644" as const, originalClass: "notice" as const },
    { path: "LICENSES/CORE-MODIFICATIONS.txt", bytes: Buffer.from("Runtime modification notice\n"), mode: "0644" as const, originalClass: "notice" as const },
    { path: "NOTICE", bytes: Buffer.from("Core attribution\n"), mode: "0644" as const, originalClass: "notice" as const },
    { path: "beta/DEVELOPMENT-BOUNDARY.md", bytes: Buffer.from("Evaluation boundary\n"), mode: "0644" as const, originalClass: "documentation" as const },
    { path: "beta/src/runtime.js", bytes: Buffer.from("export const runtime = 'verified';\n"), mode: "0644" as const, originalClass: "commercial-beta" as const },
    { path: "bin/trajecta-beta", bytes: Buffer.from("#!/usr/bin/env node\n"), mode: "0755" as const, originalClass: "commercial-beta" as const },
    { path: "package.json", bytes: Buffer.from('{"name":"@patternstatic/trajecta-beta","version":"0.1.0"}\n'), mode: "0644" as const, originalClass: "commercial-beta" as const },
  ];
  const memberLedger = entries.map((entry) => Object.freeze({
    path: entry.path,
    bytes: entry.bytes.length,
    sha256: sha256Hex(entry.bytes),
    mode: entry.mode,
    originalClass: entry.originalClass,
  }));
  const tgz = createDeterministicTgz(entries.map((entry) => ({ ...entry, path: `package/${entry.path}` })), RELEASE_INSTANT);
  const documents = new Map<string, Buffer>(DOCUMENT_PATHS.map((member) => [member, Buffer.from(`Fixture ${member}\n`)]));
  documents.set("LICENSES/CORE-APACHE-2.0.txt", entries[1].bytes);
  documents.set("LICENSES/CORE-NOTICE.txt", Buffer.concat([entries[3].bytes, Buffer.from("\n"), entries[2].bytes]));
  const assembled = assembleBundle({
    tgz,
    memberLedger,
    documents,
    buildCommit: "a".repeat(40),
    releaseInstant: RELEASE_INSTANT,
    verificationInstant: RELEASE_INSTANT,
    publicKeyPem,
    privateKeyPem,
  });

  const archivePath = path.join(root, "download.zip");
  fs.writeFileSync(archivePath, assembled.zip);
  const bundleParent = path.join(root, "unpacked");
  for (const member of readZip(assembled.zip, RELEASE_INSTANT)) {
    assert.ok(member.path.startsWith(`${BUNDLE_ROOT}/`));
    writeRegular(path.join(bundleParent, ...member.path.split("/")), member.bytes, Number.parseInt(member.mode, 8));
  }
  const bundleRoot = path.join(bundleParent, BUNDLE_ROOT);
  const installedPackageRoot = path.join(root, "installed", "node_modules", "@patternstatic", "trajecta-beta");
  for (const entry of entries) writeRegular(path.join(installedPackageRoot, ...entry.path.split("/")), entry.bytes, Number.parseInt(entry.mode, 8));
  const publicKeyPath = path.join(root, "independent-seller-key.pem");
  fs.writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o600 });

  return {
    root,
    archiveSha256: assembled.archiveSha256,
    publicKeyFingerprint: assembled.publicKeyFingerprint,
    runtimePath: path.join(installedPackageRoot, "beta", "src", "runtime.js"),
    input: { archivePath, pinnedZipSha256: assembled.archiveSha256, bundleRoot, publicKeyPath, installedPackageRoot },
  };
}

function reject(input: DeliveredBundleInput): void {
  const root = path.dirname(input.archivePath);
  const before = treeState(root);
  assert.throws(() => verifyDeliveredBundle(input), (error: unknown) => error instanceof Error && error.name === "ReleaseIntegrityError");
  assert.deepEqual(treeState(root), before);
}

test("authenticates the delivered ZIP, unpacked tree, and installed package without writing state", () => {
  const fixture = makeFixture();
  try {
    const before = treeState(fixture.root);
    assert.deepEqual(verifyDeliveredBundle(fixture.input), {
      archiveSha256: fixture.archiveSha256,
      publicKeyFingerprint: fixture.publicKeyFingerprint,
      memberCount: 17,
      installedMemberCount: 8,
      releaseReceiptSchema: "trajecta.release-integrity-evaluation/v1",
      releaseInstant: RELEASE_INSTANT,
    });
    assert.deepEqual(treeState(fixture.root), before);

    const originalArchive = fs.readFileSync(fixture.input.archivePath);
    const alteredArchive = Buffer.from(originalArchive);
    alteredArchive[100] ^= 1;
    fs.writeFileSync(fixture.input.archivePath, alteredArchive);
    reject(fixture.input);
    fs.writeFileSync(fixture.input.archivePath, originalArchive);

    const archiveHardLink = path.join(fixture.root, "outside-archive-link.zip");
    fs.linkSync(fixture.input.archivePath, archiveHardLink);
    reject(fixture.input);
    fs.unlinkSync(archiveHardLink);

    reject({ ...fixture.input, pinnedZipSha256: "0".repeat(64) });

    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
    const originalKey = fs.readFileSync(fixture.input.publicKeyPath);
    fs.writeFileSync(fixture.input.publicKeyPath, otherKey);
    reject(fixture.input);
    fs.writeFileSync(fixture.input.publicKeyPath, originalKey);

    const keyHardLink = path.join(fixture.root, "outside-key-link.pem");
    fs.linkSync(fixture.input.publicKeyPath, keyHardLink);
    reject(fixture.input);
    fs.unlinkSync(keyHardLink);

    const documentPath = path.join(fixture.input.bundleRoot, "START-HERE.md");
    const originalDocument = fs.readFileSync(documentPath);
    fs.writeFileSync(documentPath, "altered\n");
    reject(fixture.input);
    fs.writeFileSync(documentPath, originalDocument);

    const documentHardLink = path.join(fixture.root, "outside-document-link.md");
    fs.linkSync(documentPath, documentHardLink);
    reject(fixture.input);
    fs.unlinkSync(documentHardLink);

    const originalRuntime = fs.readFileSync(fixture.runtimePath);
    fs.writeFileSync(fixture.runtimePath, "export const runtime = 'tampered';\n");
    reject(fixture.input);
    fs.writeFileSync(fixture.runtimePath, originalRuntime);

    const runtimeHardLink = path.join(fixture.root, "outside-runtime-link.js");
    fs.linkSync(fixture.runtimePath, runtimeHardLink);
    reject(fixture.input);
    fs.unlinkSync(runtimeHardLink);

    fs.chmodSync(fixture.runtimePath, 0o755);
    reject(fixture.input);
    fs.chmodSync(fixture.runtimePath, 0o644);

    const unpackedLink = path.join(fixture.input.bundleRoot, "recipes", "linked.md");
    fs.symlinkSync("01-planner-to-local-workspace.md", unpackedLink);
    reject(fixture.input);
    fs.unlinkSync(unpackedLink);

    const unpackedExtra = path.join(fixture.input.bundleRoot, "unexpected.txt");
    fs.writeFileSync(unpackedExtra, "unexpected\n");
    reject(fixture.input);
    fs.unlinkSync(unpackedExtra);

    const installedExtra = path.join(fixture.input.installedPackageRoot, "beta", "src", "unexpected.js");
    fs.writeFileSync(installedExtra, "unexpected\n");
    reject(fixture.input);
    fs.unlinkSync(installedExtra);

    const externalRuntime = path.join(fixture.root, "external-runtime.js");
    fs.writeFileSync(externalRuntime, originalRuntime);
    fs.unlinkSync(fixture.runtimePath);
    fs.symlinkSync(externalRuntime, fixture.runtimePath);
    reject(fixture.input);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
