import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { assembleBundle, verifyBundle, DOCUMENT_PATHS, BUNDLE_ROOT } from '../src/assemble.ts';
import { createDeterministicTgz } from '../src/deterministic-tgz.ts';
import { canonicalJsonLf, sha256Hex } from '../src/canonical.ts';
import { createZip, readZip } from '../src/deterministic-zip.ts';
import { buildEvaluationReceipt, signReceipt } from '../src/signing.ts';

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
  documents.set('LICENSES/CORE-APACHE-2.0.txt',entries.find(entry=>entry.path==='LICENSE')!.bytes);
  documents.set('LICENSES/CORE-NOTICE.txt',Buffer.from('Core attribution\n'));
  const input = {tgz:createDeterministicTgz(entries.map(e=>({...e,path:`package/${e.path}`})),releaseInstant),memberLedger,documents,buildCommit:'a'.repeat(40),releaseInstant,verificationInstant:releaseInstant,publicKeyPem,privateKeyPem};
  assert.throws(()=>assembleBundle(input), /notice/i);
  documents.set('LICENSES/CORE-NOTICE.txt',Buffer.from('Core attribution\n\nModified core/src/index.js\n'));
  const good = assembleBundle(input);
  const members = readZip(good.zip,releaseInstant);
  const manifest = JSON.parse(members.find(m=>m.path.endsWith('/MANIFEST.json'))!.bytes.toString());
  manifest.unapprovedField = true;
  const manifestBytes = canonicalJsonLf(manifest);
  const receipt = buildEvaluationReceipt({buildCommit:input.buildCommit,manifestBytes,releaseInstant,verificationInstant:releaseInstant,publicKeyPem});
  const altered = members.map(m=>({...m,bytes:m.path.endsWith('/MANIFEST.json') ? manifestBytes : m.path.endsWith('/RELEASE-RECEIPT.json') ? receipt.bytes : m.path.endsWith('/RELEASE-RECEIPT.json.sig') ? signReceipt({receiptBytes:receipt.bytes,privateKeyPem}) : m.bytes}));
  const sums = Buffer.from(altered.filter(m=>!m.path.endsWith('/SHA256SUMS.txt')).map(m=>`${sha256Hex(m.bytes)}  ${m.path.slice(BUNDLE_ROOT.length+1)}\n`).join(''));
  altered.find(m=>m.path.endsWith('/SHA256SUMS.txt'))!.bytes = sums;
  const zip = createZip(altered,releaseInstant);
  assert.throws(()=>verifyBundle({zip,archiveSha256:sha256Hex(zip),publicKeyPem,publicKeyFingerprint:good.publicKeyFingerprint,releaseInstant}), /unexpected|manifest/i);
});

test('commercial candidate rejects different authenticated inner and outer terms', () => {
  const keys=generateKeyPairSync('ed25519');
  const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString(), privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const releaseInstant='2026-09-05T00:00:00Z', innerTerms=Buffer.from('Approved candidate terms\n');
  const entries=[
    {path:'LICENSE',bytes:Buffer.from('Core license\n'),mode:'0644' as const},
    {path:'LICENSES/CORE-MODIFICATIONS.txt',bytes:Buffer.from('Modified core/src/index.js\n'),mode:'0644' as const},
    {path:'NOTICE',bytes:Buffer.from('Core attribution\n'),mode:'0644' as const},
    {path:'BETA-COMMERCIAL-TERMS.txt',bytes:innerTerms,mode:'0644' as const},
    {path:'beta/DEVELOPMENT-BOUNDARY.md',bytes:Buffer.from('Candidate\n'),mode:'0644' as const},
    {path:'package.json',bytes:Buffer.from('{}'),mode:'0644' as const},
  ].sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
  const memberLedger=entries.map(e=>({...e,bytes:e.bytes.length,sha256:sha256Hex(e.bytes),originalClass:'notice' as const}));
  const documents=new Map<string,Buffer>(DOCUMENT_PATHS.map(p=>[p,Buffer.from('Candidate\n')]));
  documents.set('LICENSES/CORE-APACHE-2.0.txt',entries.find(entry=>entry.path==='LICENSE')!.bytes);
  documents.set('LICENSES/CORE-NOTICE.txt',Buffer.from('Core attribution\n\nModified core/src/index.js\n'));
  documents.set('LICENSES/BETA-COMMERCIAL-TERMS.txt',Buffer.from('Different outer terms\n'));
  const input={tgz:createDeterministicTgz(entries.map(e=>({...e,path:`package/${e.path}`})),releaseInstant),memberLedger,documents,buildCommit:'a'.repeat(40),releaseInstant,verificationInstant:releaseInstant,publicKeyPem,privateKeyPem,releaseKind:'commercial-candidate' as const};
  assert.throws(()=>assembleBundle(input), {code:'TERMS_MISMATCH'});
  documents.set('LICENSES/BETA-COMMERCIAL-TERMS.txt',innerTerms);
  assert.doesNotThrow(()=>assembleBundle(input));
});
