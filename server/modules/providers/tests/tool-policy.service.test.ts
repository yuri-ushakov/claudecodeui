import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolPolicyService } from '@/modules/providers/services/tool-policy.service.js';

/**
 * The tool policy a turn runs under comes from the user's stored preferences,
 * so every device runs one conversation under the same policy; what the
 * sending page had in memory only counts when the server has nothing.
 */

const stored = {
  allowedTools: ['Bash(git:*)'],
  disallowedTools: [],
  skipPermissions: false,
  keepSessionAlive: true,
};

const stale = {
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
};

function serviceWith(preferences: Record<number, Record<string, unknown>>) {
  return createToolPolicyService({
    readPreferences: (userId) => preferences[userId] ?? {},
  });
}

test('the stored policy wins over what the client sent', () => {
  const service = serviceWith({ 1: { claudePermissions: stored } });

  const resolution = service.resolve({ provider: 'claude', userId: 1, clientToolsSettings: stale });

  assert.equal(resolution.source, 'server');
  assert.deepEqual(resolution.toolsSettings, stored);
});

test('the client\'s copy is used only when the server has none for the user', () => {
  const service = serviceWith({ 1: { cursorPermissions: { skipPermissions: true } } });

  const nothingStored = service.resolve({ provider: 'claude', userId: 1, clientToolsSettings: stale });
  assert.equal(nothingStored.source, 'client');
  assert.deepEqual(nothingStored.toolsSettings, stale);

  const noUser = service.resolve({ provider: 'claude', userId: null, clientToolsSettings: stale });
  assert.equal(noUser.source, 'client');

  const unknownProvider = service.resolve({ provider: 'someday', userId: 1, clientToolsSettings: stale });
  assert.equal(unknownProvider.source, 'client');

  const nothingAnywhere = service.resolve({ provider: 'claude', userId: 2, clientToolsSettings: undefined });
  assert.equal(nothingAnywhere.toolsSettings, undefined);
});

test('each provider reads its own key, and a user id sent as a string still finds it', () => {
  const service = serviceWith({ 7: { claudePermissions: stored, cursorPermissions: { skipPermissions: true } } });

  assert.deepEqual(service.resolve({ provider: 'cursor', userId: '7', clientToolsSettings: stale }).toolsSettings, { skipPermissions: true });
  assert.deepEqual(service.resolve({ provider: 'claude', userId: '7', clientToolsSettings: stale }).toolsSettings, stored);
});

test('a preferences read that fails falls back to the client rather than failing the turn', () => {
  const service = createToolPolicyService({
    readPreferences: () => { throw new Error('database is locked'); },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const resolution = service.resolve({ provider: 'claude', userId: 1, clientToolsSettings: stale });
    assert.equal(resolution.source, 'client');
    assert.deepEqual(resolution.toolsSettings, stale);
  } finally {
    console.error = originalError;
  }
});
