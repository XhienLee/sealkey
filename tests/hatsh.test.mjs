import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { sodium, concat } from './helpers.mjs';
import { makeV1, makeV2, makeKeys, makeV2KeyPair } from './hatsh-fixtures.mjs';
import {
    hatKind, isSealkey, hatOutName, hatV2Layout, prepareHatV2, prepareHatV2KeyPair, openHatV1, HAT_CHUNK,
} from '../js/hatsh.js';

const subtle = webcrypto.subtle;
const text = (s) => new TextEncoder().encode(s);

const reader = (bytes) => async (offset, length) => bytes.slice(offset, offset + length);

async function openV2(s, bytes, password, chunk) {
    const opened = await prepareHatV2(s, password, reader(bytes), bytes.length, chunk);
    const parts = [];
    for await (const { data } of opened.stream()) parts.push(data);
    return { data: concat(parts), size: opened.plainSize };
}

function random(size) {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) webcrypto.getRandomValues(out.subarray(i, i + 65536));
    return out;
}

test('detects hat.sh v2, key-pair, v1 and Sealkey files', () => {
    assert.equal(hatKind(text('zDKO6XYXioc and more bytes here')), 'v2');
    assert.equal(hatKind(text('hTWKbfoikeg and more bytes here')), 'v2-keypair');
    assert.equal(hatKind(text('Encrypted Using Hat.sh plus data')), 'v1');
    assert.equal(hatKind(text('SEAL....................')), null);
    assert.equal(hatKind(text('short')), null);
    assert.equal(isSealkey(text('SEAL....')), true);
    assert.equal(isSealkey(text('zDKO6XYXioc')), false);
});

test('names the opened file the way hat.sh did', () => {
    assert.equal(hatOutName('v2', 'report.pdf.enc'), 'report.pdf');
    assert.equal(hatOutName('v2', 'report.pdf (1).enc'), 'report.pdf');
    assert.equal(hatOutName('v2', 'notes.ENC'), 'notes');
    assert.equal(hatOutName('v1', 'Encrypted-photo.jpg'), 'photo.jpg');
    assert.equal(hatOutName('v2', '.enc'), 'file');
    assert.equal(hatOutName('v2', '../../evil.sh.enc'), 'evil.sh');
});

test('v2 opens a small file and rejects a wrong password', async () => {
    const s = await sodium();
    const plain = text('hello from hat.sh');
    const sealed = await makeV2(s, plain, 'correct horse');
    const { data, size } = await openV2(s, sealed, 'correct horse');
    assert.deepEqual(data, plain);
    assert.equal(size, plain.length);
    await assert.rejects(openV2(s, sealed, 'Correct horse'), { code: 'wrong_password' });
});

test('v2 opens a file larger than one real 64 MiB chunk', async () => {
    const s = await sodium();
    const plain = random(HAT_CHUNK + 4321);
    const sealed = await makeV2(s, plain, 'pw');
    assert.equal(hatV2Layout(sealed.length).chunks, 2);
    const { data } = await openV2(s, sealed, 'pw');
    assert.equal(data.length, plain.length);
    assert.ok(Buffer.from(data).equals(Buffer.from(plain)));
});

test('v2 handles a file that is an exact number of chunks', async () => {
    const s = await sodium();
    const plain = random(3000);
    const sealed = await makeV2(s, plain, 'pw', 1000);
    assert.equal(hatV2Layout(sealed.length, 1000).chunks, 3);
    assert.deepEqual((await openV2(s, sealed, 'pw', 1000)).data, plain);
});

test('v2 catches cut-off, changed and reordered files', async () => {
    const s = await sodium();
    const plain = random(3500);
    const sealed = await makeV2(s, plain, 'pw', 1000);
    const full = 1000 + 17;
    const cut = sealed.slice(0, 51 + 3 * full);
    await assert.rejects(openV2(s, cut, 'pw', 1000), { code: 'incomplete' });
    const changed = sealed.slice();
    changed[51 + full + 5] ^= 1;
    await assert.rejects(openV2(s, changed, 'pw', 1000), { code: 'damaged' });
    const swapped = concat([sealed.slice(0, 51), sealed.slice(51 + full, 51 + 2 * full), sealed.slice(51, 51 + full), sealed.slice(51 + 2 * full)]);
    await assert.rejects(openV2(s, swapped, 'pw', 1000), { code: 'wrong_password' });
    await assert.rejects(openV2(s, sealed.slice(0, 60), 'pw', 1000), { code: 'incomplete' });
    const early = await makeV2(s, plain, 'pw', 1000, { finalEvery: true });
    await assert.rejects(openV2(s, early, 'pw', 1000), { code: 'extra_data' });
});

