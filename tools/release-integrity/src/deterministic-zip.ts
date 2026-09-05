import { assertSafeArchivePath, parseReleaseInstant } from './contracts.ts';
import { releaseError } from './errors.ts';

export interface ZipMember { path: string; bytes: Buffer; mode: '0644' | '0755' }
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_MEMBERS = 512;
function fail(): never { return releaseError('INVALID_ZIP', 'Archive is not a bounded canonical release ZIP.'); }
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function timestamp(instant: unknown): [number, number] {
  const d = parseReleaseInstant(instant);
  return [(d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()];
}

/** A single canonical STORE encoding, without extras, comments, directories or links. */
export function createZip(members: readonly ZipMember[], instant: unknown): Buffer {
  const [time, date] = timestamp(instant);
  if (!members.length || members.length > MAX_MEMBERS) fail();
  const chunks: Buffer[] = [], central: Buffer[] = [], names = new Set<string>();
  let offset = 0, previous = '', total = 0;
  for (const member of members) {
    const name = assertSafeArchivePath(member.path), folded = name.toLowerCase();
    if (name <= previous || names.has(folded) || name.length > 255 || !Buffer.isBuffer(member.bytes) || !['0644','0755'].includes(member.mode)) fail();
    previous = name; names.add(folded); total += member.bytes.length;
    if (total > MAX_BYTES) fail();
    const encoded = Buffer.from(name, 'ascii'), checksum = crc32(member.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(time,10); local.writeUInt16LE(date,12); local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(member.bytes.length,18); local.writeUInt32LE(member.bytes.length,22); local.writeUInt16LE(encoded.length,26);
    chunks.push(local, encoded, member.bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314,4); entry.writeUInt16LE(20,6); entry.writeUInt16LE(0x800,8);
    entry.writeUInt16LE(time,12); entry.writeUInt16LE(date,14); entry.writeUInt32LE(checksum,16);
    entry.writeUInt32LE(member.bytes.length,20); entry.writeUInt32LE(member.bytes.length,24); entry.writeUInt16LE(encoded.length,28);
    entry.writeUInt32LE(((0o100000 | parseInt(member.mode,8)) << 16) >>> 0,38); entry.writeUInt32LE(offset,42);
    central.push(entry,encoded); offset += local.length + encoded.length + member.bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length,8); end.writeUInt16LE(members.length,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directory,end]);
}

/** Bounded local-header parse followed by byte-for-byte canonical reconstruction. */
export function readZip(zip: Buffer, instant: unknown): ZipMember[] {
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > MAX_BYTES + MAX_MEMBERS * 600) fail();
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) fail();
  const count = zip.readUInt16LE(end + 10), centralOffset = zip.readUInt32LE(end + 16);
  if (!count || count > MAX_MEMBERS || centralOffset >= end) fail();
  let offset = 0, central = centralOffset, total = 0;
  const members: ZipMember[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 30 > centralOffset || central + 46 > end || zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt32LE(central) !== 0x02014b50) fail();
    const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + nameSize, finish = start + size;
    total += size;
    if (extra !== 0 || nameSize > 255 || finish > centralOffset || total > MAX_BYTES) fail();
    const nameBytes = zip.subarray(offset + 30,start);
    if (nameBytes.some(byte => byte > 127)) fail();
    const memberPath = nameBytes.toString('ascii');
    const mode = (zip.readUInt32LE(central + 38) >>> 16) & 0o777;
    if (mode !== 0o644 && mode !== 0o755) fail();
    members.push({ path:memberPath, bytes:Buffer.from(zip.subarray(start,finish)), mode:mode === 0o644 ? '0644' : '0755' });
    const centralNameSize = zip.readUInt16LE(central + 28);
    central += 46 + centralNameSize;
    if (central > end) fail();
    offset = finish;
  }
  if (offset !== centralOffset || central !== end || !createZip(members,instant).equals(zip)) fail();
  return members;
}
