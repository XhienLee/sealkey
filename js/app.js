import { makeKeyWords, normalizeKey, isKeyValid, countKeyParts, wordlistOk, KEY_WORDS } from './key.js';
import { lockedSize, cleanName, MAX_BUNDLE_FILES, DEFAULTS, KIND_BUNDLE } from './format.js';
import { openSink, sizeLimit, canStream, isMobile, formatSize } from './save.js';
import { fromFileList, fromDrop, addItems, zipName } from './bundle.js';
import { predictLength } from '../vendor/client-zip/index.js';

const MESSAGES = {
    bad_key_format: `Check your key. It should be ${KEY_WORDS} words.`,
    not_locked: "This isn't a locked file.",
    newer_version: 'This file was made by a newer version. Refresh the page and try again.',
    unsafe_header: "This file can't be opened safely.",
    unsafe_meta: "This file can't be opened safely.",
    wrong_key: 'Wrong key, or the file was changed.',
    damaged: 'The key is right, but the file is damaged. Ask for it again.',
    incomplete: 'This file is incomplete. Ask for it again.',
    extra_data: 'This file was changed. Ask for it again.',
    too_large: 'This file is too large for this browser. Try Chrome or Edge on a computer.',
    bundle_too_large: 'These files are too large together for this browser. Lock fewer files at a time, or try Chrome or Edge on a computer.',
    too_many_files: `You can lock up to ${MAX_BUNDLE_FILES.toLocaleString('en-US')} files at once. Choose fewer files, or ZIP some of them first.`,
    unreadable: "We couldn't read {name}. It may have been moved or deleted. Nothing was saved.",
    out_of_memory: 'Your device ran out of memory. Try a computer.',
    cancelled: 'Cancelled. Nothing was saved.',
    save_failed: "Saving didn't finish, so nothing was saved. Check there's enough space and try again.",
    no_files: 'Choose at least one file.',
    unknown: 'Something went wrong, so nothing was saved. Please try again.',
};

const $ = (id) => document.getElementById(id);
const LIST_SHOWN = 50;

let worker = null;
let jobId = 0;
let handlers = {};
let sink = null;
let busy = false;
let view = 'home';
let lock = { items: [], words: [], outName: '', meta: null };
let open = { file: null, meta: null };

function message(code, detail = '') {
    return (MESSAGES[code] || MESSAGES.unknown).replace('{name}', detail || 'a file');
}

function newWorker() {
    if (worker) worker.terminate();
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
        if (data.id !== jobId) return;
        const handler = handlers[data.type];
        if (handler) handler(data);
    };
    worker.onerror = () => handlers.error && handlers.error({ code: 'unknown' });
}

function on(map) {
    handlers = map;
}

function post(data) {
    worker.postMessage({ ...data, id: jobId });
}

function setAlert(id, text) {
    const el = $(id);
    el.textContent = text;
    el.hidden = !text;
}

function showStep(viewId, step) {
    const section = $(viewId);
    for (const el of section.querySelectorAll('[data-step]')) el.hidden = el.dataset.step !== step;
    const shown = section.querySelector(`[data-step="${step}"] h1`);
    if (shown) shown.focus({ preventScroll: false });
}

function go(next) {
    if (busy && !confirm('Stop and discard this job?')) return;
    if (!busy && lock.words.length && !confirm("Leave without your key? You won't see it again, and the file can't be opened without it.")) return;
    stopJob();
    view = next;
    for (const name of ['home', 'lock', 'open']) $(`view-${name}`).hidden = name !== next;
    document.querySelector('.back').hidden = next === 'home';
    if (next === 'lock') resetLock();
    if (next === 'open') resetOpen();
    if (next === 'home') $('home-title').focus();
    window.scrollTo(0, 0);
}

async function stopJob() {
    busy = false;
    worker.postMessage({ type: 'cancel', id: jobId });
    jobId += 1;
    handlers = {};
    if (sink) {
        const old = sink;
        sink = null;
        await old.abort();
    }
}

function pipeOutput() {
    return {
        out: async ({ data }) => {
            try {
                await sink.write(data);
                post({ type: 'ack' });
            } catch {
                handlers.error({ code: 'save_failed' });
            }
        },
    };
}

function setBars(n) {
    document.querySelectorAll('[data-bar]').forEach((bar) => bar.classList.toggle('on', Number(bar.dataset.bar) <= n));
}

function clearKeyDisplay() {
    lock.words = [];
    $('lock-key').replaceChildren();
    $('key-saved').checked = false;
    $('lock-finish').disabled = true;
    $('key-saved-hint').hidden = false;
}

