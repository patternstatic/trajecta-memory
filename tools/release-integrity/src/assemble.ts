import { canonicalJsonLf, sha256Hex } from './canonical.ts';
import { PACKAGE_PATH } from './contracts.ts';
import { createZip, readZip } from './deterministic-zip.ts';
import { buildManifest } from './manifest.ts';
import { buildEvaluationReceipt, signReceipt, verifySignedReceipt } from './signing.ts';
import { auditTgz, type TarLedgerMember } from './tar-reader.ts';
import { releaseError } from './errors.ts';

export const BUNDLE_ROOT = 'trajecta-verified-resume-sdk-beta-0.1.0';
export const DOCUMENT_PATHS = ['START-HERE.html','START-HERE.md','recipes/01-planner-to-local-workspace.md','recipes/02-stale-rejection.md','recipes/03-inspect-retry-receipt.md','TROUBLESHOOTING.md','SUPPORTED-ENVIRONMENT.md','LICENSES/CORE-APACHE-2.0.txt','LICENSES/CORE-NOTICE.txt','LICENSES/BETA-COMMERCIAL-TERMS.txt','THIRD-PARTY-NOTICES.txt'] as const;
const CONTROLS = ['MANIFEST.json','RELEASE-RECEIPT.json','RELEASE-RECEIPT.json.sig','SELLER-PUBLIC-KEY.pem','SHA256SUMS.txt'];
function fail(): never { return releaseError('MANIFEST_MISMATCH','Release members do not match the accepted bundle contract.'); }
function checksums(files: ReadonlyMap<string,Buffer>): Buffer {
  return Buffer.from([...files].sort(([a],[b])=>a<b?-1:1).map(([p,b])=>`${sha256Hex(b)}  ${p}\n`).join(''));
}
export interface AssemblyInput {
  tgz: Buffer; memberLedger: readonly TarLedgerMember[]; documents: ReadonlyMap<string,Buffer>;
  buildCommit: string; releaseInstant: string; verificationInstant: string; publicKeyPem: string; privateKeyPem: string;
}
export function assembleBundle(input: AssemblyInput): { zip:Buffer; archiveSha256:string; publicKeyFingerprint:string } {
  if (input.documents.size !== DOCUMENT_PATHS.length || DOCUMENT_PATHS.some(p=>!input.documents.has(p))) fail();
  const payload = [...input.documents].map(([path,bytes])=>({path,bytes,originalClass: (path.startsWith('LICENSES/') || path==='THIRD-PARTY-NOTICES.txt' ? 'notice' : 'documentation') as 'notice'|'documentation'}));
  const manifest = buildManifest({releaseInstant:input.releaseInstant,payload:[...payload,{path:PACKAGE_PATH,bytes:input.tgz,memberLedger:[...input.memberLedger]}]});
  const receipt = buildEvaluationReceipt({buildCommit:input.buildCommit,manifestBytes:manifest.bytes,releaseInstant:input.releaseInstant,verificationInstant:input.verificationInstant,publicKeyPem:input.publicKeyPem});
  const signature = signReceipt({receiptBytes:receipt.bytes,privateKeyPem:input.privateKeyPem});
  const files = new Map(input.documents); files.set(PACKAGE_PATH,input.tgz);
  files.set('MANIFEST.json',manifest.bytes); files.set('RELEASE-RECEIPT.json',receipt.bytes); files.set('RELEASE-RECEIPT.json.sig',signature); files.set('SELLER-PUBLIC-KEY.pem',Buffer.from(input.publicKeyPem));
  files.set('SHA256SUMS.txt',checksums(files));
  const zip = createZip([...files].sort(([a],[b])=>a<b?-1:1).map(([p,bytes])=>({path:`${BUNDLE_ROOT}/${p}`,bytes,mode:'0644'})), input.releaseInstant);
  const archiveSha256=sha256Hex(zip);
  verifyBundle({zip,archiveSha256,publicKeyPem:input.publicKeyPem,publicKeyFingerprint:receipt.publicKeyFingerprint,releaseInstant:input.releaseInstant});
  return {zip,archiveSha256,publicKeyFingerprint:receipt.publicKeyFingerprint};
}

export function verifyBundle(input:{zip:Buffer;archiveSha256:string;publicKeyPem:string;publicKeyFingerprint:string;releaseInstant:string}): ReadonlyMap<string,Buffer> {
  if (sha256Hex(input.zip)!==input.archiveSha256) fail();
  const members=readZip(input.zip,input.releaseInstant), files=new Map<string,Buffer>();
  const expected=new Set<string>([...DOCUMENT_PATHS,PACKAGE_PATH,...CONTROLS]);
  for (const m of members) {
    if (!m.path.startsWith(`${BUNDLE_ROOT}/`) || m.mode!=='0644') fail();
    const p=m.path.slice(BUNDLE_ROOT.length+1); if(!expected.delete(p)) fail(); files.set(p,m.bytes);
  }
  if(expected.size) fail();
  const manifestBytes=files.get('MANIFEST.json')!,receiptBytes=files.get('RELEASE-RECEIPT.json')!;
  const receipt=verifySignedReceipt({receiptBytes,signature:files.get('RELEASE-RECEIPT.json.sig')!,manifestBytes,publicKeyPem:input.publicKeyPem,expectedPublicKeyFingerprint:input.publicKeyFingerprint});
  if(receipt.releaseInstant!==input.releaseInstant || !files.get('SELLER-PUBLIC-KEY.pem')!.equals(Buffer.from(input.publicKeyPem))) fail();
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  const payloadNames=new Set<string>([...DOCUMENT_PATHS,PACKAGE_PATH]);
  for(const m of manifest.members) {
    if(!payloadNames.delete(m.path)) fail();
    const bytes=files.get(m.path)!; if(bytes.length!==m.bytes || sha256Hex(bytes)!==m.sha256) fail();
    if(m.path===PACKAGE_PATH) {
      const audited = auditTgz(bytes,{releaseInstant:input.releaseInstant,expectedMembers:m.memberLedger});
      const coreLicense = audited.members.get('LICENSE');
      const coreNotice = audited.members.get('NOTICE');
      const modifications = audited.members.get('LICENSES/CORE-MODIFICATIONS.txt');
      if (!coreLicense || !coreNotice || !modifications
        || !files.get('LICENSES/CORE-APACHE-2.0.txt')!.equals(coreLicense)
        || !files.get('LICENSES/CORE-NOTICE.txt')!.equals(Buffer.concat([coreNotice,Buffer.from('\n'),modifications]))) {
        releaseError('NOTICE_MISMATCH','Outer license and notice must preserve the packaged core license and modification notice.');
      }
      for (const inner of audited.memberLedger) {
        if (inner.originalClass === 'apache-core' && inner.path.startsWith('core/src/')
          && !modifications.toString('utf8').includes(`- ${inner.path}\n`)) {
          releaseError('NOTICE_MISMATCH','Every generated Apache runtime member requires a modification notice.');
        }
      }
    }
  }
  if(payloadNames.size || !canonicalJsonLf(manifest).equals(manifestBytes)) fail();
  const sum=files.get('SHA256SUMS.txt')!, covered=new Map(files); covered.delete('SHA256SUMS.txt');
  if(!sum.equals(checksums(covered))) fail();
  return files;
}
