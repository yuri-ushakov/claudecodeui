import assert from 'node:assert/strict';
import test from 'node:test';

import { parseViewRoots } from '../file-view-roots.js';

test('an unset or empty variable means no extra roots', () => {
  assert.deepEqual(parseViewRoots(undefined), []);
  assert.deepEqual(parseViewRoots(''), []);
});

test('colon-separated absolute directories are kept in order', () => {
  assert.deepEqual(parseViewRoots('/home/yuri/Projects:/data'), ['/home/yuri/Projects', '/data']);
});

test('blank entries, whitespace, relative entries and duplicates are dropped', () => {
  assert.deepEqual(
    parseViewRoots(' /home/yuri/Projects : :relative/dir:/data/:/data '),
    ['/home/yuri/Projects', '/data'],
  );
});
