import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DEFAULTS, HEADER_BYTES, encodeHeader } from '../js/format.js';
import { META_CIPHER_BYTES } from '../js/core.js';
import { FAST, lockBytes, openBytes, errorCode, concat } from './helpers.mjs';

const C = FAST.chunkBytes;

test('round trip at chunk edge sizes', async () => {
    for (const size of [0, 1, C - 1, C, C + 1, 2 * C, 5 * C + 3]) {
        const plain = new Uint8Array(randomBytes(size));
        const locked = await lockBytes(plain);
        const { meta, data } = await openBytes(locked);
        assert.equal(meta.size, size);
        assert.deepEqual(data, plain, `size ${size}`);
    }
});

test('round trip with real default settings and 1 MiB chunks', async () => {
    for (const size of [1048575, 1048576, 1048577, 2097152]) {
        const plain = new Uint8Array(randomBytes(size));
        const locked = await lockBytes(plain, { params: DEFAULTS });
        assert.deepEqual((await openBytes(locked)).data, plain);
    }
});

test('each lock uses a fresh salt and stream header', async () => {
    const plain = new Uint8Array(100);
    const a = await lockBytes(plain);
    const b = await lockBytes(plain);
    assert.notDeepEqual(a.subarray(18, 58), b.subarray(18, 58));
});

const DATA_START = HEADER_BYTES + META_CIPHER_BYTES;
const chunkAt = (index) => DATA_START + index * (C + 17);

async function sample() {
    const plain = new Uint8Array(randomBytes(4 * C + 100));
    return { plain, locked: await lockBytes(plain) };
}

test('wrong key', async () => {
    const { locked } = await sample();
    assert.equal(await errorCode(openBytes(locked, 'tiger-mango-velvet-cloud-pebble-walnut')), 'wrong_key');
});

test('cut at a chunk boundary and in the middle of a chunk', async () => {
    const { locked } = await sample();
    assert.equal(await errorCode(openBytes(locked.slice(0, chunkAt(2)))), 'incomplete');
    assert.equal(await errorCode(openBytes(locked.slice(0, chunkAt(2) + 300))), 'incomplete');
    assert.equal(await errorCode(openBytes(locked.slice(0, locked.length - 1))), 'incomplete');
    assert.equal(await errorCode(openBytes(locked.slice(0, 100))), 'incomplete');
});

test('flipped bytes in header, metadata, middle and last chunk', async () => {
    const { locked } = await sample();
    const flip = (at) => { const copy = locked.slice(); copy[at] ^= 1; return copy; };
    assert.equal(await errorCode(openBytes(flip(0))), 'not_locked');
    assert.equal(await errorCode(openBytes(flip(25))), 'wrong_key');
    assert.equal(await errorCode(openBytes(flip(40))), 'wrong_key');
    assert.equal(await errorCode(openBytes(flip(HEADER_BYTES + 10))), 'wrong_key');
    assert.equal(await errorCode(openBytes(flip(chunkAt(2) + 50))), 'damaged');
    assert.equal(await errorCode(openBytes(flip(locked.length - 3))), 'damaged');
});

test('swapped chunks, removed chunk and extra bytes', async () => {
    const { locked } = await sample();
    const a = locked.slice(chunkAt(1), chunkAt(2));
    const b = locked.slice(chunkAt(2), chunkAt(3));
    const swapped = concat([locked.slice(0, chunkAt(1)), b, a, locked.slice(chunkAt(3))]);
    assert.equal(await errorCode(openBytes(swapped)), 'damaged');
    const removed = concat([locked.slice(0, chunkAt(1)), locked.slice(chunkAt(2))]);
    assert.equal(await errorCode(openBytes(removed)), 'incomplete');
    assert.equal(await errorCode(openBytes(concat([locked, new Uint8Array([0])]))), 'extra_data');
});

test('huge Argon2 memory, passes or chunk size are refused before any work', async () => {
    const { locked } = await sample();
    for (const [offset, value] of [[10, 1048576], [6, 50], [14, 1 << 30]]) {
        const copy = locked.slice();
        new DataView(copy.buffer).setUint32(offset, value, true);
        assert.equal(await errorCode(openBytes(copy)), 'unsafe_header');
    }
});

test('a file that is not locked, such as a photo', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(500)]);
    assert.equal(await errorCode(openBytes(jpeg)), 'not_locked');
});

test('metadata names survive', async () => {
    const plain = new Uint8Array(10);
    const name = '日本語 ñ 😀 report.pdf';
    const locked = await lockBytes(plain, { meta: { kind: 1, count: 1, name, size: 10 } });
    assert.equal((await openBytes(locked)).meta.name, name);
});

test('source that changes size while locking is caught', async () => {
    const { createSealer, sealStream } = await import('../js/core.js');
    const { sodium } = await import('./helpers.mjs');
    const s = await sodium();
    const sealer = createSealer(s, { keyText: 'a-b', meta: { kind: 1, count: 1, name: 'x', size: 50 }, params: FAST });
    async function* short() { yield new Uint8Array(40); }
    async function* long() { yield new Uint8Array(60); }
    const drain = async (source) => { for await (const _ of sealStream(sealer, source, 50)) { } };
    assert.equal(await errorCode(drain(short())), 'changed');
    assert.equal(await errorCode(drain(long())), 'changed');
    assert.ok(encodeHeader);
});