test('v1 opens files from both v1 settings', async () => {
    const plain = text('an old hat.sh file');
    for (const settings of [{ hash: 'SHA-512', iterations: 80000 }, { hash: 'SHA-256', iterations: 100000 }]) {
        const sealed = await makeV1(plain, 'old password', settings);
        assert.equal(hatKind(sealed), 'v1');
        assert.deepEqual(await openHatV1(subtle, sealed, 'old password'), plain);
    }
});

test('v1 uses the same password bytes as hat.sh, including accents', async () => {
    const plain = text('café');
    const sealed = await makeV1(plain, 'pässwörd');
    assert.deepEqual(await openHatV1(subtle, sealed, 'pässwörd'), plain);
});

test('v1 rejects a wrong password, a changed file and a cut-off file', async () => {
    const plain = text('an old hat.sh file');
    const sealed = await makeV1(plain, 'old password');
    await assert.rejects(openHatV1(subtle, sealed, 'wrong'), { code: 'wrong_password' });
    const changed = sealed.slice();
    changed[60] ^= 1;
    await assert.rejects(openHatV1(subtle, changed, 'old password'), { code: 'wrong_password' });
    await assert.rejects(openHatV1(subtle, sealed.slice(0, 60), 'old password'), { code: 'incomplete' });
});

async function openKeyPair(s, bytes, privateKey, publicKey, chunk) {
    const opened = await prepareHatV2KeyPair(s, privateKey, publicKey, reader(bytes), bytes.length, chunk);
    const parts = [];
    for await (const { data } of opened.stream()) parts.push(data);
    return concat(parts);
}

test('v2 key-pair files open with the receiver private key and sender public key', async () => {
    const s = await sodium();
    const sender = makeKeys(s);
    const receiver = makeKeys(s);
    const plain = random(2500);
    const sealed = makeV2KeyPair(s, plain, sender.privateKey, receiver.publicKey, 1000);
    assert.equal(hatKind(sealed), 'v2-keypair');
    assert.deepEqual(await openKeyPair(s, sealed, receiver.privateKey, sender.publicKey, 1000), plain);
    const standard = (k) => k.replace(/-/g, '+').replace(/_/g, '/') + '=';
    assert.deepEqual(await openKeyPair(s, sealed, ` ${standard(receiver.privateKey)} `, standard(sender.publicKey), 1000), plain);
});

test('v2 key-pair files reject wrong, own and malformed keys', async () => {
    const s = await sodium();
    const sender = makeKeys(s);
    const receiver = makeKeys(s);
    const other = makeKeys(s);
    const sealed = makeV2KeyPair(s, text('secret'), sender.privateKey, receiver.publicKey);
    await assert.rejects(openKeyPair(s, sealed, receiver.privateKey, other.publicKey), { code: 'wrong_hat_keys' });
    await assert.rejects(openKeyPair(s, sealed, other.privateKey, sender.publicKey), { code: 'wrong_hat_keys' });
    await assert.rejects(openKeyPair(s, sealed, receiver.privateKey, receiver.publicKey), { code: 'hat_own_key' });
    await assert.rejects(openKeyPair(s, sealed, 'not a key', sender.publicKey), { code: 'bad_hat_key' });
    await assert.rejects(openKeyPair(s, sealed, receiver.privateKey, sender.publicKey.slice(0, 20)), { code: 'bad_hat_key' });
    const changed = sealed.slice();
    changed[40] ^= 1;
    await assert.rejects(openKeyPair(s, changed, receiver.privateKey, sender.publicKey), { code: 'wrong_hat_keys' });
});
