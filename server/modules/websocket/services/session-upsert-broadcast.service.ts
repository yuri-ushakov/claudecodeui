import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  SessionArchivedEvent,
  SessionRestoredEvent,
  SessionUpsertedEvent,
  SessionUpsertedProject,
} from '@/shared/types.js';

type SessionRowSnapshot = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 *
 * The same file builds the other two sidebar session deltas (hq fork):
 * `session_archived` (a session left the active lists — archive or
 * force-delete) and `session_restored` (it came back). Both are sent from
 * `sessionsService`, the one place a session's archive flag is changed by a
 * user or API action, so every caller announces them the same way.
 */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
): Promise<SessionUpsertedEvent | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  const row = sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  return {
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: await buildSessionProject(row.project_path),
    timestamp: new Date().toISOString(),
  };
}

/** The owning project of a session row as the sidebar deltas carry it, or null when it has none. */
async function buildSessionProject(
  projectPath: string | null | undefined,
): Promise<SessionUpsertedProject | null> {
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  if (!project) {
    return null;
  }

  const displayName = project.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return {
    projectId: project.project_id,
    path: project.project_path,
    fullPath: project.project_path,
    displayName,
    isStarred: Boolean(project.isStarred),
  };
}

/**
 * Builds `session_archived` from a snapshot of the row taken before the change,
 * not by looking it up: after a force-delete the row no longer exists.
 */
async function buildSessionArchivedEvent(
  row: SessionRowSnapshot,
  action: SessionArchivedEvent['action'],
): Promise<SessionArchivedEvent> {
  return {
    kind: 'session_archived',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    provider: row.provider as SessionArchivedEvent['provider'],
    action,
    project: await buildSessionProject(row.project_path),
    timestamp: new Date().toISOString(),
  };
}

/** `session_restored` is the upsert payload of the now-active row under its own kind; null if the row is still archived or gone. */
async function buildSessionRestoredEvent(sessionId: string): Promise<SessionRestoredEvent | null> {
  const upsert = await buildSessionUpsertedEvent(sessionId);
  return upsert ? { ...upsert, kind: 'session_restored' } : null;
}

function sendToConnectedClients(payloads: string[]): void {
  if (payloads.length === 0) {
    return;
  }

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const payload of payloads) {
        client.send(payload);
      }
    }
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void> {
  const event = await buildSessionUpsertedEvent(sessionIdOrProviderSessionId);
  if (event) {
    sendToConnectedClients([JSON.stringify(event)]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once — the client
 * set is walked once for the whole batch rather than once per session.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  const payloads: string[] = [];
  for (const sessionId of sessionIds) {
    const event = await buildSessionUpsertedEvent(sessionId);
    if (event) {
      payloads.push(JSON.stringify(event));
    }
  }

  sendToConnectedClients(payloads);
}

/**
 * Announces that a session left the active lists. `row` is the row as it was
 * before the archive/delete (see `buildSessionArchivedEvent`).
 */
export async function broadcastSessionArchived(
  row: SessionRowSnapshot,
  action: SessionArchivedEvent['action'],
): Promise<void> {
  const event = await buildSessionArchivedEvent(row, action);
  sendToConnectedClients([JSON.stringify(event)]);
}

/** Announces that an archived session is active again. */
export async function broadcastSessionRestored(sessionId: string): Promise<void> {
  const event = await buildSessionRestoredEvent(sessionId);
  if (event) {
    sendToConnectedClients([JSON.stringify(event)]);
  }
}

/** @internal Exported for the broadcast tests, which assert the payload shape directly. */
export { buildSessionArchivedEvent, buildSessionRestoredEvent, buildSessionUpsertedEvent };
