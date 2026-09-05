import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { assembleBundle, verifyBundle, DOCUMENT_PATHS } from '../src/assemble.ts';
import { createDeterministicTgz } from '../src/deterministic-tgz.ts';
import { sha256Hex } from '../src/canonical.ts';

test('signed bundle rebuilds identically and verifies independently pinned bytes',()=>{
  const keys=generateKeyPairSync('ed25519'), publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString(),privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const releaseInstant='2026-09-05T00:00:00Z';
  const entries=[{path:'LICENSES/CORE-MODIFICATIONS.txt',bytes:Buffer.from('Evaluation notice'),mode:'0644' as const},{path:'beta/DEVELOPMENT-BOUNDARY.md',bytes:Buffer.from('Evaluation'),mode:'0644' as const},{path:'package.json',bytes:Buffer.from('{}'),mode:'0644' as const}];
  const tgz=createDeterministicTgz(entries,releaseInstant);
  const memberLedger=entries.map(e=>({path:e.path,bytes:e.bytes.length,sha256:sha256Hex(e.bytes),mode:e.mode,originalClass:'notice' as const}));
  const documents=new Map(DOCUMENT_PATHS.map(p=>[p,Buffer.from('Customer-0 evaluation only')]));
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
});