function resetLock(alertText = '') {
    clearKeyDisplay();
    lock = { items: [], words: [], outName: '', meta: null };
    renderList();
    setAlert('lock-alert', alertText);
    setBars(1);
    showStep('view-lock', 'pick');
}

function renderList() {
    const items = lock.items;
    const list = $('lock-list');
    list.replaceChildren();
    $('lock-list-wrap').hidden = items.length === 0;
    if (items.length === 0) return;
    for (const item of items.slice(0, LIST_SHOWN)) {
        const li = document.createElement('li');
        li.className = 'list-item';
        const text = document.createElement('span');
        text.className = 'list-text';
        const name = document.createElement('span');
        name.className = 'list-name';
        name.textContent = item.path;
        const size = document.createElement('span');
        size.className = 'muted small';
        size.textContent = formatSize(item.file.size);
        text.append(name, size);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'icon-btn';
        remove.setAttribute('aria-label', `Remove ${item.path}`);
        remove.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        remove.addEventListener('click', () => {
            lock.items = lock.items.filter((other) => other.id !== item.id);
            renderList();
            ($('lock-list').querySelector('button') || $('lock-files-btn')).focus();
        });
        li.append(text, remove);
        list.append(li);
    }
    const more = items.length - LIST_SHOWN;
    $('lock-more').hidden = more <= 0;
    $('lock-more').textContent = more > 0 ? `and ${more.toLocaleString('en-US')} more` : '';
    const total = items.reduce((sum, item) => sum + item.file.size, 0);
    $('lock-count').textContent = items.length === 1 ? '1 file' : `${items.length.toLocaleString('en-US')} files`;
    $('lock-total').textContent = `${formatSize(total)} total`;
    $('lock-bundle-note').hidden = items.length < 2;
    $('lock-btn').textContent = items.length === 1 ? 'Lock this file' : `Lock ${items.length.toLocaleString('en-US')} files`;
}

function addToLock(incoming) {
    setAlert('lock-alert', '');
    if (incoming.length === 0) return;
    if (lock.items.length + incoming.length > MAX_BUNDLE_FILES) {
        setAlert('lock-alert', message('too_many_files'));
        return;
    }
    lock.items = addItems(lock.items, incoming);
    renderList();
}

function plannedSize(items) {
    if (items.length === 1) return lockedSize(items[0].file.size, DEFAULTS.chunkBytes);
    const size = Number(predictLength(items.map(({ file, path }) => ({ name: path, size: file.size }))));
    return lockedSize(size, DEFAULTS.chunkBytes);
}

function randomName() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return `locked-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}.seal`;
}

function startLock() {
    const items = lock.items;
    if (items.length === 0) return setAlert('lock-alert', message('no_files'));
    if (items.length > MAX_BUNDLE_FILES) return setAlert('lock-alert', message('too_many_files'));
    if (plannedSize(items) > sizeLimit()) return setAlert('lock-alert', message(items.length > 1 ? 'bundle_too_large' : 'too_large'));
    setAlert('lock-alert', '');
    lock.words = makeKeyWords();
    lock.outName = randomName();
    busy = true;
    showStep('view-lock', 'prepare');
    on({
        prepared: ({ outSize, meta }) => {
            lock.meta = meta;
            $('lock-out-name').textContent = lock.outName;
            $('lock-out-size').textContent = `${formatSize(outSize)} · ${meta.count === 1 ? '1 file' : `${meta.count.toLocaleString('en-US')} files`}`;
            setBars(2);
            showStep('view-lock', 'save');
        },
        error: lockFailed,
    });
    post({
        type: 'lock-prepare',
        items: items.map(({ file, path }) => ({ file, path })),
        keyText: lock.words.join('-'),
        zipName: zipName(items),
    });
}

async function saveLock() {
    try {
        sink = await openSink(lock.outName);
    } catch (error) {
        if (error && error.name === 'AbortError') return;
        return lockFailed({ code: 'save_failed' });
    }
    const total = lock.meta.size;
    $('lock-bar').value = 0;
    $('lock-pct').textContent = '0%';
    $('lock-done').textContent = `0 B of ${formatSize(total)}`;
    $('lock-phase').textContent = '';
    showStep('view-lock', 'progress');
    on({
        ...pipeOutput(),
        progress: ({ done, index, count, name }) => {
            const pct = total ? Math.floor(done / total * 100) : 100;
            $('lock-bar').value = pct;
            $('lock-pct').textContent = `${pct}%`;
            $('lock-done').textContent = `${formatSize(done)} of ${formatSize(total)}`;
            $('lock-phase').textContent = count > 1 && index ? `File ${index} of ${count.toLocaleString('en-US')}: ${name}` : (name || '');
        },
        done: finishLockSave,
        error: lockFailed,
    });
    post({ type: 'start' });
}

