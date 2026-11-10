import { SealError, cleanName } from './format.js';

export const HAT_V2_PASSWORD = 'zDKO6XYXioc';
export const HAT_V2_KEYPAIR = 'hTWKbfoikeg';
export const HAT_V1 = 'Encrypted Using Hat.sh';
export const HAT_HEAD_BYTES = 22;
export const HAT_CHUNK = 64 * 1024 * 1024;
export const HAT_V1_MAX = 1024 * 1024 * 1024;

const ABYTES = 17;
const V2_SALT_AT = 11;
const V2_HEADER_AT = 27;
const V2_BODY_AT = 51;
const V1_IV_AT = 22;
const V1_SALT_AT = 38;
const V1_BODY_AT = 54;
const V1_TAG_BYTES = 16;
const V1_SETTINGS = [
    { hash: 'SHA-512', iterations: 80000 },
    { hash: 'SHA-256', iterations: 100000 },
];

function ascii(bytes, length) {
    if (bytes.length < length) return '';
    return String.fromCharCode(...bytes.subarray(0, length));
}

export function hatKind(head) {
    const start = ascii(head, 11);
    if (start === HAT_V2_PASSWORD) return 'v2';
    if (start === HAT_V2_KEYPAIR) return 'v2-keypair';
    if (ascii(head, HAT_HEAD_BYTES) === HAT_V1) return 'v1';
    return null;
}

export function isSealkey(head) {
    return ascii(head, 4) === 'SEAL';
}

export function hatOutName(kind, fileName) {
    let name = String(fileName);
    if (kind === 'v1') {
        name = name.replace(/^Encrypted-/, '');
    } else {
        name = name.replace(/\.enc$/i, '').replace(/ ?\(\d+\)$/, '');
    }
    return cleanName(name, 'file');
}

export function hatV2Layout(fileSize, chunk = HAT_CHUNK) {
    const body = fileSize - V2_BODY_AT;
    if (body < ABYTES) throw new SealError('incomplete');
    const full = chunk + ABYTES;
    const chunks = Math.ceil(body / full);
    const lastLength = body - (chunks - 1) * full;
    if (lastLength < ABYTES) throw new SealError('incomplete');
    return { chunks, full, plainSize: body - chunks * ABYTES };
}

export async function prepareHatV2(sodium, password, readAt, fileSize, chunk = HAT_CHUNK) {
    const layout = hatV2Layout(fileSize, chunk);
    const salt = await readAt(V2_SALT_AT, sodium.crypto_pwhash_SALTBYTES);
    const header = await readAt(V2_HEADER_AT, sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    const key = sodium.crypto_pwhash(
        sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
        password,
        salt,
        sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    let state;
    try {
        state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
    } catch {
        throw new SealError('wrong_password');
    }
    const FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

    async function pull(index) {
        const offset = V2_BODY_AT + index * layout.full;
        const data = await readAt(offset, Math.min(layout.full, fileSize - offset));
        let result = null;
        try {
            result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, data);
        } catch {
            result = null;
        }
        if (!result) throw new SealError(index === 0 ? 'wrong_password' : 'damaged');
        const last = index === layout.chunks - 1;
        if (result.tag === FINAL && !last) throw new SealError('extra_data');
        if (last && result.tag !== FINAL) throw new SealError('incomplete');
        return result.message;
    }

    const first = await pull(0);

    async function* stream() {
        let done = first.length;
        yield { data: first, done, final: layout.chunks === 1 };
        for (let index = 1; index < layout.chunks; index += 1) {
            const data = await pull(index);
            done += data.length;
            yield { data, done, final: index === layout.chunks - 1 };
        }
    }

    return { plainSize: layout.plainSize, stream };
}

function v1PasswordBytes(password) {
    const out = new Uint8Array(password.length);
    for (let i = 0; i < password.length; i += 1) out[i] = password.charCodeAt(i);
    return out;
}

export async function openHatV1(subtle, bytes, password) {
    if (bytes.length < V1_BODY_AT + V1_TAG_BYTES) throw new SealError('incomplete');
    const iv = bytes.slice(V1_IV_AT, V1_SALT_AT);
    const salt = bytes.slice(V1_SALT_AT, V1_BODY_AT);
    const body = bytes.subarray(V1_BODY_AT);
    const base = await subtle.importKey('raw', v1PasswordBytes(password), { name: 'PBKDF2' }, false, ['deriveKey']);
    for (const { hash, iterations } of V1_SETTINGS) {
        const key = await subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations, hash: { name: hash } },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt'],
        );
        try {
            return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, body));
        } catch {
        }
    }
    throw new SealError('wrong_password');
}
