import { makeKeyWords, normalizeKey, isKeyValid, countKeyParts, wordlistOk, KEY_WORDS } from './key.js';
import { lockedSize, cleanName, MAX_BUNDLE_FILES, DEFAULTS, KIND_BUNDLE } from './format.js';
import { openSink, sizeLimit, canStream, isMobile, formatSize } from './save.js';
import { fromFileList, fromDrop, addItems, zipName } from './bundle.js';
import { predictLength } from '../vendor/client-zip/index.js';
import { HAT_HEAD_BYTES, HAT_V1_MAX, hatKind, isSealkey, hatOutName } from './hatsh.js';
import { KDF_X25519 } from './format.js';
import { SECRET_WORDS } from './keypair.js';

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
    wrong_password: 'Wrong password, or the file was changed.',
    not_hat: "This isn't a hat.sh file.",
    is_sealkey: 'This is a Sealkey file. Open it from "Open a locked file".',
    from_hat: 'This file was made with hat.sh, so it opens here.',
    bad_public_key: "That isn't a Sealkey public key. Ask them to copy it again from \"My key\".",
    bad_secret_words: `Check your words. There should be ${SECRET_WORDS} words from Sealkey's list.`,
    wrong_words: "These words don't open this file. Check them and try again.",
    needs_secret_words: 'This file was locked for a public key. Open it with your 12 secret words.',
    needs_key: 'This file needs its 6-word key.',
    bad_hat_key: "That doesn't look like a hat.sh key. hat.sh keys are 43 characters long.",
    wrong_hat_keys: "These keys don't open this file. Use your private key and the sender's public key.",
    hat_own_key: "That's your own public key. Paste the sender's public key instead.",
    copy_failed: 'Copying was blocked. Select the key and copy it yourself.',
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
let open = { file: null, meta: null, words: KEY_WORDS };
let keys = { shown: false };
let hat = { file: null, kind: null, size: 0, name: '' };

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
    if (viewId === 'view-open') setRail('view-open', { pick: 1, key: 2, checking: 2, ready: 3, progress: 3, done: 4 }[step] || 1);
    const shown = section.querySelector(`[data-step="${step}"] h1`);
    if (shown) shown.focus({ preventScroll: false });
}

function stepShown(viewId, step) {
    return !$(viewId).hidden && !document.querySelector(`#${viewId} [data-step="${step}"]`).hidden;
}

function keyOnScreen() {
    return lock.words.length > 0 && stepShown('view-lock', 'key') && !$('key-saved').checked;
}

function wordsOnScreen() {
    return keys.shown && stepShown('view-keys', 'words') && !$('keys-saved').checked;
}

const LEAVE = {
    job: {
        title: 'Stop and leave?',
        text: "Sealkey is still working. If you leave now, it stops and nothing is saved.",
        stay: 'Keep going',
        leave: 'Stop and leave',
    },
    key: {
        title: 'Leave without your key?',
        text: "You won't see this key again, and the file can't be opened without it.",
        stay: 'Stay and save my key',
        leave: 'Leave anyway',
    },
    words: {
        title: 'Leave without your 12 words?',
        text: "You won't see them again, and files sent to your public key can't be opened without them.",
        stay: 'Stay and write them down',
        leave: 'Leave anyway',
    },
};

let asking = null;

function ask({ title, text, stay, leave }) {
    const dialog = $('ask');
    if (typeof dialog.showModal !== 'function') return Promise.resolve(confirm(`${title}\n\n${text}`));
    if (asking) return asking;
    $('ask-title').textContent = title;
    $('ask-text').textContent = text;
    $('ask-stay').textContent = stay;
    $('ask-leave').textContent = leave;
    asking = new Promise((resolve) => {
        const finish = (answer) => {
            dialog.removeEventListener('close', onClose);
            asking = null;
            resolve(answer);
        };
        const onClose = () => finish(dialog.returnValue === 'leave');
        dialog.returnValue = '';
        dialog.addEventListener('close', onClose);
        dialog.showModal();
        $('ask-stay').focus();
    });
    return asking;
}

