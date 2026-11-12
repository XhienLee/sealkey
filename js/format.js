export const MAGIC = 'SEAL';
export const VERSION = 1;
export const KDF_ARGON2ID = 1;
export const KDF_X25519 = 2;
export const HEADER_BYTES = 58;
export const KEY_HEADER_BYTES = 90;
export const PUBLIC_KEY_BYTES = 32;
export const META_BYTES = 512;
export const SS_HEADER_BYTES = 24;
export const SS_ABYTES = 17;
export const SALT_BYTES = 16;
export const NAME_MAX_BYTES = 255;
export const KIND_FILE = 1;
export const KIND_BUNDLE = 2;
export const MAX_BUNDLE_FILES = 10000;

export const DEFAULTS = Object.freeze({
    passes: 3,
    memKiB: 65536,
    chunkBytes: 1048576,
});

export const LIMITS = Object.freeze({
    maxPasses: 10,
    maxMemKiB: 524288,
    maxChunkBytes: 16777216,
    minMemKiB: 8,
    minChunkBytes: 1024,
});

export class SealError extends Error {
    constructor(code, detail = '') {
        super(code);
        this.code = code;
        this.detail = detail;
    }
}

export function encodeHeader({ passes, memKiB, chunkBytes, salt, ssHeader, ephemeral = null }) {
    if (salt.length !== SALT_BYTES || ssHeader.length !== SS_HEADER_BYTES) throw new Error('header fields');
    if (ephemeral && ephemeral.length !== PUBLIC_KEY_BYTES) throw new Error('header fields');
    const out = new Uint8Array(ephemeral ? KEY_HEADER_BYTES : HEADER_BYTES);
    const view = new DataView(out.buffer);
    out.set(new TextEncoder().encode(MAGIC), 0);
    out[4] = VERSION;
    out[5] = ephemeral ? KDF_X25519 : KDF_ARGON2ID;
    view.setUint32(6, ephemeral ? 0 : passes, true);
    view.setUint32(10, ephemeral ? 0 : memKiB, true);
    view.setUint32(14, chunkBytes, true);
    out.set(salt, 18);
    out.set(ssHeader, 34);
    if (ephemeral) out.set(ephemeral, HEADER_BYTES);
    return out;
}

export function parseHeader(bytes) {
    if (bytes.length < HEADER_BYTES) throw new SealError('not_locked');
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new SealError('not_locked');
    if (bytes[4] > VERSION) throw new SealError('newer_version');
    const kdf = bytes[5];
    if (bytes[4] !== VERSION || (kdf !== KDF_ARGON2ID && kdf !== KDF_X25519)) throw new SealError('unsafe_header');
    const size = kdf === KDF_X25519 ? KEY_HEADER_BYTES : HEADER_BYTES;
    if (bytes.length < size) throw new SealError('incomplete');
    const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
    const passes = view.getUint32(6, true);
    const memKiB = view.getUint32(10, true);
    const chunkBytes = view.getUint32(14, true);
    if (kdf === KDF_ARGON2ID) {
        if (passes < 1 || passes > LIMITS.maxPasses) throw new SealError('unsafe_header');
        if (memKiB < LIMITS.minMemKiB || memKiB > LIMITS.maxMemKiB) throw new SealError('unsafe_header');
    } else if (passes !== 0 || memKiB !== 0) {
        throw new SealError('unsafe_header');
    }
    if (chunkBytes < LIMITS.minChunkBytes || chunkBytes > LIMITS.maxChunkBytes) throw new SealError('unsafe_header');
    return {
        bytes: bytes.slice(0, size),
        size,
        kdf,
        passes,
        memKiB,
        chunkBytes,
        salt: bytes.slice(18, 34),
        ssHeader: bytes.slice(34, 58),
        ephemeral: kdf === KDF_X25519 ? bytes.slice(HEADER_BYTES, KEY_HEADER_BYTES) : null,
    };
}

export function utf8Cut(text, maxBytes) {
    const encoder = new TextEncoder();
    let out = '';
    let used = 0;
    for (const char of text) {
        const size = encoder.encode(char).length;
        if (used + size > maxBytes) break;
        out += char;
        used += size;
    }
    return out;
}

export function encodeMeta({ kind, count, name, size }) {
    const out = new Uint8Array(META_BYTES);
    const view = new DataView(out.buffer);
    const nameBytes = new TextEncoder().encode(utf8Cut(name, NAME_MAX_BYTES));
    out[0] = kind;
    view.setUint32(1, count, true);
    view.setUint16(5, nameBytes.length, true);
    out.set(nameBytes, 7);
    view.setBigUint64(262, BigInt(size), true);
    return out;
}

export function parseMeta(bytes) {
    if (bytes.length !== META_BYTES) throw new SealError('unsafe_meta');
    const view = new DataView(bytes.buffer, bytes.byteOffset, META_BYTES);
    const kind = bytes[0];
    const count = view.getUint32(1, true);
    const nameLength = view.getUint16(5, true);
    const size = view.getBigUint64(262, true);
    if (kind !== KIND_FILE && kind !== KIND_BUNDLE) throw new SealError('unsafe_meta');
    if (kind === KIND_FILE && count !== 1) throw new SealError('unsafe_meta');
    if (kind === KIND_BUNDLE && (count < 2 || count > MAX_BUNDLE_FILES)) throw new SealError('unsafe_meta');
    if (nameLength > NAME_MAX_BYTES) throw new SealError('unsafe_meta');
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new SealError('unsafe_meta');
    let name;
    try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(7, 7 + nameLength));
    } catch {
        throw new SealError('unsafe_meta');
    }
    return { kind, count, name, size: Number(size) };
}

export function chunkCount(size, chunkBytes) {
    return Math.max(1, Math.ceil(size / chunkBytes));
}

export function lockedSize(size, chunkBytes, headerBytes = HEADER_BYTES) {
    return headerBytes + META_BYTES + SS_ABYTES + size + SS_ABYTES * chunkCount(size, chunkBytes);
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f<>:"|?*\\]/g;

export function cleanPart(part) {
    let clean = part.normalize('NFC').replace(UNSAFE, '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    clean = Array.from(clean).slice(0, 200).join('');
    return clean;
}

export function cleanName(name, fallback = 'file') {
    const base = String(name).split(/[\\/]/).pop() ?? '';
    return cleanPart(base) || fallback;
}

export function cleanPath(path) {
    return String(path).split(/[\\/]/).map(cleanPart).filter((part) => part !== '').join('/');
}
