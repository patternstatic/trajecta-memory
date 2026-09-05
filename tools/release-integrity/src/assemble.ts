import { sha256Hex } from './canonical.ts';
import { PACKAGE_PATH } from './contracts.ts';
import { createZip } from './deterministic-zip.ts';
import { buildManifest } from './manifest.ts';
import { buildEvaluationReceipt, signReceipt } from './signing.ts';
import { type TarLedgerMember } from './tar-reader.ts';
import { releaseError } from './errors.ts';
import fs from 'node:fs';
import path from 'node:path';
import { assertNewOutputDirectory } from './contracts.ts';
import { BUNDLE_ROOT, DOCUMENT_PATHS, verifyBundle } from '../../../packages/trajecta-beta/src/release/archive-verification.ts';
export { BUNDLE_ROOT, DOCUMENT_PATHS, verifyBundle } from '../../../packages/trajecta-beta/src/release/archive-verification.ts';

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

/** No bytes are extracted until the original archive and independent pins pass. */
export function verifyAndExtractBundle(input: Parameters<typeof verifyBundle>[0] & {outputDirectory:string;sourceRoot:string}): string {
  const files = verifyBundle(input);
  const output = assertNewOutputDirectory(input.outputDirectory,input.sourceRoot);
  const parent = path.dirname(output);
  if (!fs.lstatSync(parent).isDirectory()) releaseError('UNSAFE_OUTPUT','Extraction requires an existing parent directory.');
  fs.mkdirSync(output,{mode:0o700});
  const root = path.join(output,BUNDLE_ROOT);
  fs.mkdirSync(root,{mode:0o700});
  for (const [relative,bytes] of files) {
    const destination = path.join(root,relative);
    let directory = root;
    for (const segment of relative.split('/').slice(0,-1)) {
      directory = path.join(directory,segment);
      try { fs.mkdirSync(directory,{mode:0o700}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) releaseError('UNSAFE_OUTPUT','Extraction paths must remain private regular directories.');
    }
    const fd = fs.openSync(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try {
      fs.writeFileSync(fd,bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const readFd = fs.openSync(destination,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(readFd).isFile() || !fs.readFileSync(readFd).equals(bytes)) releaseError('MANIFEST_MISMATCH','Extracted bytes do not match the verified archive.');
    } finally { fs.closeSync(readFd); }
  }
  return root;
}
