import { cleanPath, MAX_BUNDLE_FILES } from './format.js';

function readAllEntries(directory) {
    const reader = directory.createReader();
    const all = [];
    return new Promise((resolve, reject) => {
        const next = () => reader.readEntries((batch) => {
            if (batch.length === 0) {
                resolve(all);
                return;
            }
            all.push(...batch);
            next();
        }, reject);
        next();
    });
}

function entryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry, out, limit) {
    if (out.length > limit) return;
    if (entry.isFile) {
        out.push({ file: await entryFile(entry), path: entry.fullPath.replace(/^\/+/, '') });
    } else if (entry.isDirectory) {
        for (const child of await readAllEntries(entry)) await walk(child, out, limit);
    }
}

export function fromFileList(fileList, isFolder) {
    return Array.from(fileList, (file) => ({ file, path: isFolder && file.webkitRelativePath ? file.webkitRelativePath : file.name }));
}

export async function fromDrop(dataTransfer) {
    const entries = Array.from(dataTransfer.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
    if (entries.length === 0 || entries.some((entry) => !entry)) return fromFileList(dataTransfer.files, false);
    const out = [];
    for (const entry of entries) await walk(entry, out, MAX_BUNDLE_FILES);
    return out;
}

function withNumber(path, n) {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash + 1);
    const base = path.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    return `${folder}${stem} (${n})${ext}`;
}

export function addItems(current, incoming) {
    const taken = new Set(current.map((item) => item.path.toLowerCase()));
    const added = [];
    for (const { file, path } of incoming) {
        let clean = cleanPath(path) || 'file';
        if (taken.has(clean.toLowerCase())) {
            let n = 1;
            while (taken.has(withNumber(clean, n).toLowerCase())) n++;
            clean = withNumber(clean, n);
        }
        taken.add(clean.toLowerCase());
        added.push({ file, path: clean, id: crypto.randomUUID() });
    }
    return [...current, ...added];
}

export function zipName(items, today = new Date()) {
    const tops = new Set(items.map((item) => (item.path.includes('/') ? item.path.split('/')[0] : '')));
    if (tops.size === 1 && !tops.has('')) return `${[...tops][0]}.zip`;
    const pad = (n) => String(n).padStart(2, '0');
    return `files-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.zip`;
}