async function finishLockSave() {
    try {
        const result = await sink.close();
        sink = null;
        busy = false;
        $('lock-saved').textContent = `${lock.outName} was ${result ? 'downloaded' : 'saved'}.`;
        renderKey();
        setBars(3);
        showStep('view-lock', 'key');
    } catch {
        lockFailed({ code: 'save_failed' });
    }
}

function renderKey() {
    const list = $('lock-key');
    list.replaceChildren();
    lock.words.forEach((word, i) => {
        const li = document.createElement('li');
        const n = document.createElement('span');
        n.className = 'key-n';
        n.textContent = String(i + 1);
        const w = document.createElement('span');
        w.className = 'key-word';
        w.textContent = word;
        li.append(n, w);
        list.append(li);
    });
    $('copy-key').textContent = 'Copy key';
    $('copy-message').textContent = 'Copy message for the receiver';
}

async function lockFailed({ code, detail }) {
    await stopJob();
    resetLock(message(code, detail));
}

async function copyText(text, button, label) {
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = label;
    } catch {
        const range = document.createRange();
        range.selectNodeContents($('lock-key'));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Press copy on your device';
    }
}

function resetOpen(alertText = '') {
    open = { file: null, meta: null };
    $('open-key').value = '';
    $('open-file').value = '';
    $('open-card').hidden = true;
    updateHint();
    setAlert('open-alert', alertText);
    showStep('view-open', 'pick');
}

function pickLocked(file) {
    if (!file) return;
    setAlert('open-alert', '');
    open.file = file;
    on({
        'header-ok': () => {
            $('open-in-name').textContent = file.name;
            $('open-in-size').textContent = `${formatSize(file.size)} · Locked file found`;
            $('open-card').hidden = false;
            showStep('view-open', 'key');
            $('open-key').focus();
        },
        error: ({ code }) => {
            open.file = null;
            $('open-file').value = '';
            setAlert('open-alert', message(code));
        },
    });
    post({ type: 'inspect', file });
}

function updateHint(errorText = '') {
    const hint = $('open-hint');
    const input = $('open-key');
    const key = normalizeKey(input.value);
    const parts = countKeyParts(key);
    let text = 'For example: tiger-mango-velvet-cloud-pebble-lantern';
    let state = '';
    if (errorText) {
        text = errorText;
        state = 'bad';
    } else if (parts > 0 && isKeyValid(key)) {
        text = `${KEY_WORDS} words. Ready to open.`;
        state = 'good';
    } else if (parts > 0) {
        text = parts > KEY_WORDS ? `That's ${parts} words. The key has ${KEY_WORDS}.` : `${parts} of ${KEY_WORDS} words`;
    }
    hint.textContent = text;
    hint.className = `hint ${state}`;
    input.classList.toggle('invalid', state === 'bad');
    input.setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false');
}

function submitKey(event) {
    event.preventDefault();
    const key = normalizeKey($('open-key').value);
    if (!isKeyValid(key)) return updateHint(message('bad_key_format'));
    setAlert('open-alert', '');
    busy = true;
    showStep('view-open', 'checking');
    on({
        meta: ({ meta }) => {
            $('open-key').value = '';
            const name = cleanName(meta.name, meta.kind === KIND_BUNDLE ? 'files.zip' : 'file');
            open.meta = { ...meta, saveName: meta.kind === KIND_BUNDLE && !/\.zip$/i.test(name) ? `${name}.zip` : name };
            if (meta.size > sizeLimit()) {
                stopJob();
                return resetOpen(message('too_large'));
            }
            $('open-out-name').textContent = open.meta.saveName;
            $('open-out-count').textContent = meta.count === 1 ? '1 file' : `${meta.count.toLocaleString('en-US')} files`;
            $('open-out-size').textContent = formatSize(meta.size);
            $('open-zip-note').hidden = meta.kind !== KIND_BUNDLE;
            $('open-save-btn').textContent = `Save ${open.meta.saveName}`;
            showStep('view-open', 'ready');
        },
        error: async ({ code }) => {
            await stopJob();
            showStep('view-open', 'key');
            if (code === 'wrong_key') {
                updateHint(message(code));
                $('open-key').focus();
            } else {
                setAlert('open-alert', message(code));
            }
        },
    });
    post({ type: 'open-prepare', file: open.file, keyText: key });
}

