import assert from 'node:assert/strict';

import { test } from 'vitest';

import { orderTabs } from '@/modules/project-workspace/utils/workspaceTabOrder';

const builtIn = ['chat', 'shell', 'files', 'git'];

test('plugins without a slot follow the built-in tabs behind a separator', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'queue', tabOrder: null },
    { tab: 'notes', tabOrder: null },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'shell', 'files', 'git', 'queue', 'notes']);
  assert.equal(ordered.separatorIndex, 4);
});

test('tabOrder 1 puts a plugin right after the first built-in tab, with no separator', () => {
  const ordered = orderTabs(builtIn, [{ tab: 'board', tabOrder: 1 }]);
  assert.deepEqual(ordered.tabs, ['chat', 'board', 'shell', 'files', 'git']);
  assert.equal(ordered.separatorIndex, null);
});

test('a positioned plugin and an unpositioned one: the separator sits before the tail only', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'queue', tabOrder: null },
    { tab: 'board', tabOrder: 1 },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'board', 'shell', 'files', 'git', 'queue']);
  assert.equal(ordered.separatorIndex, 5);
});

test('the slot counts built-in tabs only; plugins sharing a slot keep scan order', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'third', tabOrder: 3 },
    { tab: 'first', tabOrder: 0 },
    { tab: 'also-first', tabOrder: 0 },
    { tab: 'after-chat', tabOrder: 1 },
  ]);
  assert.deepEqual(ordered.tabs, ['first', 'also-first', 'chat', 'after-chat', 'shell', 'files', 'third', 'git']);
  assert.equal(ordered.separatorIndex, null);
});

test('a slot past the end lands after the built-in tabs but ahead of the separator', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'queue', tabOrder: null },
    { tab: 'far', tabOrder: 99 },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'shell', 'files', 'git', 'far', 'queue']);
  assert.equal(ordered.separatorIndex, 5);
});

test('no plugins: the built-in tabs alone, no separator', () => {
  const ordered = orderTabs(builtIn, []);
  assert.deepEqual(ordered.tabs, builtIn);
  assert.equal(ordered.separatorIndex, null);
});
