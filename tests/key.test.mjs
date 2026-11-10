import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WORDS } from '../js/words.js';
import { makeKey, makeKeyWords, normalizeKey, isKeyValid, wordlistOk } from '../js/key.js';

test('wordlist is the EFF list without its 4 hyphenated words', () => {
    assert.equal(WORDS.length, 7772);
    assert.equal(new Set(WORDS).size, 7772);
    assert.ok(wordlistOk());
    assert.equal(WORDS[0], 'abacus');
    assert.equal(WORDS[7771], 'zoom');
    assert.ok(WORDS.every((word) => /^[a-z]+$/.test(word)));
    const source = readFileSync(new URL('../tools/eff_large_wordlist.txt', import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e');
    const fromSource = source.toString('utf8').trim().split('\n').map((line) => line.split('\t')[1]);
    assert.deepEqual(fromSource.filter((word) => word.includes('-')), ['drop-down', 'felt-tip', 't-shirt', 'yo-yo']);
    assert.deepEqual(fromSource.filter((word) => !word.includes('-')), [...WORDS]);
});

test('keys are 6 words and valid', () => {
    for (let i = 0; i < 200; i++) {
        const key = makeKey();
        assert.ok(isKeyValid(normalizeKey(key)), key);
        assert.equal(makeKeyWords().length, 6);
    }
});

test('10,000 keys have no repeats and roughly even word use', () => {
    const keys = new Set();
    const counts = new Map();
    for (let i = 0; i < 10000; i++) {
        const words = makeKeyWords();
        keys.add(words.join('-'));
        for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    assert.equal(keys.size, 10000);
    const expected = 60000 / 7772;
    let chi = 0;
    for (const word of WORDS) chi += ((counts.get(word) ?? 0) - expected) ** 2 / expected;
    assert.ok(chi > 7300 && chi < 8250, `chi-square ${chi}`);
    assert.equal(counts.size <= 7772, true);
});

test('typed keys are normalized', () => {
    assert.equal(normalizeKey('  Tiger MANGO   velvet-cloud -- pebble\tlantern  '), 'tiger-mango-velvet-cloud-pebble-lantern');
    assert.equal(normalizeKey('-tiger-'), 'tiger');
    assert.ok(isKeyValid(normalizeKey('TIGER MANGO VELVET CLOUD PEBBLE LANTERN')));
});

test('wrong word counts and unknown words are rejected', () => {
    assert.equal(isKeyValid(normalizeKey('tiger mango velvet cloud pebble')), false);
    assert.equal(isKeyValid(normalizeKey('tiger mango velvet cloud pebble lantern zoom')), false);
    assert.equal(isKeyValid(normalizeKey('tiger mango velvet cloud pebble lanturn')), false);
    assert.equal(isKeyValid(''), false);
});

test('removed hyphenated words are never accepted', () => {
    assert.equal(isKeyValid(normalizeKey('t-shirt mango velvet cloud pebble lantern')), false);
    assert.equal(isKeyValid(normalizeKey('yoyo mango velvet cloud pebble lantern')), true);
});