async function saveOpened() {
    try {
        sink = await openSink(open.meta.saveName);
    } catch (error) {
        if (error && error.name === 'AbortError') return;
        return openFailed({ code: 'save_failed' });
    }
    const total = open.meta.size;
    $('open-progress-title').textContent = `Opening ${open.meta.saveName}…`;
    $('open-bar').value = 0;
    $('open-pct').textContent = '0%';
    showStep('view-open', 'progress');
    on({
        ...pipeOutput(),
        progress: ({ done }) => {
            const pct = total ? Math.floor(done / total * 100) : 100;
            $('open-bar').value = pct;
            $('open-pct').textContent = `${pct}%`;
        },
        done: async () => {
            try {
                const result = await sink.close();
                sink = null;
                busy = false;
                $('open-done-title').textContent = `${open.meta.saveName} ${result ? 'downloaded' : 'saved'}`;
                $('open-again').hidden = !result;
                if (result) {
                    $('open-again-link').href = result.url;
                    $('open-again-link').download = result.name;
                }
                showStep('view-open', 'done');
            } catch {
                openFailed({ code: 'save_failed' });
            }
        },
        error: openFailed,
    });
    post({ type: 'start' });
}

async function openFailed({ code }) {
    await stopJob();
    resetOpen(message(code));
}

async function cancel() {
    await stopJob();
    if (view === 'lock') resetLock(message('cancelled'));
    if (view === 'open') resetOpen(message('cancelled'));
}

function dropZone(zone, onFiles) {
    zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (event) => {
        event.preventDefault();
        zone.classList.remove('over');
        try {
            onFiles(await fromDrop(event.dataTransfer), event.dataTransfer.files);
        } catch {
            onFiles([], event.dataTransfer.files);
        }
    });
}

function init() {
    if (!wordlistOk()) {
        setAlert('fatal', 'Sealkey failed to load correctly. Refresh the page.');
        document.querySelectorAll('.choice').forEach((button) => { button.disabled = true; });
        return;
    }
    newWorker();
    document.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', (event) => {
        event.preventDefault();
        go(el.dataset.go);
    }));
    document.querySelectorAll('[data-cancel]').forEach((el) => el.addEventListener('click', cancel));

    const filesInput = $('lock-files');
    const folderInput = $('lock-folder');
    $('lock-files-btn').addEventListener('click', () => filesInput.click());
    $('lock-folder-btn').addEventListener('click', () => folderInput.click());
    if (!('webkitdirectory' in folderInput) || isMobile()) $('lock-folder-btn').hidden = true;
    filesInput.addEventListener('change', () => {
        addToLock(fromFileList(filesInput.files, false));
        filesInput.value = '';
    });
    folderInput.addEventListener('change', () => {
        addToLock(fromFileList(folderInput.files, true));
        folderInput.value = '';
    });
    dropZone($('lock-drop'), (items) => addToLock(items));
    $('lock-btn').addEventListener('click', startLock);
    $('lock-save-btn').addEventListener('click', saveLock);
    $('copy-key').addEventListener('click', (event) => copyText(lock.words.join('-'), event.currentTarget, 'Copied'));
    $('copy-message').addEventListener('click', (event) => {
        const site = `${location.origin}${location.pathname}`;
        const text = `Here is the key for the file I sent you: ${lock.words.join('-')}\nOpen it at ${site}. I sent the file separately.`;
        copyText(text, event.currentTarget, 'Message copied');
    });
    $('key-saved').addEventListener('change', (event) => {
        $('lock-finish').disabled = !event.target.checked;
        $('key-saved-hint').hidden = event.target.checked;
    });
    $('lock-finish').addEventListener('click', () => {
        clearKeyDisplay();
        go('home');
    });

    const fileInput = $('open-file');
    $('open-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => pickLocked(fileInput.files[0]));
    dropZone($('open-drop'), (items, files) => pickLocked(items[0] ? items[0].file : files[0]));
    $('open-change').addEventListener('click', () => resetOpen());
    $('open-key').addEventListener('input', () => updateHint());
    $('open-form').addEventListener('submit', submitKey);
    const paste = $('open-paste');
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        paste.addEventListener('click', async () => {
            try {
                $('open-key').value = (await navigator.clipboard.readText()).trim();
                updateHint();
            } catch {
                $('open-key').focus();
            }
        });
    } else {
        paste.hidden = true;
    }
    $('open-save-btn').addEventListener('click', saveOpened);

    window.addEventListener('beforeunload', (event) => {
        if (busy || lock.words.length) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    window.addEventListener('pagehide', () => {
        clearKeyDisplay();
        $('open-key').value = '';
    });
    document.documentElement.dataset.save = canStream() ? 'stream' : 'memory';
}

init();
