import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    encodeHeader, parseHeader, encodeMeta, parseMeta, lockedSize, cleanName, cleanPath, utf8Cut,
    HEADER_BYTES, META_BYTES, DEFAULTS,
} from '../js/format.js';
import { errorCode } from './helpers.mjs';

const salt = new Uint8Array(16).fill(7);
const ssHeader = new Uint8Array(24).fill(9);

test('header is 58 bytes and round-trips', () => {
    const bytes = encodeHeader({ ...DEFAULTS, salt, ssHeader });
    assert.equal(bytes.length, HEADER_BYTES);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'SEAL');
    const header = parseHeader(bytes);
    assert.equal(header.passes, 3);
    assert.equal(header.memKiB, 65536);
    assert.equal(header.chunkBytes, 1048576);
    assert.deepEqual(header.salt, salt);
    assert.deepEqual(header.ssHeader, ssHeader);
});

test('header rejects wrong magic, newer versions and unsafe limits', async () => {
    const good = encodeHeader({ ...DEFAULTS, salt, ssHeader });
    const edit = (fn) => { const copy = good.slice(); fn(copy, new DataView(copy.buffer)); return copy; };
    assert.equal(await errorCode((async () => parseHeader(edit((b) => { b[0] = 76; })))()), 'not_locked');
    assert.equal(await errorCode((async () => parseHeader(new Uint8Array(10)))()), 'not_locked');
    assert.equal(await errorCode((async () => parseHeader(edit((b) => { b[4] = 2; })))()), 'newer_version');
    assert.equal(await errorCode((async () => parseHeader(edit((b) => { b[5] = 9; })))()), 'unsafe_header');
    assert.equal(await errorCode((async () => parseHeader(edit((b, v) => v.setUint32(6, 11, true))))()), 'unsafe_header');
    assert.equal(await errorCode((async () => parseHeader(edit((b, v) => v.setUint32(6, 0, true))))()), 'unsafe_header');
    assert.equal(await errorCode((async () => parseHeader(edit((b, v) => v.setUint32(10, 524289, true))))()), 'unsafe_header');
    assert.equal(await errorCode((async () => parseHeader(edit((b, v) => v.setUint32(14, 16777217, true))))()), 'unsafe_header');
    assert.equal(parseHeader(edit((b, v) => v.setUint32(10, 524288, true))).memKiB, 524288);
});

test('metadata round-trips and validates', async () => {
    const meta = parseMeta(encodeMeta({ kind: 2, count: 12, name: 'Trip.zip', size: 340000000 }));
    assert.deepEqual(meta, { kind: 2, count: 12, name: 'Trip.zip', size: 340000000 });
    assert.equal(encodeMeta({ kind: 1, count: 1, name: 'a', size: 1 }).length, META_BYTES);
    const long = 'é'.repeat(300);
    assert.equal(new TextEncoder().encode(parseMeta(encodeMeta({ kind: 1, count: 1, name: long, size: 0 })).name).length, 254);
    const bad = (fields) => errorCode((async () => parseMeta(encodeMeta({ kind: 1, count: 1, name: 'x', size: 1, ...fields })))());
    assert.equal(await bad({ kind: 3 }), 'unsafe_meta');
    assert.equal(await bad({ kind: 2, count: 1 }), 'unsafe_meta');
    assert.equal(await bad({ kind: 2, count: 10001 }), 'unsafe_meta');
    assert.equal(await bad({ kind: 1, count: 0 }), 'unsafe_meta');
    const broken = encodeMeta({ kind: 1, count: 1, name: 'ab', size: 1 });
    broken[7] = 0xff;
    assert.equal(await errorCode((async () => parseMeta(broken))()), 'unsafe_meta');
});

test('locked size formula', () => {
    assert.equal(lockedSize(0, 1048576), 58 + 529 + 17);
    assert.equal(lockedSize(1048576, 1048576), 58 + 529 + 1048576 + 17);
    assert.equal(lockedSize(1048577, 1048576), 58 + 529 + 1048577 + 34);
});

test('names are cleaned', () => {
    assert.equal(cleanName('../../etc/passwd'), 'passwd');
    assert.equal(cleanName('C:\\Users\\me\\report.pdf'), 'report.pdf');
    assert.equal(cleanName('.bashrc'), 'bashrc');
    assert.equal(cleanName('a\u0000b\u001fc.txt'), 'abc.txt');
    assert.equal(cleanName('...'), 'file');
    assert.equal(Array.from(cleanName('😀'.repeat(300))).length, 200);
    assert.equal(cleanName('日本語 ñ 😀.txt'), '日本語 ñ 😀.txt');
    assert.equal(cleanPath('Trip/../Day 1/./photo.jpg'), 'Trip/Day 1/photo.jpg');
    assert.equal(cleanPath('/abs//x'), 'abs/x');
    assert.equal(utf8Cut('ab😀', 5), 'ab');
});
