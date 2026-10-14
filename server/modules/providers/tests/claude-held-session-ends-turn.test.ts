import assert from 'node:assert/strict';
import test from 'node:test';

import { endsTurn } from '@/modules/providers/list/claude/claude-held-session.js';

/**
 * `endsTurn` decides when the turn a held process serves is over. The CLI
 * stamps the `result` of every turn it pushes on its own (background agents
 * reporting in) with `origin.kind === 'task-notification'`; two of those must
 * be told apart.
 */

test('an ordinary result ends the turn', () => {
  assert.equal(endsTurn({ type: 'result', num_turns: 3 }), true);
  assert.equal(endsTurn({ type: 'result' }), true);
});

test('anything but a result does not', () => {
  assert.equal(endsTurn({ type: 'assistant' }), false);
  assert.equal(endsTurn({ type: 'user' }), false);
  assert.equal(endsTurn(null as unknown as object), false);
  assert.equal(endsTurn(undefined as unknown as object), false);
});

test('the stale resume result (task-notification, no model call) is ignored', () => {
  // On resume after a process died with a running agent the CLI settles the
  // pending notification with a result of its own before looking at the
  // message the turn sent; taking it for the end would close stdin under a
  // live turn.
  assert.equal(endsTurn({ type: 'result', num_turns: 0, origin: { kind: 'task-notification' } }), false);
  assert.equal(endsTurn({ type: 'result', origin: { kind: 'task-notification' } }), false);
});

test('a follow-up turn that ran the model ends the turn served', () => {
  // A message pushed while a follow-up turn was running is absorbed into it
  // (`absorbed_mid_turn`), so this result is the only one the served turn
  // will get. 14.10.2026: without this the run stayed "running" until a
  // restart and every later message queued as a draft.
  assert.equal(endsTurn({ type: 'result', num_turns: 4, origin: { kind: 'task-notification' } }), true);
});
