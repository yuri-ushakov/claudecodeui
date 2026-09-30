import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A `chat.send` runs under the tool policy stored for the user, whatever the
 * sending page had in memory. Two devices therefore keep one conversation on
 * one policy - and on one process, when that policy keeps it alive.
 */

const SESSION_ID = 'policy-session';
const USER_ID = 1;

type RunCall = { options: Record<string, unknown> };

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (data: string) => void };
  socket.readyState = 1;
  socket.send = () => {};
  return socket;
}

async function withGateway(runTest: (context: { socket: ReturnType<typeof createFakeSocket>; runs: RunCall[] }) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-tool-policy-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const socket = createFakeSocket();

  try {
    // Preferences belong to a user row; the auth layer reports this id.
    const created = userDb.createUser('policy-user', 'not-a-real-hash');
    assert.equal(Number(created.id), USER_ID);
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Policy session', now, now, null);

    handleChatConnection(
      socket as never,
      { user: { id: USER_ID } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (_provider: string, _command: string, options: Record<string, unknown>) => {
            runs.push({ options });
          },
        } as never,
      },
    );

    await runTest({ socket, runs });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const staleClientSettings = { allowedTools: [], disallowedTools: [], skipPermissions: false, keepSessionAlive: false };

test('a turn runs under the policy stored for the user, not the one the page sent', async () => {
  await withGateway(async ({ socket, runs }) => {
    const storedPolicy = { allowedTools: ['Bash(git:*)'], disallowedTools: [], skipPermissions: false, keepSessionAlive: true };
    userPreferencesDb.savePreferences(USER_ID, { claudePermissions: storedPolicy });

    // The page was loaded before the switch was flipped elsewhere.
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hello',
      options: { toolsSettings: staleClientSettings, skipPermissions: false },
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].options.toolsSettings, storedPolicy);
    assert.equal(runs[0].options.toolsSettingsSource, 'server');
  });
});

test('the page\'s copy is the fallback when the user has never saved a policy', async () => {
  await withGateway(async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hello',
      options: { toolsSettings: staleClientSettings },
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].options.toolsSettings, staleClientSettings);
    assert.equal(runs[0].options.toolsSettingsSource, 'client');
  });
});

test('skipPermissions follows the resolved policy', async () => {
  await withGateway(async ({ socket, runs }) => {
    userPreferencesDb.savePreferences(USER_ID, { claudePermissions: { allowedTools: [], disallowedTools: [], skipPermissions: true } });

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hello',
      options: { toolsSettings: staleClientSettings, skipPermissions: false },
    }));
    await settle();

    assert.equal(runs[0].options.skipPermissions, true);
  });
});
