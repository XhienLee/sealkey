import sodiumModule from '../vendor/libsodium/libsodium-wrappers.mjs';
import { HEADER_BYTES, SealError, parseHeader } from '../js/format.js';
import { createSealer, sealStream, createOpener, openMeta, unsealStream, META_CIPHER_BYTES } from '../js/core.js';

export const FAST = Object.freeze({ passes: 1, memKiB: 64, chunkBytes: 1024 });

export async function sodium() {
    await sodiumModule.ready;
    return sodiumModule;
}

export function concat(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export async function* pieces(bytes, size = 777) {
    for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

export async function lockBytes(plain, { keyText = 'tiger-mango-velvet-cloud-pebble-lantern', params = FAST, meta } = {}) {
    const s = await sodium();
    const fullMeta = meta ?? { kind: 1, count: 1, name: 'file.bin', size: plain.length };
    const sealer = createSealer(s, { keyText, meta: fullMeta, params });
    const parts = [];
    for await (const { data } of sealStream(sealer, pieces(plain), plain.length)) parts.push(data);
    const out = concat(parts);
    if (out.length !== sealer.size) throw new Error(`size ${out.length} != ${sealer.size}`);
    return out;
}

export async function openBytes(bytes, keyText = 'tiger-mango-velvet-cloud-pebble-lantern') {
    const s = await sodium();
    const header = parseHeader(bytes.subarray(0, HEADER_BYTES));
    const state = createOpener(s, { keyText, header });
    const meta = openMeta(s, state, header, bytes.slice(HEADER_BYTES, HEADER_BYTES + META_CIPHER_BYTES));
    const parts = [];
    const readAt = async (offset, length) => bytes.slice(offset, offset + length);
    for await (const { data } of unsealStream(s, state, readAt, bytes.length, header, meta)) parts.push(data);
    return { meta, data: concat(parts) };
}

export async function errorCode(promise) {
    try {
        await promise;
    } catch (error) {
        if (error instanceof SealError) return error.code;
        throw error;
    }
    return 'no error';
}
