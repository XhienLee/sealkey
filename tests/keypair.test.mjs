import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sodium, concat, pieces, FAST } from './helpers.mjs';
import {
    makeSecretWords, secretWordsValid, deriveKeyPair, encodePublicKey, parsePublicKey, fingerprint,
    SECRET_WORDS, PUBLIC_PREFIX,
} from '../js/keypair.js';
import { parseHeader, KEY_HEADER_BYTES, KDF_X25519, lockedSize } from '../js/format.js';
import { createSealer, sealStream, createOpener, openMeta, unsealStream, META_CIPHER_BYTES } from '../js/core.js';
import { WORDS } from '../js/words.js';

const WORDS_A = [0, 640, 1280, 1920, 2560, 3200, 3840, 4480, 5120, 5760, 6400, 7040].map((i) => WORDS[i]).join(' ');

async function lockFor(s, publicKey, plain) {
    const meta = { kind: 1, count: 1, name: 'for-you.txt', size: plain.length };
    const sealer = createSealer(s, { recipient: publicKey, meta, params: FAST });
    const parts = [];
    for await (const { data } of sealStream(sealer, pieces(plain), plain.length)) parts.push(data);
    const out = concat(parts);
    assert.equal(out.length, sealer.size);
    return out;
}

async function openWith(s, bytes, secretKey) {
    const header = parseHeader(bytes.subarray(0, KEY_HEADER_BYTES));
    const state = createOpener(s, { secretKey, header });
    const meta = openMeta(s, state, header, bytes.slice(header.size, header.size + META_CIPHER_BYTES));
    const parts = [];
    for await (const { data } of unsealStream(s, state, async (o, l) => bytes.slice(o, o + l), bytes.length, header, meta)) parts.push(data);
    return { meta, data: concat(parts) };
}

test('makes 12 secret words and checks them', () => {
    const words = makeSecretWords();
    assert.equal(words.length, SECRET_WORDS);
    assert.ok(secretWordsValid(words.join(' ')));
    assert.ok(secretWordsValid(words.join('-').toUpperCase()));
    assert.ok(!secretWordsValid(words.slice(0, 11).join(' ')));
});

test('the same words always give the same key pair', async () => {
    const s = await sodium();
    const a = deriveKeyPair(s, WORDS_A);
    const b = deriveKeyPair(s, WORDS_A.toUpperCase().replace(/ /g, '-'));
    assert.deepEqual(a.publicKey, b.publicKey);
    assert.deepEqual(s.crypto_scalarmult_base(a.secretKey), a.publicKey);
    assert.throws(() => deriveKeyPair(s, 'tiger mango'), { code: 'bad_secret_words' });
});

test('public key text round-trips and catches typos', async () => {
    const s = await sodium();
    const { publicKey } = deriveKeyPair(s, WORDS_A);
    const text = encodePublicKey(s, publicKey);
    assert.ok(text.startsWith(PUBLIC_PREFIX));
    assert.deepEqual(parsePublicKey(s, `  ${text.slice(0, 20)}\n${text.slice(20)} `), publicKey);
    const last = text.at(-1) === 'A' ? 'B' : 'A';
    assert.throws(() => parsePublicKey(s, text.slice(0, -1) + last), { code: 'bad_public_key' });
    assert.throws(() => parsePublicKey(s, text.slice(PUBLIC_PREFIX.length)), { code: 'bad_public_key' });
    assert.throws(() => parsePublicKey(s, PUBLIC_PREFIX + 'abc'), { code: 'bad_public_key' });
});

test('fingerprint is 6 stable words that differ between keys', async () => {
    const s = await sodium();
    const a = deriveKeyPair(s, WORDS_A).publicKey;
    const b = s.crypto_box_keypair().publicKey;
    assert.equal(fingerprint(s, a).length, 6);
    assert.deepEqual(fingerprint(s, a), fingerprint(s, a));
    assert.notDeepEqual(fingerprint(s, a), fingerprint(s, b));
});

test('a file locked for a public key opens only with the matching words', async () => {
    const s = await sodium();
    const me = deriveKeyPair(s, WORDS_A);
    const plain = new Uint8Array(5000).map((_, i) => i * 7);
    const sealed = await lockFor(s, me.publicKey, plain);
    const header = parseHeader(sealed.subarray(0, KEY_HEADER_BYTES));
    assert.equal(header.kdf, KDF_X25519);
    assert.equal(sealed.length, lockedSize(plain.length, FAST.chunkBytes, KEY_HEADER_BYTES));
    const { meta, data } = await openWith(s, sealed, me.secretKey);
    assert.equal(meta.name, 'for-you.txt');
    assert.deepEqual(data, plain);
    const other = s.crypto_box_keypair();
    await assert.rejects(openWith(s, sealed, other.privateKey), { code: 'wrong_key' });
    assert.throws(() => createOpener(s, { keyText: 'a-b', header }), { code: 'needs_secret_words' });
});

test('key-pair files catch a changed one-time key, header or chunk', async () => {
    const s = await sodium();
    const me = deriveKeyPair(s, WORDS_A);
    const sealed = await lockFor(s, me.publicKey, new Uint8Array(3000).fill(9));
    const flip = (at) => { const c = sealed.slice(); c[at] ^= 1; return c; };
    await assert.rejects(openWith(s, flip(70), me.secretKey), { code: 'wrong_key' });
    await assert.rejects(openWith(s, flip(20), me.secretKey), { code: 'wrong_key' });
    await assert.rejects(openWith(s, flip(KEY_HEADER_BYTES + META_CIPHER_BYTES + 10), me.secretKey), { code: 'damaged' });
    await assert.rejects(openWith(s, sealed.slice(0, sealed.length - 5), me.secretKey), { code: 'incomplete' });
});

test('each file gets a fresh one-time key', async () => {
    const s = await sodium();
    const me = deriveKeyPair(s, WORDS_A);
    const a = await lockFor(s, me.publicKey, new Uint8Array(10));
    const b = await lockFor(s, me.publicKey, new Uint8Array(10));
    assert.notDeepEqual(a.slice(58, 90), b.slice(58, 90));
});
