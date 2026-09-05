import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { assembleBundle, verifyBundle, DOCUMENT_PATHS } from '../src/assemble.ts';
import { createDeterministicTgz } from '../src/deterministic-tgz.ts';
import { sha256Hex } from '../src/canonical.ts';
import * as assembly from '../src/assemble.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyDeliveredBundle } from '../../../packages/trajecta-beta/src/release/archive-verification.ts';
import { readZip } from '../src/deterministic-zip.ts';

test('signed bundle rebuilds identically and verifies independently pinned bytes',()=>{
  const keys=generateKeyPairSync('ed25519'), publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString(),privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const releaseInstant='2026-09-05T00:00:00Z';
  const entries=[{path:'BETA-COMMERCIAL-TERMS.txt',bytes:Buffer.from('Customer-0 evaluation only'),mode:'0644' as const},{path:'LICENSE',bytes:Buffer.from('Core license\n'),mode:'0644' as const},{path:'LICENSES/CORE-MODIFICATIONS.txt',bytes:Buffer.from('Evaluation notice\n'),mode:'0644' as const},{path:'NOTICE',bytes:Buffer.from('Core attribution\n'),mode:'0644' as const},{path:'beta/DEVELOPMENT-BOUNDARY.md',bytes:Buffer.from('Evaluation'),mode:'0644' as const},{path:'package.json',bytes:Buffer.from('{}'),mode:'0644' as const}];
  const tgz=createDeterministicTgz(entries.map(e=>({...e,path:`package/${e.path}`})),releaseInstant);
  const memberLedger=entries.map(e=>({path:e.path,bytes:e.bytes.length,sha256:sha256Hex(e.bytes),mode:e.mode,originalClass:'notice' as const}));
  const documents=new Map(DOCUMENT_PATHS.map(p=>[p,Buffer.from('Customer-0 evaluation only')]));
  documents.set('LICENSES/CORE-APACHE-2.0.txt',entries.find(entry=>entry.path==='LICENSE')!.bytes);
  documents.set('LICENSES/CORE-NOTICE.txt',Buffer.from('Core attribution\n\nEvaluation notice\n'));
  const input={tgz,memberLedger,documents,buildCommit:'a'.repeat(40),releaseInstant,verificationInstant:releaseInstant,publicKeyPem,privateKeyPem};
  const first=assembleBundle(input),second=assembleBundle(input);
  assert.deepEqual(first.zip,second.zip);
  const pinned={...first,publicKeyPem,releaseInstant};
  assert.equal(verifyBundle(pinned).size,17);
  assert.throws(()=>verifyBundle({...pinned,archiveSha256:'0'.repeat(64)}));
  assert.throws(()=>verifyBundle({...pinned,publicKeyFingerprint:'0'.repeat(64)}));
  const changed=Buffer.from(first.zip); changed[100]^=1;
  assert.throws(()=>verifyBundle({...pinned,zip:changed,archiveSha256:sha256Hex(changed)}));
  assert.throws(()=>assembleBundle({...input,documents:new Map()}));
  // A corrupt archive must never leave extracted or executable bytes behind.
  assert.equal(typeof assembly.verifyAndExtractBundle,'function');
  const destinationParent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'trajecta-extraction-test-')));
  const outputDirectory=path.join(destinationParent,'unpacked');
  assert.throws(()=>assembly.verifyAndExtractBundle({...pinned,zip:changed,outputDirectory,sourceRoot:process.cwd()}));
  assert.equal(fs.existsSync(outputDirectory),false);
  const extracted=assembly.verifyAndExtractBundle({...pinned,outputDirectory,sourceRoot:process.cwd()});
  assert.equal(fs.readFileSync(path.join(extracted,'START-HERE.md'),'utf8'),'Customer-0 evaluation only');
  assert.throws(()=>assembly.verifyAndExtractBundle({...pinned,outputDirectory,sourceRoot:process.cwd()}));
  const linked=path.join(destinationParent,'linked');
  fs.symlinkSync(destinationParent,linked);
  assert.throws(()=>assembly.verifyAndExtractBundle({...pinned,outputDirectory:path.join(linked,'escape'),sourceRoot:process.cwd()}));
  assert.equal(fs.existsSync(path.join(destinationParent,'escape')),false);
  const candidate=assembleBundle({...input,releaseKind:'commercial-candidate'});
  const candidateReceipt=JSON.parse(readZip(candidate.zip,releaseInstant).find(member=>member.path.endsWith('/RELEASE-RECEIPT.json'))!.bytes.toString('utf8'));
  assert.equal(candidateReceipt.schema,'trajecta.release-integrity-commercial-candidate/v1');
});

