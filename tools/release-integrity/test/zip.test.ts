import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip } from '../src/deterministic-zip.ts';

const instant = '2026-09-05T00:00:00Z';
const members = [{ path: 'bundle/a.txt', bytes: Buffer.from('hello'), mode: '0644' as const }, { path: 'bundle/b.txt', bytes: Buffer.from('world'), mode: '0644' as const }];
test('ZIP roundtrip preserves exact payload bytes and frozen metadata', () => {
  const zip = createZip(members, instant);
  assert.deepEqual(zip, createZip(members, instant));
  assert.deepEqual(readZip(zip, instant), members);
});
test('ZIP rejects corrupted bytes, appended data and noncanonical metadata', () => {
  const zip = createZip(members, instant);
  for (const offset of [8, 10, 14, 30, 45, zip.length - 1]) {
    const changed = Buffer.from(zip); changed[offset] ^= 1;
    assert.throws(() => readZip(changed, instant));
  }
  assert.throws(() => readZip(Buffer.concat([zip, Buffer.from([0])]), instant));
  assert.throws(() => readZip(zip, '2026-09-06T00:00:00Z'));
});
test('ZIP writer rejects unsafe names, collisions, links and oversized member counts', () => {
  for (const name of ['../escape', '/absolute', 'bundle/../a', 'bundle\\a']) assert.throws(() => createZip([{...members[0], path:name}], instant));
  assert.throws(() => createZip([members[0], members[0]], instant));
  assert.throws(() => createZip([{...members[0],path:'bundle/A'}, {...members[0],path:'bundle/a'}], instant));
  assert.throws(() => createZip([{...members[0], mode:'0777' as any}], instant));
});
