import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { assembleBundle, DOCUMENT_PATHS } from '../src/assemble.ts';
import { createDeterministicTgz } from '../src/deterministic-tgz.ts';
import { sha256Hex } from '../src/canonical.ts';

// A signed archive still must preserve the required nested-to-outer notices.
// Removing the notice comparison must make this test fail.
test('assembly rejects an outer notice that omits the packaged modification notice', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({format:'pem',type:'spki'}).toString();
  const privateKeyPem = keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const releaseInstant = '2026-09-05T00:00:00Z';
  const entries = [
    {path:'LICENSE',bytes:Buffer.from('Core license\n'),mode:'0644' as const},
    {path:'LICENSES/CORE-MODIFICATIONS.txt',bytes:Buffer.from('Modified core/src/index.js\n'),mode:'0644' as const},
    {path:'NOTICE',bytes:Buffer.from('Core attribution\n'),mode:'0644' as const},
    {path:'beta/DEVELOPMENT-BOUNDARY.md',bytes:Buffer.from('Evaluation\n'),mode:'0644' as const},
    {path:'package.json',bytes:Buffer.from('{}'),mode:'0644' as const},
  ];
  const memberLedger = entries.map(e=>({...e,bytes:e.bytes.length,sha256:sha256Hex(e.bytes),originalClass:'notice' as const}));
  const documents = new Map<string,Buffer>(DOCUMENT_PATHS.map(p=>[p,Buffer.from('Evaluation\n')]));
  documents.set('LICENSES/CORE-APACHE-2.0.txt',entries[0].bytes);
  documents.set('LICENSES/CORE-NOTICE.txt',Buffer.from('Core attribution\n'));
  const input = {tgz:createDeterministicTgz(entries.map(e=>({...e,path:`package/${e.path}`})),releaseInstant),memberLedger,documents,buildCommit:'a'.repeat(40),releaseInstant,verificationInstant:releaseInstant,publicKeyPem,privateKeyPem};
  assert.throws(()=>assembleBundle(input), /notice/i);
});
