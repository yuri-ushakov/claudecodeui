import assert from 'node:assert/strict';

import { test } from 'vitest';

import { orderTabs } from '@/modules/project-workspace/utils/workspaceTabOrder';

// The built-in row as WorkspaceTabs declares it: Files right after Chat.
const builtIn = ['chat', 'files', 'shell', 'git'];

test('plugins without a slot follow the built-in tabs behind a separator', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'queue', tabOrder: null },
    { tab: 'notes', tabOrder: null },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'files', 'shell', 'git', 'queue', 'notes']);
  assert.equal(ordered.separatorIndex, 4);
});

test('tabOrder 1 puts a plugin second, right after Chat, with no separator', () => {
  const ordered = orderTabs(builtIn, [{ tab: 'board', tabOrder: 1 }]);
  assert.deepEqual(ordered.tabs, ['chat', 'board', 'files', 'shell', 'git']);
  assert.equal(ordered.separatorIndex, null);
});

test('tabOrder 0 puts a plugin first, before Chat', () => {
  const ordered = orderTabs(builtIn, [{ tab: 'first', tabOrder: 0 }]);
  assert.deepEqual(ordered.tabs, ['first', 'chat', 'files', 'shell', 'git']);
  assert.equal(ordered.separatorIndex, null);
});

test('a positioned plugin and an unpositioned one: the separator sits before the tail only', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'queue', tabOrder: null },
    { tab: 'board', tabOrder: 1 },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'board', 'files', 'shell', 'git', 'queue']);
  assert.equal(ordered.separatorIndex, 5);
});

test('tabOrder is the index in the row: 1, 2, 3 stack right after Chat, built-ins fill the rest', () => {
  const ordered = orderTabs([...builtIn, 'browser', 'tasks'], [
    { tab: 'hq-schedules', tabOrder: 3 },
    { tab: 'hq-board', tabOrder: 1 },
    { tab: 'hq-reports', tabOrder: 2 },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'hq-board', 'hq-reports', 'hq-schedules', 'files', 'shell', 'git', 'browser', 'tasks']);
  assert.equal(ordered.separatorIndex, null);
});

test('a gap between requested indexes is filled by built-in tabs', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'fourth', tabOrder: 3 },
    { tab: 'second', tabOrder: 1 },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'second', 'files', 'fourth', 'shell', 'git']);
  assert.equal(ordered.separatorIndex, null);
});

test('plugins asking for the same index keep scan order; a taken index pushes the next plugin along', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'a', tabOrder: 0 },
    { tab: 'b', tabOrder: 0 },
    { tab: 'c', tabOrder: 1 },
  ]);
  assert.deepEqual(ordered.tabs, ['a', 'b', 'c', 'chat', 'files', 'shell', 'git']);
  assert.equal(ordered.separatorIndex, null);
});

test('an index past the end lands after the built-in tabs but ahead of the separator', () => {
  const ordered = orderTabs(builtIn, [
    { tab: 'queue', tabOrder: null },
    { tab: 'far', tabOrder: 99 },
  ]);
  assert.deepEqual(ordered.tabs, ['chat', 'files', 'shell', 'git', 'far', 'queue']);
  assert.equal(ordered.separatorIndex, 5);
});

test('no plugins: the built-in tabs alone, no separator', () => {
  const ordered = orderTabs(builtIn, []);
  assert.deepEqual(ordered.tabs, builtIn);
  assert.equal(ordered.separatorIndex, null);
});