async function go(next) {
    const reason = busy ? 'job' : keyOnScreen() ? 'key' : wordsOnScreen() ? 'words' : null;
    if (reason && !(await ask(LEAVE[reason]))) return;
    stopJob();
    if (view === 'lock') clearKeyDisplay();
    if (view === 'keys') {
        keys = { shown: false };
        $('keys-secret').replaceChildren();
    }
    view = next;
    for (const name of ['home', 'lock', 'open', 'hat', 'keys']) $(`view-${name}`).hidden = name !== next;
    document.querySelector('.back').hidden = next === 'home';
    document.querySelector('.tabs').hidden = next === 'home';
    document.querySelectorAll('[data-tab]').forEach((tab) => {
        if (tab.dataset.tab === (next === 'hat' ? 'open' : next)) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    });
    if (next === 'lock') resetLock();
    if (next === 'open') resetOpen();
    if (next === 'hat') resetHat();
    if (next === 'keys') resetKeys();
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

function setRail(viewId, n) {
    $(viewId).querySelectorAll('[data-bar]').forEach((bar) => {
        const i = Number(bar.dataset.bar);
        bar.classList.toggle('on', i <= n);
        bar.classList.toggle('now', i === n);
        if (i === n && bar.tagName === 'LI') bar.setAttribute('aria-current', 'step');
        else bar.removeAttribute('aria-current');
    });
}

function setBars(n) {
    setRail('view-lock', n);
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
    lock = { items: [], words: [], outName: '', meta: null, method: 'words', recipient: '', fingerprint: [] };
    document.querySelector('input[name="lock-method"][value="words"]').checked = true;
    $('lock-public').hidden = true;
    $('lock-public-key').value = '';
    setPublicHint();
    $('lock-fp-wrap').hidden = true;
    $('lock-fp-checked').checked = false;
    document.querySelector('#view-lock .stepper [data-bar="3"] .step-name').textContent = 'Keep your key';
    document.querySelector('#view-lock .stepper [data-bar="3"] .step-sub').textContent = '6 words, shown once';
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
    updateLockButton();
}

function updateLockButton() {
    $('lock-btn').disabled = lock.method === 'public' && !(lock.recipient && $('lock-fp-checked').checked);
}

function setPublicHint(text = 'Ask them for it. They get one under "My key".', state = '') {
    $('lock-public-hint').textContent = text;
    $('lock-public-hint').className = `hint ${state}`;
    $('lock-public-key').classList.toggle('invalid', state === 'bad');
    $('lock-public-key').setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false');
}

function setLockMethod(method) {
    lock.method = method;
    $('lock-public').hidden = method !== 'public';
    const public_ = method === 'public';
    document.querySelector('#view-lock .stepper [data-bar="3"] .step-name').textContent = public_ ? 'Send the file' : 'Keep your key';
    document.querySelector('#view-lock .stepper [data-bar="3"] .step-sub').textContent = public_ ? 'Nothing else to send' : '6 words, shown once';
    updateLockButton();
}

function checkPublicKey() {
    const text = $('lock-public-key').value.trim();
    lock.recipient = '';
    lock.fingerprint = [];
    $('lock-fp-wrap').hidden = true;
    $('lock-fp-checked').checked = false;
    updateLockButton();
    if (!text) return setPublicHint();
    on({
        'public-ok': ({ fingerprint }) => {
            if ($('lock-public-key').value.trim() !== text) return;
            lock.recipient = text;
            lock.fingerprint = fingerprint;
            renderWords($('lock-fp'), fingerprint);
            $('lock-fp-wrap').hidden = false;
            setPublicHint('Public key looks right.', 'good');
            updateLockButton();
        },
        error: ({ code }) => {
            if ($('lock-public-key').value.trim() !== text) return;
            setPublicHint(message(code), 'bad');
        },
    });
    post({ type: 'check-public', text });
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
    const forKey = lock.method === 'public';
    if (forKey && !(lock.recipient && $('lock-fp-checked').checked)) return;
    setAlert('lock-alert', '');
    lock.words = forKey ? [] : makeKeyWords();
    lock.outName = randomName();
    busy = true;
    document.querySelector('#view-lock [data-step="prepare"] h1').textContent = forKey ? 'Locking for their key' : 'Making your key';
    document.querySelector('#view-lock [data-step="prepare"] .muted').textContent = forKey
        ? 'This only takes a moment.'
        : 'This takes a few seconds on purpose, so the key is slow to guess.';
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
        keyText: forKey ? null : lock.words.join('-'),
        recipientText: forKey ? lock.recipient : null,
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
        setBars(3);
        if (lock.method === 'public') {
            $('lock-sent-text').textContent = `${lock.outName} was ${result ? 'downloaded' : 'saved'}. Send it to them any way you like. Only their 12 secret words can open it.`;
            $('lock-sent-fp').textContent = `Their key: ${lock.fingerprint.join('-')}`;
            showStep('view-lock', 'sent');
            return;
        }
        $('lock-saved').textContent = `${lock.outName} was ${result ? 'downloaded' : 'saved'}.`;
        renderKey();
        showStep('view-lock', 'key');
    } catch {
        lockFailed({ code: 'save_failed' });
    }
}

