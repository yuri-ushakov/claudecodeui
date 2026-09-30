import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * `claudePermissions` is one preference with two writers: this dialog and
 * "remember this rule" in the chat. The dialog used to save the whole object
 * from its own state, which it had read from the page's copy of the settings
 * when it opened. On a page that had not caught up with a switch flipped
 * elsewhere, any save - even one made for an unrelated tab of the dialog -
 * put the stale value back for every device. That is how the "keep one
 * process for the conversation" switch kept turning itself off.
 *
 * Now a save sends only the fields the user changed in the dialog, and the
 * server merges them into what it holds.
 */

type SavedPayload = Record<string, unknown>;
const saved: SavedPayload[] = [];

vi.mock('@/shared/api', () => {
  const ok = async () => new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  return {
    api: {
      settings: {
        notificationPreferences: () => Promise.resolve({ ok: false }),
        saveNotificationPreferences: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      },
      user: {
        preferences: async () => new Response(JSON.stringify({ preferences: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
        savePreferences: async (updates: SavedPayload) => {
          saved.push(updates);
          return ok();
        },
        drafts: ok,
        saveDraft: ok,
        deleteDraft: ok,
      },
    },
  };
});

vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => theme };
});

vi.mock('@/modules/provider-auth', () => {
  const authStatus = {
    providerAuthStatus: {},
    checkProviderAuthStatus: () => Promise.resolve({ authenticated: false }),
    refreshProviderAuthStatuses: () => Promise.resolve(),
  };
  return { useProviderAuthStatus: () => authStatus };
});

const MIRROR_STORAGE_KEY = 'user-preferences';

/** The page's copy of the settings, as the browser holds it before the dialog opens. */
const seedPreferences = (preferences: Record<string, unknown>) => {
  localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(preferences));
};

const mirroredClaudePermissions = (): Record<string, unknown> | undefined => {
  const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
  return raw === null
    ? undefined
    : (JSON.parse(raw) as { claudePermissions?: Record<string, unknown> }).claudePermissions;
};

const claudePermissionPayloads = () => saved
  .filter((payload) => 'claudePermissions' in payload)
  .map((payload) => payload.claudePermissions);

const renderSettings = async () => {
  const { useSettingsController } = await import(
    '@/modules/settings/hooks/useSettingsController'
  );
  return renderHook(() => useSettingsController({ isOpen: true, initialTab: 'api' }));
};

/** Outlasts the dialog's auto-save debounce and the store's server-write debounce. */
const pastTheDebounces = () => new Promise((resolve) => { setTimeout(resolve, 1200); });

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  saved.length = 0;
});

afterEach(() => {
  vi.resetModules();
});

test('a save from a page whose copy is behind does not send the switch it never touched', async () => {
  // This page loaded before the switch was turned on elsewhere: its copy has
  // no `keepSessionAlive` at all, so the dialog shows it off.
  seedPreferences({ claudePermissions: { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false } });

  const { result } = await renderSettings();
  await waitFor(() => {
    assert.deepEqual(result.current.claudePermissions.allowedTools, ['Read']);
  });

  // The user does something on another tab of the dialog, which auto-saves.
  act(() => {
    result.current.setProjectSortOrder('date');
  });
  await waitFor(() => {
    assert.ok(saved.some((payload) => payload.projectSortOrder === 'date'));
  });
  await pastTheDebounces();

  assert.deepEqual(claudePermissionPayloads(), [], 'nothing about the permissions was sent');
  assert.deepEqual(
    mirroredClaudePermissions(),
    { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false },
    'and the page\'s copy was not rewritten with a materialized `false`',
  );
});

test('flipping the switch sends that field alone', async () => {
  seedPreferences({ claudePermissions: { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false } });

  const { result } = await renderSettings();
  await waitFor(() => {
    assert.deepEqual(result.current.claudePermissions.allowedTools, ['Read']);
  });

  act(() => {
    result.current.setClaudePermissions({ ...result.current.claudePermissions, keepSessionAlive: true });
  });
  await waitFor(() => {
    assert.equal(claudePermissionPayloads().length, 1);
  });

  assert.deepEqual(claudePermissionPayloads(), [{ keepSessionAlive: true }], 'the other fields ride on the server\'s copy');
  assert.deepEqual(
    mirroredClaudePermissions(),
    { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false, keepSessionAlive: true },
  );
});