test('seller extraction restores authenticated modes under a restrictive umask for customer verification', (t) => {
  const keys=generateKeyPairSync('ed25519'), publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString(),privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const releaseInstant='2026-09-05T00:00:00Z';
  const entries=[{path:'LICENSE',bytes:Buffer.from('Core license\n'),mode:'0644' as const},{path:'LICENSES/CORE-MODIFICATIONS.txt',bytes:Buffer.from('Evaluation notice\n'),mode:'0644' as const},{path:'NOTICE',bytes:Buffer.from('Core attribution\n'),mode:'0644' as const},{path:'beta/DEVELOPMENT-BOUNDARY.md',bytes:Buffer.from('Evaluation'),mode:'0644' as const},{path:'package.json',bytes:Buffer.from('{}'),mode:'0644' as const}];
  const tgz=createDeterministicTgz(entries.map(entry=>({...entry,path:`package/${entry.path}`})),releaseInstant);
  const memberLedger=entries.map(entry=>({path:entry.path,bytes:entry.bytes.length,sha256:sha256Hex(entry.bytes),mode:entry.mode,originalClass:'notice' as const}));
  const documents=new Map(DOCUMENT_PATHS.map(member=>[member,Buffer.from('Customer-0 evaluation only')]));
  documents.set('LICENSES/CORE-APACHE-2.0.txt',entries[0].bytes);
  documents.set('LICENSES/CORE-NOTICE.txt',Buffer.from('Core attribution\n\nEvaluation notice\n'));
  const bundle=assembleBundle({tgz,memberLedger,documents,buildCommit:'a'.repeat(40),releaseInstant,verificationInstant:releaseInstant,publicKeyPem,privateKeyPem});
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'trajecta-extraction-verifier-')));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const archivePath=path.join(parent,'delivery.zip'),publicKeyPath=path.join(parent,'seller-public.pem'),installedPackageRoot=path.join(parent,'installed-package');
  const originalUmask=process.umask(0);
  try {
    fs.writeFileSync(archivePath,bundle.zip,{mode:0o600});
    fs.writeFileSync(publicKeyPath,publicKeyPem,{mode:0o600});
    for (const entry of entries) {
      const destination=path.join(installedPackageRoot,entry.path);
      fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      fs.writeFileSync(destination,entry.bytes,{mode:Number.parseInt(entry.mode,8)});
    }
  } finally { process.umask(originalUmask); }
  const restrictiveUmask=process.umask(0o077);
  let extractedRoot: string;
  try {
    extractedRoot=assembly.verifyAndExtractBundle({...bundle,zip:bundle.zip,publicKeyPem,releaseInstant,outputDirectory:path.join(parent,'unpacked'),sourceRoot:process.cwd()});
  } finally { process.umask(restrictiveUmask); }
  assert.deepEqual(verifyDeliveredBundle({archivePath,pinnedZipSha256:bundle.archiveSha256,bundleRoot:extractedRoot,publicKeyPath,installedPackageRoot}),{
    archiveSha256:bundle.archiveSha256,
    publicKeyFingerprint:bundle.publicKeyFingerprint,
    memberCount:17,
    installedMemberCount:entries.length,
    releaseInstant,
    releaseReceiptSchema:'trajecta.release-integrity-evaluation/v1',
  });
});
