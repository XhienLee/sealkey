import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = process.argv[2] ?? new URL('./eff_large_wordlist.txt', import.meta.url);
const text = readFileSync(source, 'utf8');
const words = text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const match = line.match(/^[1-6]{5}\s+(\S+)$/);
    if (!match) throw new Error(`Unexpected line: ${line}`);
    return match[1];
});
if (words.length !== 7776) throw new Error(`Expected 7776 words, got ${words.length}`);
if (new Set(words).size !== 7776) throw new Error('Duplicate words');
const removed = words.filter((word) => word.includes('-'));
const kept = words.filter((word) => !word.includes('-'));
if (kept.length !== 7772) throw new Error(`Expected 7772 words after removing hyphenated ones, got ${kept.length}`);
writeFileSync(new URL('../js/words.js', import.meta.url), `export const WORDS = Object.freeze(${JSON.stringify(kept)});\n`);
console.log('Removed:', removed.join(', '));
console.log('words.js written');
console.log('SHA-256 of source:', createHash('sha256').update(readFileSync(source)).digest('hex'));
