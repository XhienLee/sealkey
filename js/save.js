const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function isMobile() {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean' && navigator.userAgentData.mobile) return true;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function canStream() {
    return typeof window.showSaveFilePicker === 'function' && window.isSecureContext && !isMobile();
}

export function sizeLimit() {
    if (canStream()) return 10 * GIB;
    return isMobile() ? 500 * MIB : GIB;
}

class MemorySink {
    constructor(name) {
        this.name = name;
        this.parts = [];
        this.url = '';
    }

    async write(data) {
        this.parts.push(data);
    }

    async close() {
        const blob = new Blob(this.parts, { type: 'application/octet-stream' });
        this.parts = [];
        this.url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = this.url;
        link.download = this.name;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        const url = this.url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return { url, name: this.name };
    }

    async abort() {
        this.parts = [];
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = '';
    }
}

class StreamSink {
    constructor(writable) {
        this.writable = writable;
    }

    async write(data) {
        await this.writable.write(data);
    }

    async close() {
        await this.writable.close();
        return null;
    }

    async abort() {
        try {
            await this.writable.abort();
        } catch {
        }
    }
}

export async function openSink(name) {
    if (!canStream()) return new MemorySink(name);
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    return new StreamSink(await handle.createWritable());
}

export function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < MIB) return Math.round(bytes / 1024) + ' KB';
    if (bytes < GIB) return (bytes / MIB).toFixed(1) + ' MB';
    return (bytes / GIB).toFixed(1) + ' GB';
}
