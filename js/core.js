import {
    DEFAULTS, META_BYTES, SS_ABYTES, SALT_BYTES, KDF_X25519, PUBLIC_KEY_BYTES,
    SealError, encodeHeader, encodeMeta, parseMeta, lockedSize, chunkCount,
} from './format.js';

const KX_LABEL = new TextEncoder().encode('Sealkey X25519 file key v1');

function deriveKey(sodium, keyText, salt, passes, memKiB) {
    try {
        return sodium.crypto_pwhash(32, keyText, salt, passes, memKiB * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
    } catch (error) {
        throw new SealError('out_of_memory', String(error && error.message || error));
    }
}

function fileKeyFromShared(sodium, shared, ephemeral, recipient, salt) {
    const input = new Uint8Array(KX_LABEL.length + shared.length + ephemeral.length + recipient.length);
    input.set(KX_LABEL, 0);
    input.set(shared, KX_LABEL.length);
    input.set(ephemeral, KX_LABEL.length + shared.length);
    input.set(recipient, KX_LABEL.length + shared.length + ephemeral.length);
    try {
        return sodium.crypto_generichash(32, input, salt);
    } finally {
        sodium.memzero(input);
        sodium.memzero(shared);
    }
}

function sharedSecret(sodium, secretKey, publicKey) {
    try {
        return sodium.crypto_scalarmult(secretKey, publicKey);
    } catch {
        throw new SealError('bad_public_key');
    }
}

export function createSealer(sodium, { keyText, recipient = null, meta, params = DEFAULTS }) {
    const salt = sodium.randombytes_buf(SALT_BYTES);
    let ephemeral = null;
    let key;
    if (recipient) {
        if (recipient.length !== PUBLIC_KEY_BYTES) throw new SealError('bad_public_key');
        const pair = sodium.crypto_box_keypair();
        ephemeral = pair.publicKey;
        try {
            key = fileKeyFromShared(sodium, sharedSecret(sodium, pair.privateKey, recipient), ephemeral, recipient, salt);
        } finally {
            sodium.memzero(pair.privateKey);
        }
    } else {
        key = deriveKey(sodium, keyText, salt, params.passes, params.memKiB);
    }
    let state;
    let ssHeader;
    try {
        ({ state, header: ssHeader } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key));
    } finally {
        sodium.memzero(key);
    }
    const header = encodeHeader({ ...params, salt, ssHeader, ephemeral });
    const metaCipher = sodium.crypto_secretstream_xchacha20poly1305_push(
        state, encodeMeta(meta), header, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
    return {
        params,
        size: lockedSize(meta.size, params.chunkBytes, header.length),
        prefix() {
            const out = new Uint8Array(header.length + metaCipher.length);
            out.set(header, 0);
            out.set(metaCipher, header.length);
            return out;
        },
        push(data, final) {
            const tag = final
                ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
                : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
            return sodium.crypto_secretstream_xchacha20poly1305_push(state, data, null, tag);
        },
    };
}

export async function* rechunk(source, total, chunkBytes) {
    let buffer = new Uint8Array(chunkBytes);
    let fill = 0;
    let seen = 0;
    for await (const raw of source) {
        const piece = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        let pos = 0;
        while (pos < piece.length) {
            const take = Math.min(chunkBytes - fill, piece.length - pos);
            buffer.set(piece.subarray(pos, pos + take), fill);
            fill += take;
            pos += take;
            seen += take;
            if (seen > total) throw new SealError('changed');
            if (fill === chunkBytes) {
                yield { data: buffer, final: seen === total };
                buffer = new Uint8Array(chunkBytes);
                fill = 0;
            }
        }
    }
    if (seen !== total) throw new SealError('changed');
    if (total === 0) yield { data: new Uint8Array(0), final: true };
    else if (fill > 0) yield { data: buffer.subarray(0, fill), final: true };
}

export async function* sealStream(sealer, source, total) {
    yield { data: sealer.prefix(), done: 0 };
    let done = 0;
    for await (const { data, final } of rechunk(source, total, sealer.params.chunkBytes)) {
        done += data.length;
        yield { data: sealer.push(data, final), done };
    }
}

export function createOpener(sodium, { keyText = null, secretKey = null, header }) {
    let key;
    if (header.kdf === KDF_X25519) {
        if (!secretKey) throw new SealError('needs_secret_words');
        const recipient = sodium.crypto_scalarmult_base(secretKey);
        key = fileKeyFromShared(sodium, sharedSecret(sodium, secretKey, header.ephemeral), header.ephemeral, recipient, header.salt);
    } else {
        if (keyText === null) throw new SealError('needs_key');
        key = deriveKey(sodium, keyText, header.salt, header.passes, header.memKiB);
    }
    try {
        return sodium.crypto_secretstream_xchacha20poly1305_init_pull(header.ssHeader, key);
    } catch {
        throw new SealError('wrong_key');
    } finally {
        sodium.memzero(key);
    }
}

export const META_CIPHER_BYTES = META_BYTES + SS_ABYTES;

export function openMeta(sodium, state, header, metaCipher) {
    if (metaCipher.length !== META_CIPHER_BYTES) throw new SealError('incomplete');
    let result;
    try {
        result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, metaCipher, header.bytes);
    } catch {
        result = null;
    }
    if (!result) throw new SealError('wrong_key');
    if (result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) throw new SealError('damaged');
    return parseMeta(result.message);
}

export function checkLength(fileSize, meta, header) {
    const expected = lockedSize(meta.size, header.chunkBytes, header.size);
    if (fileSize < expected) throw new SealError('incomplete');
    if (fileSize > expected) throw new SealError('extra_data');
}

export async function* unsealStream(sodium, state, readAt, fileSize, header, meta) {
    checkLength(fileSize, meta, header);
    const chunkBytes = header.chunkBytes;
    const total = chunkCount(meta.size, chunkBytes);
    let offset = header.size + META_CIPHER_BYTES;
    let done = 0;
    for (let index = 0; index < total; index++) {
        const plainLength = Math.min(chunkBytes, meta.size - done);
        const cipher = await readAt(offset, plainLength + SS_ABYTES);
        if (cipher.length !== plainLength + SS_ABYTES) throw new SealError('incomplete');
        let result;
        try {
            result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, cipher, null);
        } catch {
            result = null;
        }
        if (!result || result.message.length !== plainLength) throw new SealError('damaged');
        const last = index === total - 1;
        const isFinal = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
        if (isFinal !== last) throw new SealError('damaged');
        offset += cipher.length;
        done += plainLength;
        yield { data: result.message, done, final: last };
    }
    if (offset !== fileSize) throw new SealError('extra_data');
}
