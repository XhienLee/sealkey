import { WORDS } from './words.js';

export const KEY_WORDS = 6;
export const WORD_COUNT = 7772;

const WORD_SET = new Set(WORDS);

export function wordlistOk() {
    return WORDS.length === WORD_COUNT && WORD_SET.size === WORD_COUNT && WORDS.every((word) => /^[a-z]+$/.test(word));
}

function randomIndex(n) {
    const limit = 2 ** 32 - (2 ** 32 % n);
    const buf = new Uint32Array(1);
    do {
        crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return buf[0] % n;
}

export function makeKeyWords(count = KEY_WORDS) {
    if (!wordlistOk()) throw new Error('wordlist');
    return Array.from({ length: count }, () => WORDS[randomIndex(WORDS.length)]);
}

export function makeKey(count = KEY_WORDS) {
    return makeKeyWords(count).join('-');
}

export function normalizeKey(input) {
    return input.trim().toLowerCase().replace(/[\s-]+/g, '-').replace(/^-|-$/g, '');
}

export function isKeyValid(normalized, count = KEY_WORDS) {
    if (normalized === '') return false;
    const parts = normalized.split('-');
    return parts.length === count && parts.every((part) => WORD_SET.has(part));
}

export function countKeyParts(normalized) {
    return normalized === '' ? 0 : normalized.split('-').length;
}
