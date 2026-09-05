import { gzipSync } from "node:zlib";
import { parseReleaseInstant, assertSafeArchivePath } from "./contracts.ts";
import { releaseError } from "./errors.ts";

export interface TarWriteMember {
  path: string;
  bytes: Buffer;
  mode: "0644" | "0755";
}

function ascii(value: string, field: string): Buffer {
  if (!/^[\x20-\x7e]*$/.test(value)) return releaseError("INVALID_TAR_HEADER", `${field} must be printable ASCII.`);
  return Buffer.from(value, "ascii");
}

function splitUstarPath(memberPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(memberPath, "ascii") <= 100) return { name: memberPath, prefix: "" };
  for (let cut = memberPath.lastIndexOf("/"); cut > 0; cut = memberPath.lastIndexOf("/", cut - 1)) {
    const prefix = memberPath.slice(0, cut);
    const name = memberPath.slice(cut + 1);
    if (Buffer.byteLength(prefix, "ascii") <= 155 && Buffer.byteLength(name, "ascii") <= 100) return { name, prefix };
  }
  return releaseError("TAR_PATH_TOO_LONG", "Package member path cannot be represented by POSIX ustar.");
}

function writeOctal(target: Buffer, offset: number, width: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 8 ** (width - 1)) releaseError("INVALID_TAR_HEADER", "Tar numeric value is outside the bounded octal range.");
  const encoded = `${value.toString(8).padStart(width - 1, "0")}\0`;
  Buffer.from(encoded, "ascii").copy(target, offset);
}

function tarHeader(member: TarWriteMember, mtime: number): Buffer {
  const memberPath = assertSafeArchivePath(member.path);
  if (member.mode !== "0644" && member.mode !== "0755") return releaseError("INVALID_TAR_MODE", "Tar members must use normalized file modes.");
  const { name, prefix } = splitUstarPath(memberPath);
  const header = Buffer.alloc(512, 0);
  ascii(name, "tar name").copy(header, 0);
  writeOctal(header, 100, 8, Number.parseInt(member.mode, 8));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, member.bytes.length);
  writeOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  // uname/gname/device fields are all their canonical zero bytes.
  ascii(prefix, "tar prefix").copy(header, 345);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  Buffer.from(encoded, "ascii").copy(header, 148);
  return header;
}

/** Creates the one permitted tar encoding: sorted POSIX ustar regular files. */
export function createDeterministicTgz(members: readonly TarWriteMember[], releaseInstant: unknown): Buffer {
  const release = parseReleaseInstant(releaseInstant);
  const mtime = Math.floor(release.valueOf() / 1000);
  let previous = "";
  const chunks: Buffer[] = [];
  for (const member of members) {
    const memberPath = assertSafeArchivePath(member.path);
    if (memberPath <= previous) releaseError("NONCANONICAL_TAR_ORDER", "Tar member paths must be strictly ascending and unique.");
    previous = memberPath;
    chunks.push(tarHeader({ ...member, path: memberPath }, mtime));
    chunks.push(member.bytes);
    const padding = (512 - (member.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const gzip = gzipSync(Buffer.concat(chunks), { mtime: 0 });
  // Node's zlib records host OS. Canonical release bytes are independent of it.
  gzip[8] = 0; // XFL
  gzip[9] = 255; // OS unknown
  return gzip;
}
