import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { sodium } from './helpers.mjs';
import { makeV1, makeV2 } from './hatsh-fixtures.mjs';
import { HAT_CHUNK } from '../js/hatsh.js';

const out = process.argv[2];
if (!out) throw new Error('usage: node tests/make-hat-files.mjs <folder>');
mkdirSync(out, { recursive: true });
const s = await sodium();
const big = new Uint8Array(HAT_CHUNK + 12345);
for (let i = 0; i < big.length; i += 65536) webcrypto.getRandomValues(big.subarray(i, i + 65536));
const small = new TextEncoder().encode('hello from hat.sh\n');
const files = {
    'plain-small.txt': small,
    'plain-big.bin': big,
    'notes.txt.enc': await makeV2(s, small, 'hat password'),
    'big.bin.enc': await makeV2(s, big, 'hat password'),
    'Encrypted-old.txt': await makeV1(small, 'old password'),
    'Encrypted-older.txt': await makeV1(small, 'old password', { hash: 'SHA-256', iterations: 100000 }),
    'keypair.enc': new TextEncoder().encode('hTWKbfoikeg' + 'x'.repeat(100)),
};
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(out, name), bytes);
console.log(Object.keys(files).join('\n'));
