import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

/**
 * A run's caller archives its session right after the response. The sessions
 * watcher polls transcripts every 6 s, so the run's last lines are usually
 * not indexed yet — and indexing a transcript newer than the row un-archives
 * it. `archiveSessionAfterRun` brings the row up to date with its transcript
 * before archiving, so the next poll leaves it archived.
 */

// The Claude synchronizer resolves `os.homedir()` when the registry module is
// first imported: HOME must point at the fixture before that import.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-archive-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { sessionSynchronizerService } = await import(
  '@/modules/providers/services/session-synchronizer.service.js'
);
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

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-archive-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const PROJECT_PATH = '/tmp/session-archive-project';
const transcriptDirectory = path.join(fixtureHome, '.claude', 'projects', '-tmp-session-archive-project');

/**
 * An app session whose transcript the index has seen once (mid-run), after
 * which the run wrote its last lines: the file is newer than the row, as it
 * is when the caller archives before the watcher's next poll.
 */
async function createRunSession(appId: string, nativeId: string, options: { indexed: boolean }): Promise<string> {
  await mkdir(transcriptDirectory, { recursive: true });
  const transcript = path.join(transcriptDirectory, `${nativeId}.jsonl`);
  await writeFile(transcript, `${JSON.stringify({ type: 'user', sessionId: nativeId, cwd: PROJECT_PATH })}\n`);
  const startedAt = new Date(Date.now() - 60_000);
  await utimes(transcript, startedAt, startedAt);

  sessionsDb.createAppSession(appId, 'claude', PROJECT_PATH, 'Scheduled run');
  sessionsDb.assignProviderSessionId(appId, nativeId);
  if (options.indexed) {
    await sessionSynchronizerService.synchronizeProviderFile('claude', transcript);
    assert.equal(sessionsDb.getSessionById(appId)?.jsonl_path, transcript);
  }

  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', sessionId: nativeId, cwd: PROJECT_PATH })}\n`);
  const endedAt = new Date(Date.now() - 1_000);
  await utimes(transcript, endedAt, endedAt);
  return transcript;
}

test('a plain archive right after a run is undone by the next watcher poll (the race this guards)', async () => {
  await withIsolatedDatabase(async () => {
    const transcript = await createRunSession('app-plain', 'native-plain', { indexed: true });

    await sessionsService.deleteOrArchiveSessionById('app-plain');
    assert.equal(sessionsDb.getSessionById('app-plain')?.isArchived, 1);

    await sessionSynchronizerService.synchronizeProviderFile('claude', transcript);
    assert.equal(sessionsDb.getSessionById('app-plain')?.isArchived, 0, 'the newer transcript re-opens the row');
  });
});

test('archiveSessionAfterRun keeps the session archived through the next watcher poll', async () => {
  await withIsolatedDatabase(async () => {
    const transcript = await createRunSession('app-run', 'native-run', { indexed: true });

    const result = await sessionsService.archiveSessionAfterRun('app-run');
    assert.deepEqual(result, { sessionId: 'app-run', action: 'archived', deletedFromDisk: false });

    await sessionSynchronizerService.synchronizeProviderFile('claude', transcript);
    const row = sessionsDb.getSessionById('app-run');
    assert.equal(row?.isArchived, 1, 'nothing newer on disk: the row stays archived');
    assert.equal(row?.jsonl_path, transcript, 'the transcript is kept on disk and on the row');
  });
});

test('archiveSessionAfterRun indexes a transcript the row does not know yet before archiving', async () => {
  await withIsolatedDatabase(async () => {
    const transcript = await createRunSession('app-short', 'native-short', { indexed: false });
    assert.equal(sessionsDb.getSessionById('app-short')?.jsonl_path ?? null, null);

    await sessionsService.archiveSessionAfterRun('app-short');

    await sessionSynchronizerService.synchronizeProviderFile('claude', transcript);
    const row = sessionsDb.getSessionById('app-short');
    assert.equal(row?.jsonl_path, transcript);
    assert.equal(row?.isArchived, 1);
  });
});

test('a session that gets new activity after archiving comes back, as any archived session does', async () => {
  await withIsolatedDatabase(async () => {
    const transcript = await createRunSession('app-again', 'native-again', { indexed: true });
    await sessionsService.archiveSessionAfterRun('app-again');

    await appendFile(transcript, `${JSON.stringify({ type: 'user', sessionId: 'native-again', cwd: PROJECT_PATH })}\n`);
    const later = new Date();
    await utimes(transcript, later, later);
    await sessionSynchronizerService.synchronizeProviderFile('claude', transcript);
    assert.equal(sessionsDb.getSessionById('app-again')?.isArchived, 0);
  });
});

test('archiveSessionAfterRun refuses an unknown session with 404', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      () => sessionsService.archiveSessionAfterRun('nope'),
      (error: { statusCode?: number }) => error.statusCode === 404,
    );
  });
});
