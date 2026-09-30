import assert from 'node:assert/strict';

import { test } from 'vitest';

import { parseViewedFile } from '@/modules/file-view/viewedFile';

test('an absolute path names the file, with its last segment as the name', () => {
  assert.deepEqual(parseViewedFile('/home/yuri/Projects/hq/reports/night mew.md'), {
    name: 'night mew.md',
    path: '/home/yuri/Projects/hq/reports/night mew.md',
  });
});

test('surrounding whitespace is dropped; no projectId is attached', () => {
  const file = parseViewedFile('  /data/notes.md ');
  assert.deepEqual(file, { name: 'notes.md', path: '/data/notes.md' });
  assert.equal('projectId' in (file ?? {}), false);
});

test('a missing, empty or relative path is rejected', () => {
  assert.equal(parseViewedFile(null), null);
  assert.equal(parseViewedFile(''), null);
  assert.equal(parseViewedFile('reports/night.md'), null);
  assert.equal(parseViewedFile('view?path=/x.md'), null);
});
