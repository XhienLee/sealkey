import { webcrypto } from 'node:crypto';
import { concat } from './helpers.mjs';
import { HAT_CHUNK } from '../js/hatsh.js';

const subtle = webcrypto.subtle;
const text = (s) => new TextEncoder().encode(s);

export async function makeV2(s, plain, password, chunk = HAT_CHUNK, { finalEvery = false } = {}) {
    const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
    const key = s.crypto_pwhash(
        s.crypto_secretstream_xchacha20poly1305_KEYBYTES, password, salt,
        s.crypto_pwhash_OPSLIMIT_INTERACTIVE, s.crypto_pwhash_MEMLIMIT_INTERACTIVE, s.crypto_pwhash_ALG_ARGON2ID13,
    );
    const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(key);
    const parts = [text('zDKO6XYXioc'), salt, header];
    const count = Math.max(1, Math.ceil(plain.length / chunk));
    for (let i = 0; i < count; i += 1) {
        const last = i === count - 1;
        const tag = last || finalEvery
            ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
        parts.push(s.crypto_secretstream_xchacha20poly1305_push(state, plain.subarray(i * chunk, (i + 1) * chunk), null, tag));
    }
    return concat(parts);
}

function str2ab(str) {
    const view = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i += 1) view[i] = str.charCodeAt(i);
    return view;
}

export async function makeV1(plain, password, { hash = 'SHA-512', iterations = 80000 } = {}) {
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(16));
    const base = await subtle.importKey('raw', str2ab(password), { name: 'PBKDF2' }, false, ['deriveKey']);
    const key = await subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: { name: hash } }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const body = new Uint8Array(await subtle.encrypt({ iv, name: 'AES-GCM' }, key, plain));
    return concat([text('Encrypted Using Hat.sh'), iv, salt, body]);
}

export function makeKeys(s) {
    const pair = s.crypto_kx_keypair();
    return { publicKey: s.to_base64(pair.publicKey), privateKey: s.to_base64(pair.privateKey) };
}

export function makeV2KeyPair(s, plain, senderPrivate, receiverPublic, chunk = HAT_CHUNK) {
    const csk = s.from_base64(senderPrivate);
    const keys = s.crypto_kx_client_session_keys(s.crypto_scalarmult_base(csk), csk, s.from_base64(receiverPublic));
    const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(keys.sharedTx);
    const parts = [text('hTWKbfoikeg'), header];
    const count = Math.max(1, Math.ceil(plain.length / chunk));
    for (let i = 0; i < count; i += 1) {
        const tag = i === count - 1
            ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
        parts.push(s.crypto_secretstream_xchacha20poly1305_push(state, plain.subarray(i * chunk, (i + 1) * chunk), null, tag));
    }
    return concat(parts);
}
