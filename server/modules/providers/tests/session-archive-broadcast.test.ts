import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/index.js';

/**
 * Archiving, deleting and restoring a session are announced to every open
 * client (`session_archived` / `session_restored`). Before, only the tab that
 * clicked archive dropped the row; a session archived by the API-key route
 * (hq scheduled runs) or from another tab stayed in every sidebar until a
 * reload, because `session_upserted` deliberately skips archived rows.
 */

// The sessions service pulls in the provider registry, whose Claude
// synchronizer resolves `os.homedir()` at import: keep it off the real home.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-archive-broadcast-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');

process.on('exit', () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-archive-broadcast-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function connect(): FakeConnection {
  const connection = new FakeConnection();
  connectedClients.add(connection as never);
  return connection;
}

test('archiving a session announces session_archived with both ids and the owning project', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');
    const connection = connect();

    await sessionsService.deleteOrArchiveSessionById('app-1');

    assert.equal(connection.frames.length, 1);
    const [frame] = connection.frames;
    assert.equal(frame.kind, 'session_archived');
    assert.equal(frame.sessionId, 'app-1');
    assert.equal(frame.providerSessionId, 'native-1');
    assert.equal(frame.provider, 'claude');
    assert.equal(frame.action, 'archived');
    assert.equal((frame.project as { path?: string } | null)?.path, '/workspace/demo');
    assert.equal(typeof frame.timestamp, 'string');
  });
});

test('a force-delete announces session_archived with action "deleted" although the row is gone', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'claude', '/workspace/demo');
    const connection = connect();

    await sessionsService.deleteOrArchiveSessionById('app-2', { force: true, deletedFromDisk: false });

    assert.equal(sessionsDb.getSessionById('app-2'), null);
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_archived');
    assert.equal(connection.frames[0].sessionId, 'app-2');
    assert.equal(connection.frames[0].action, 'deleted');
    assert.equal(connection.frames[0].providerSessionId, null);
  });
});

test('restoring a session announces session_restored with the upsert payload', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo', 'Nightly run');
    await sessionsService.deleteOrArchiveSessionById('app-3');
    const connection = connect();

    const result = await sessionsService.restoreSessionById('app-3');

    assert.deepEqual(result, { sessionId: 'app-3', isArchived: false });
    assert.equal(connection.frames.length, 1);
    const [frame] = connection.frames;
    assert.equal(frame.kind, 'session_restored');
    assert.equal(frame.sessionId, 'app-3');
    assert.equal((frame.session as { summary?: string }).summary, 'Nightly run');
    assert.equal((frame.project as { path?: string } | null)?.path, '/workspace/demo');
  });
});

test('an unknown session is still a 404 and announces nothing', async () => {
  await withIsolatedDatabase(async () => {
    const connection = connect();

    await assert.rejects(sessionsService.deleteOrArchiveSessionById('missing'), /was not found/);
    await assert.rejects(sessionsService.restoreSessionById('missing'), /was not found/);

    assert.deepEqual(connection.frames, []);
  });
});