function renderWords(list, words) {
    list.replaceChildren();
    words.forEach((word, i) => {
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
}

function resetKeys(alertText = '') {
    keys = { shown: false };
    $('keys-secret').replaceChildren();
    $('keys-saved').checked = false;
    $('keys-next').disabled = true;
    $('keys-words').value = '';
    $('keys-public').textContent = '';
    $('keys-copy').textContent = 'Copy public key';
    setKeysHint();
    setAlert('keys-alert', alertText);
    showStep('view-keys', 'start');
}

function setKeysHint(text = '', state = '') {
    $('keys-hint').textContent = text;
    $('keys-hint').className = `hint ${state}`;
    $('keys-words').classList.toggle('invalid', state === 'bad');
    $('keys-words').setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false');
}

function showPublic(publicKey, fingerprint) {
    $('keys-public').textContent = publicKey;
    renderWords($('keys-fp'), fingerprint);
    showStep('view-keys', 'public');
}

function makeKeys(words = null) {
    setAlert('keys-alert', '');
    busy = true;
    showStep('view-keys', 'making');
    on({
        keypair: ({ words: secret, publicKey, fingerprint }) => {
            busy = false;
            $('keys-words').value = '';
            if (secret) {
                keys.shown = true;
                keys.publicKey = publicKey;
                keys.fingerprint = fingerprint;
                renderWords($('keys-secret'), secret);
                showStep('view-keys', 'words');
            } else {
                showPublic(publicKey, fingerprint);
            }
        },
        error: async ({ code }) => {
            await stopJob();
            showStep('view-keys', 'start');
            if (code === 'bad_secret_words') {
                setKeysHint(message(code), 'bad');
                $('keys-words').focus();
            } else {
                setAlert('keys-alert', message(code));
            }
        },
    });
    post({ type: 'make-keypair', words });
}

function showFromWords(event) {
    event.preventDefault();
    const words = normalizeKey($('keys-words').value);
    if (!isKeyValid(words, SECRET_WORDS)) return setKeysHint(message('bad_secret_words'), 'bad');
    setKeysHint();
    makeKeys(words);
}

async function copyPublic() {
    try {
        await navigator.clipboard.writeText($('keys-public').textContent);
        $('keys-copy').textContent = 'Copied';
    } catch {
        const range = document.createRange();
        range.selectNodeContents($('keys-public'));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        $('keys-copy').textContent = 'Press copy on your device';
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

function setOpenWords(count) {
    open.words = count;
    const forKey = count === SECRET_WORDS;
    const step = document.querySelector('#view-open [data-step="key"]');
    step.querySelector('h1').textContent = forKey ? 'Enter your 12 secret words' : 'Enter the key';
    step.querySelector('.lead').textContent = forKey
        ? 'This file was locked for your public key. Type the 12 secret words that made it. Capitals and spaces don\'t matter.'
        : 'Type or paste the 6 words you were sent. Capitals and spaces don\'t matter.';
    $('open-key').placeholder = forKey ? 'your 12 secret words' : 'tiger-mango-velvet-…';
    document.querySelector('label[for="open-key"]').textContent = forKey ? 'Your 12 secret words' : 'Key';
    document.querySelector('#view-open .stepper [data-bar="2"] .step-name').textContent = forKey ? 'Enter your 12 words' : 'Enter the key';
    document.querySelector('#view-open .stepper [data-bar="2"] .step-sub').textContent = forKey ? 'The secret words behind your public key' : 'The 6 words, sent separately';
}

function resetOpen(alertText = '') {
    open = { file: null, meta: null, words: KEY_WORDS };
    setOpenWords(KEY_WORDS);
    $('open-key').value = '';
    $('open-file').value = '';
    $('open-card').hidden = true;
    updateHint();
    setAlert('open-alert', alertText);
    showStep('view-open', 'pick');
}

async function readHead(file) {
    try {
        return new Uint8Array(await file.slice(0, HAT_HEAD_BYTES).arrayBuffer());
    } catch {
        return new Uint8Array(0);
    }
}

async function pickLocked(file) {
    if (!file) return;
    if (hatKind(await readHead(file))) {
        go('hat');
        return pickHat(file, message('from_hat'));
    }
    setAlert('open-alert', '');
    open.file = file;
    on({
        'header-ok': ({ header }) => {
            setOpenWords(header.kdf === KDF_X25519 ? SECRET_WORDS : KEY_WORDS);
            updateHint();
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
    const need = open.words;
    let text = need === SECRET_WORDS ? 'The 12 words you wrote down when you made your key.' : 'For example: tiger-mango-velvet-cloud-pebble-lantern';
    let state = '';
    if (errorText) {
        text = errorText;
        state = 'bad';
    } else if (parts > 0 && isKeyValid(key, need)) {
        text = `${need} words. Ready to open.`;
        state = 'good';
    } else if (parts > 0) {
        text = parts > need ? `That's ${parts} words. You need ${need}.` : `${parts} of ${need} words`;
    }
    hint.textContent = text;
    hint.className = `hint ${state}`;
    input.classList.toggle('invalid', state === 'bad');
    input.setAttribute('aria-invalid', state === 'bad' ? 'true' : 'false');
}

function submitKey(event) {
    event.preventDefault();
    const key = normalizeKey($('open-key').value);
    if (!isKeyValid(key, open.words)) return updateHint(open.words === SECRET_WORDS ? message('bad_secret_words') : message('bad_key_format'));
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
                updateHint(message(open.words === SECRET_WORDS ? 'wrong_words' : code));
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
    if (view === 'hat') resetHat(message('cancelled'));
}

function resetHat(alertText = '') {
    hat = { file: null, kind: null, size: 0, name: '' };
    $('hat-password').value = '';
    $('hat-private').value = '';
    $('hat-sender').value = '';
    setHatKeysHint();
    $('hat-password').type = 'password';
    $('hat-show').textContent = 'Show';
    $('hat-show').setAttribute('aria-pressed', 'false');
    $('hat-file').value = '';
    $('hat-card').hidden = true;
    setHatHint();
    $('hat-alert').classList.remove('alert-info');
    $('hat-alert').setAttribute('role', 'alert');
    setAlert('hat-alert', alertText);
    showStep('view-hat', 'pick');
}

function setHatHint(text = '') {
    $('hat-hint').textContent = text;
    $('hat-hint').classList.toggle('bad', Boolean(text));
    $('hat-password').classList.toggle('invalid', Boolean(text));
    $('hat-password').setAttribute('aria-invalid', text ? 'true' : 'false');
}

async function pickHat(file, note = '') {
    if (!file) return;
    const head = await readHead(file);
    const kind = hatKind(head);
    $('hat-file').value = '';
    if (!kind) return resetHat(message(isSealkey(head) ? 'is_sealkey' : 'not_hat'));
    if (kind === 'v1' && file.size > HAT_V1_MAX) return resetHat(message('too_large'));
    hat = { file, kind, size: 0, name: hatOutName(kind, file.name) };
    setAlert('hat-alert', note);
    $('hat-alert').classList.toggle('alert-info', Boolean(note));
    $('hat-alert').setAttribute('role', note ? 'status' : 'alert');
    $('hat-in-name').textContent = file.name;
    $('hat-in-size').textContent = `${formatSize(file.size)} · ${kind === 'v1' ? 'Old hat.sh file (version 1)' : 'hat.sh file found'}`;
    $('hat-card').hidden = false;
    setHatHint();
    if (kind === 'v2-keypair') {
        $('hat-in-size').textContent = `${formatSize(file.size)} · hat.sh key-pair file`;
        setHatKeysHint();
        showStep('view-hat', 'keys');
        $('hat-private').focus();
        return;
    }
    showStep('view-hat', 'key');
    $('hat-password').focus();
}

function setHatKeysHint(text = '') {
    $('hat-keys-hint').textContent = text;
    $('hat-keys-hint').classList.toggle('bad', Boolean(text));
    for (const id of ['hat-private', 'hat-sender']) {
        $(id).classList.toggle('invalid', Boolean(text));
        $(id).setAttribute('aria-invalid', text ? 'true' : 'false');
    }
}

function submitHatKeys(event) {
    event.preventDefault();
    const privateKey = $('hat-private').value.trim();
    const publicKey = $('hat-sender').value.trim();
    if (!privateKey || !publicKey) return setHatKeysHint('Paste both keys.');
    setHatKeysHint();
    runHatPrepare({ privateKey, publicKey });
}

function submitHat(event) {
    event.preventDefault();
    const password = $('hat-password').value;
    if (!password) return setHatHint('Enter the password.');
    setHatHint();
    runHatPrepare({ password });
}

function runHatPrepare(secrets) {
    const byKeys = 'privateKey' in secrets;
    document.querySelector('#view-hat [data-step="checking"] h1').textContent = byKeys ? 'Checking the keys…' : 'Checking the password…';
    document.querySelector('#view-hat [data-step="ready"] .ok').textContent = byKeys ? 'Keys accepted' : 'Password accepted';
    $('hat-alert').classList.remove('alert-info');
    $('hat-alert').setAttribute('role', 'alert');
    setAlert('hat-alert', '');
    busy = true;
    showStep('view-hat', 'checking');
    on({
        'hat-ready': ({ size, version }) => {
            $('hat-password').value = '';
            $('hat-private').value = '';
            if (size > sizeLimit()) {
                stopJob();
                return resetHat(message('too_large'));
            }
            hat.size = size;
            $('hat-out-name').textContent = hat.name;
            $('hat-out-size').textContent = formatSize(size);
            $('hat-out-version').textContent = version === 'v1' ? 'hat.sh (old version 1)' : version === 'v2-keypair' ? 'hat.sh key pair' : 'hat.sh or Hatsmith';
            $('hat-weak').textContent = version === 'v1'
                ? "This old file uses protection that's easy to break today. If you still need it protected, lock it again with Sealkey."
                : "hat.sh files don't hide their file name and use lighter protection than Sealkey. If you still need it protected, lock it again with Sealkey.";
            $('hat-save-btn').textContent = `Save ${hat.name}`;
            showStep('view-hat', 'ready');
        },
        error: async ({ code }) => {
            await stopJob();
            showStep('view-hat', byKeys ? 'keys' : 'key');
            if (code === 'wrong_password') {
                setHatHint(message(code));
                $('hat-password').focus();
            } else if (['wrong_hat_keys', 'hat_own_key', 'bad_hat_key'].includes(code)) {
                setHatKeysHint(message(code));
                $('hat-private').focus();
            } else {
                setAlert('hat-alert', message(code));
            }
        },
    });
    post({ type: 'hat-prepare', file: hat.file, ...secrets });
}

async function saveHat() {
    try {
        sink = await openSink(hat.name);
    } catch (error) {
        if (error && error.name === 'AbortError') return;
        return hatFailed({ code: 'save_failed' });
    }
    const total = hat.size;
    $('hat-progress-title').textContent = `Opening ${hat.name}…`;
    $('hat-bar').value = 0;
    $('hat-pct').textContent = '0%';
    showStep('view-hat', 'progress');
    on({
        ...pipeOutput(),
        progress: ({ done }) => {
            const pct = total ? Math.floor(done / total * 100) : 100;
            $('hat-bar').value = pct;
            $('hat-pct').textContent = `${pct}%`;
        },
        done: async () => {
            try {
                const result = await sink.close();
                sink = null;
                busy = false;
                $('hat-done-title').textContent = `${hat.name} ${result ? 'downloaded' : 'saved'}`;
                $('hat-again').hidden = !result;
                if (result) {
                    $('hat-again-link').href = result.url;
                    $('hat-again-link').download = result.name;
                }
                showStep('view-hat', 'done');
            } catch {
                hatFailed({ code: 'save_failed' });
            }
        },
        error: hatFailed,
    });
    post({ type: 'start' });
}

async function hatFailed({ code }) {
    await stopJob();
    resetHat(message(code === 'wrong_password' || code === 'wrong_hat_keys' ? 'damaged' : code));
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
    document.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', (event) => {
        event.preventDefault();
        go(el.dataset.tab);
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
    const hatInput = $('hat-file');
    $('hat-file-btn').addEventListener('click', () => hatInput.click());
    hatInput.addEventListener('change', () => pickHat(hatInput.files[0]));
    dropZone($('hat-drop'), (items, files) => pickHat(items[0] ? items[0].file : files[0]));
    $('hat-change').addEventListener('click', () => resetHat());
    $('hat-form').addEventListener('submit', submitHat);
    $('hat-password').addEventListener('input', () => setHatHint());
    $('hat-show').addEventListener('click', () => {
        const show = $('hat-password').type === 'password';
        $('hat-password').type = show ? 'text' : 'password';
        $('hat-show').textContent = show ? 'Hide' : 'Show';
        $('hat-show').setAttribute('aria-pressed', String(show));
    });
    $('hat-save-btn').addEventListener('click', saveHat);
    $('hat-keys-form').addEventListener('submit', submitHatKeys);
    $('ask-stay').addEventListener('click', () => $('ask').close('stay'));
    $('ask-leave').addEventListener('click', () => $('ask').close('leave'));
    $('ask').addEventListener('click', (event) => {
        if (event.target === $('ask')) $('ask').close('stay');
    });
    $('hat-private').addEventListener('input', () => setHatKeysHint());
    $('hat-sender').addEventListener('input', () => setHatKeysHint());
    document.querySelectorAll('input[name="lock-method"]').forEach((radio) => radio.addEventListener('change', () => setLockMethod(radio.value)));
    $('lock-public-key').addEventListener('input', checkPublicKey);
    $('lock-fp-checked').addEventListener('change', updateLockButton);
    $('lock-sent-done').addEventListener('click', () => go('home'));
    $('keys-make').addEventListener('click', () => makeKeys());
    $('keys-form').addEventListener('submit', showFromWords);
    $('keys-words').addEventListener('input', () => setKeysHint());
    $('keys-saved').addEventListener('change', (event) => { $('keys-next').disabled = !event.target.checked; });
    $('keys-next').addEventListener('click', () => {
        keys.shown = false;
        $('keys-secret').replaceChildren();
        showPublic(keys.publicKey, keys.fingerprint);
    });
    $('keys-copy').addEventListener('click', copyPublic);
    $('keys-done').addEventListener('click', () => go('home'));
    $('hat-relock').addEventListener('click', () => go('lock'));
    $('hat-finish').addEventListener('click', () => go('home'));
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
        if (busy || keyOnScreen() || wordsOnScreen()) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
    window.addEventListener('pagehide', () => {
        clearKeyDisplay();
        $('open-key').value = '';
        $('hat-password').value = '';
        $('hat-private').value = '';
        $('keys-secret').replaceChildren();
        $('keys-words').value = '';
    });
    document.documentElement.dataset.save = canStream() ? 'stream' : 'memory';
    registerOffline();
}

function registerOffline() {
    if (!('serviceWorker' in navigator)) return;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (local && !new URLSearchParams(location.search).has('offline')) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
