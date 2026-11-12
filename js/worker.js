import sodiumModule from '../vendor/libsodium/libsodium-wrappers.mjs';
import { makeZip, predictLength } from '../vendor/client-zip/index.js';
import {
    KEY_HEADER_BYTES, KDF_X25519, KIND_FILE, KIND_BUNDLE, MAX_BUNDLE_FILES, SealError, parseHeader, cleanName,
} from './format.js';
import { createSealer, sealStream, createOpener, openMeta, checkLength, unsealStream, META_CIPHER_BYTES } from './core.js';
import { HAT_HEAD_BYTES, HAT_V1_MAX, hatKind, prepareHatV2, prepareHatV2KeyPair, openHatV1 } from './hatsh.js';
import { makeSecretWords, deriveKeyPair, encodePublicKey, parsePublicKey, fingerprint } from './keypair.js';

const READ_BYTES = 4 * 1048576;
const ready = sodiumModule.ready.then(() => sodiumModule);
let job = null;
let release = null;
let currentId = 0;
let cancelledId = -1;

function reply(message) {
    postMessage({ ...message, id: currentId });
}

function checkCancelled(id) {
    if (cancelledId === id) throw new SealError('cancelled');
}

function fail(error) {
    let code = 'unknown';
    let detail = '';
    if (error instanceof SealError) {
        code = error.code;
        detail = error.detail;
    } else if (error && (error.name === 'NotReadableError' || error.name === 'NotFoundError')) {
        code = 'unreadable';
    } else if (error instanceof RangeError || /memory/i.test(String(error && error.message))) {
        code = 'out_of_memory';
    }
    if (code === 'changed') code = 'unreadable';
    job = null;
    if (code !== 'cancelled') reply({ type: 'error', code, detail });
}

async function readAt(file, offset, length) {
    try {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    } catch {
        throw new SealError('unreadable', file.name);
    }
}

async function* fileSource(file, onFile) {
    if (onFile) onFile();
    for (let offset = 0; offset < file.size; offset += READ_BYTES) {
        yield await readAt(file, offset, READ_BYTES);
    }
}

