import { WORDS } from './words.js';
import { makeKeyWords, normalizeKey, isKeyValid } from './key.js';
import { SealError, PUBLIC_KEY_BYTES } from './format.js';

export const SECRET_WORDS = 12;
export const FINGERPRINT_WORDS = 6;
export const PUBLIC_PREFIX = 'sealkey-pub-';

const SALT = new TextEncoder().encode('sealkey keypair1');
const FINGERPRINT_LABEL = new TextEncoder().encode('Sealkey fingerprint v1');
const CHECK_BYTES = 4;
const PASSES = 3;
const MEM_BYTES = 64 * 1024 * 1024;

export function makeSecretWords() {
    return makeKeyWords(SECRET_WORDS);
}

export function secretWordsValid(text) {
    return isKeyValid(normalizeKey(text), SECRET_WORDS);
}

export function deriveKeyPair(sodium, text) {
    const normalized = normalizeKey(text);
    if (!isKeyValid(normalized, SECRET_WORDS)) throw new SealError('bad_secret_words');
    let secretKey;
    try {
        secretKey = sodium.crypto_pwhash(32, normalized, SALT, PASSES, MEM_BYTES, sodium.crypto_pwhash_ALG_ARGON2ID13);
    } catch (error) {
        throw new SealError('out_of_memory', String(error && error.message || error));
    }
    return { secretKey, publicKey: sodium.crypto_scalarmult_base(secretKey) };
}

function check(sodium, publicKey) {
    return sodium.crypto_generichash(CHECK_BYTES, publicKey);
}

export function encodePublicKey(sodium, publicKey) {
    const body = new Uint8Array(PUBLIC_KEY_BYTES + CHECK_BYTES);
    body.set(publicKey, 0);
    body.set(check(sodium, publicKey), PUBLIC_KEY_BYTES);
    return PUBLIC_PREFIX + sodium.to_base64(body, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function parsePublicKey(sodium, text) {
    const clean = String(text).replace(/\s+/g, '');
    if (!clean.startsWith(PUBLIC_PREFIX)) throw new SealError('bad_public_key');
    let body;
    try {
        body = sodium.from_base64(clean.slice(PUBLIC_PREFIX.length), sodium.base64_variants.URLSAFE_NO_PADDING);
    } catch {
        throw new SealError('bad_public_key');
    }
    if (body.length !== PUBLIC_KEY_BYTES + CHECK_BYTES) throw new SealError('bad_public_key');
    const publicKey = body.slice(0, PUBLIC_KEY_BYTES);
    if (!sodium.memcmp(check(sodium, publicKey), body.slice(PUBLIC_KEY_BYTES))) throw new SealError('bad_public_key');
    if (publicKey.every((byte) => byte === 0)) throw new SealError('bad_public_key');
    return publicKey;
}

export function fingerprint(sodium, publicKey) {
    const hash = sodium.crypto_generichash(32, publicKey, FINGERPRINT_LABEL);
    const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
    const out = [];
    for (let i = 0; i < FINGERPRINT_WORDS; i += 1) out.push(WORDS[view.getUint32(i * 4, true) % WORDS.length]);
    return out;
}
