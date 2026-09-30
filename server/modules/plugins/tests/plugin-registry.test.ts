import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from '../plugin-registry.service.js';

const manifest = (overrides: Record<string, unknown> = {}) => ({
  name: 'demo',
  displayName: 'Demo',
  entry: 'dist/index.js',
  ...overrides,
});

test('a manifest without tabOrder is valid: the plugin stays after the built-in tabs', () => {
  assert.deepEqual(validateManifest(manifest()), { valid: true });
});

test('tabOrder accepts non-negative integers', () => {
  assert.deepEqual(validateManifest(manifest({ tabOrder: 0 })), { valid: true });
  assert.deepEqual(validateManifest(manifest({ tabOrder: 1 })), { valid: true });
  assert.deepEqual(validateManifest(manifest({ tabOrder: 7 })), { valid: true });
});

test('tabOrder rejects negatives, fractions, strings and null', () => {
  for (const tabOrder of [-1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateManifest(manifest({ tabOrder }));
    assert.equal(result.valid, false, `tabOrder ${String(tabOrder)} should be rejected`);
    assert.match(result.error ?? '', /tabOrder/);
  }
});
