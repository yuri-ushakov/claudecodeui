import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_TIMER_MS, MIN_HOLD_MS, readHoldMs } from '../claude-hold-ceilings.js';

const FALLBACK = 30 * 60 * 1000;

function read(raw: string | undefined) {
  const logs: string[] = [];
  const value = readHoldMs('X_HOLD_MS', FALLBACK, { X_HOLD_MS: raw }, (m) => logs.push(m));
  return { value, logs };
}

test('unset or blank keeps the default silently', () => {
  for (const raw of [undefined, '', '   ']) {
    const { value, logs } = read(raw);
    assert.equal(value, FALLBACK);
    assert.equal(logs.length, 0);
  }
});

test('plain integer milliseconds in range are applied', () => {
  assert.equal(read('43200000').value, 43_200_000);
  assert.equal(read(' 3600000 ').value, 3_600_000);
  assert.equal(read(String(MIN_HOLD_MS)).value, MIN_HOLD_MS);
  assert.equal(read(String(MAX_TIMER_MS)).value, MAX_TIMER_MS);
});

test('typos and out-of-range values never shorten the hold', () => {
  for (const raw of ['12h', '4.32e7', '-1', '0', '59999', '1.5', String(MAX_TIMER_MS + 1), '99999999999999999999', 'abc']) {
    const { value, logs } = read(raw);
    assert.equal(value, FALLBACK, `value for ${raw}`);
    assert.equal(logs.length, 1, `warning for ${raw}`);
    assert.match(logs[0], /X_HOLD_MS=.* ignored/);
  }
});