async function* streamSource(stream) {
    const reader = stream.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

function send(data, id) {
    checkCancelled(id);
    const out = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    return new Promise((resolve) => {
        release = resolve;
        postMessage({ type: 'out', data: out, id: currentId }, [out.buffer]);
    });
}

async function prepareLock({ items, keyText, recipientText, zipName }) {
    const sodium = await ready;
    if (items.length === 0) throw new SealError('unreadable');
    if (items.length > MAX_BUNDLE_FILES) throw new SealError('too_many_files');
    const progress = { index: 0, name: '' };
    let meta;
    let source;
    if (items.length === 1) {
        const { file } = items[0];
        meta = { kind: KIND_FILE, count: 1, name: cleanName(file.name), size: file.size };
        source = () => fileSource(file, () => { progress.index = 1; progress.name = file.name; });
    } else {
        const listing = items.map(({ file, path }) => ({ name: path, size: file.size }));
        const size = Number(predictLength(listing));
        meta = { kind: KIND_BUNDLE, count: items.length, name: zipName, size };
        source = () => {
            const entries = items.map(({ file, path }, i) => ({
                name: path,
                size: file.size,
                lastModified: new Date(file.lastModified || Date.now()),
                input: fileSource(file, () => { progress.index = i + 1; progress.name = path; }),
            }));
            return streamSource(makeZip(entries));
        };
    }
    const recipient = recipientText ? parsePublicKey(sodium, recipientText) : null;
    const sealer = createSealer(sodium, recipient ? { recipient, meta } : { keyText, meta });
    checkCancelled(currentId);
    job = { id: currentId, kind: 'lock', sealer, source, meta, progress, count: items.length };
    reply({ type: 'prepared', outSize: sealer.size, meta: { ...meta } });
}

async function runLock() {
    const { sealer, source, meta, progress, count } = job;
    let last = 0;
    try {
        await pumpLock(sealer, source, meta, progress, count, last, job.id);
    } catch (error) {
        if (error instanceof SealError && !error.detail) error.detail = progress.name;
        throw error;
    }
    job = null;
    reply({ type: 'done' });
}

async function pumpLock(sealer, source, meta, progress, count, last, id) {
    for await (const { data, done } of sealStream(sealer, source(), meta.size)) {
        const now = Date.now();
        if (now - last > 80 || done === meta.size) {
            last = now;
            reply({ type: 'progress', done, total: meta.size, index: progress.index, count, name: progress.name });
        }
        await send(data, id);
        checkCancelled(id);
    }
}

async function inspect({ file }) {
    const header = parseHeader(await readAt(file, 0, KEY_HEADER_BYTES));
    if (file.size < header.size + META_CIPHER_BYTES) throw new SealError('incomplete');
    reply({ type: 'header-ok', header: { kdf: header.kdf, passes: header.passes, memKiB: header.memKiB, chunkBytes: header.chunkBytes } });
}

async function prepareOpen({ file, keyText }) {
    const sodium = await ready;
    const header = parseHeader(await readAt(file, 0, KEY_HEADER_BYTES));
    let state;
    if (header.kdf === KDF_X25519) {
        const { secretKey } = deriveKeyPair(sodium, keyText);
        try {
            state = createOpener(sodium, { secretKey, header });
        } finally {
            sodium.memzero(secretKey);
        }
    } else {
        state = createOpener(sodium, { keyText, header });
    }
    checkCancelled(currentId);
    const meta = openMeta(sodium, state, header, await readAt(file, header.size, META_CIPHER_BYTES));
    checkLength(file.size, meta, header);
    job = { id: currentId, kind: 'open', sodium, state, header, meta, file };
    reply({ type: 'meta', meta });
}

async function runOpen() {
    const { id, sodium, state, header, meta, file } = job;
    let last = 0;
    const stream = unsealStream(sodium, state, (offset, length) => readAt(file, offset, length), file.size, header, meta);
    for await (const { data, done, final } of stream) {
        checkCancelled(id);
        const now = Date.now();
        if (now - last > 80 || final) {
            last = now;
            reply({ type: 'progress', done, total: meta.size });
        }
        await send(data, id);
    }
    job = null;
    reply({ type: 'done' });
}

async function makeKeyPair({ words }) {
    const sodium = await ready;
    const secretWords = words || makeSecretWords().join('-');
    const { secretKey, publicKey } = deriveKeyPair(sodium, secretWords);
    sodium.memzero(secretKey);
    reply({
        type: 'keypair',
        words: words ? null : secretWords.split('-'),
        publicKey: encodePublicKey(sodium, publicKey),
        fingerprint: fingerprint(sodium, publicKey),
    });
}

async function checkPublic({ text }) {
    const sodium = await ready;
    reply({ type: 'public-ok', fingerprint: fingerprint(sodium, parsePublicKey(sodium, text)) });
}

async function prepareHat({ file, password, privateKey, publicKey }) {
    const kind = hatKind(await readAt(file, 0, HAT_HEAD_BYTES));
    const read = (offset, length) => readAt(file, offset, length);
    if (kind === 'v2' || kind === 'v2-keypair') {
        const sodium = await ready;
        const opened = kind === 'v2'
            ? await prepareHatV2(sodium, password, read, file.size)
            : await prepareHatV2KeyPair(sodium, privateKey, publicKey, read, file.size);
        job = { id: currentId, kind: 'hat', size: opened.plainSize, stream: opened.stream() };
    } else if (kind === 'v1') {
        if (file.size > HAT_V1_MAX) throw new SealError('too_large');
        const data = await openHatV1(crypto.subtle, await readAt(file, 0, file.size), password);
        job = { id: currentId, kind: 'hat', size: data.length, stream: pieces(data) };
    } else {
        throw new SealError('not_hat');
    }
    reply({ type: 'hat-ready', size: job.size, version: kind });
}

async function* pieces(data) {
    if (data.length === 0) yield { data, done: 0, final: true };
    for (let offset = 0; offset < data.length; offset += READ_BYTES) {
        const end = Math.min(offset + READ_BYTES, data.length);
        yield { data: data.subarray(offset, end), done: end, final: end === data.length };
    }
}

async function runHat() {
    const { id, size, stream } = job;
    let last = 0;
    for await (const { data, done, final } of stream) {
        checkCancelled(id);
        const now = Date.now();
        if (now - last > 80 || final) {
            last = now;
            reply({ type: 'progress', done, total: size });
        }
        await send(data, id);
    }
    job = null;
    reply({ type: 'done' });
}

onmessage = async ({ data: message }) => {
    try {
        if (message.type === 'ack' || message.type === 'cancel') {
            if (message.type === 'cancel') cancelledId = message.id;
            const resolve = release;
            release = null;
            if (resolve) resolve();
            return;
        }
        currentId = message.id;
        if (message.type === 'start' && cancelledId === message.id) return;
        if (message.type === 'lock-prepare') {
            await prepareLock(message);
        } else if (message.type === 'inspect') {
            await inspect(message);
        } else if (message.type === 'open-prepare') {
            await prepareOpen(message);
        } else if (message.type === 'hat-prepare') {
            await prepareHat(message);
        } else if (message.type === 'make-keypair') {
            await makeKeyPair(message);
        } else if (message.type === 'check-public') {
            await checkPublic(message);
        } else if (message.type === 'start') {
            if (!job) throw new SealError('unknown');
            await (job.kind === 'lock' ? runLock() : job.kind === 'hat' ? runHat() : runOpen());
        }
    } catch (error) {
        fail(error);
    }
};

ready.catch((error) => fail(error));
