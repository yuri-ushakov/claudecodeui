import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * `session_archived` / `session_restored`: a session archived or restored by
 * anyone but this tab (another tab, the hq fork's API-key archive route used
 * by scheduled runs) used to stay in the sidebar until a reload, because the
 * only delta was `session_upserted` and its builder skips archived rows.
 *
 * The tab that archives a session also removes the row itself
 * (`handleSessionDelete`), and its own event arrives too — in either order —
 * so applying both must leave the same state as applying one.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const PROJECT = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const buildProject = (sessionIds: string[]): Project => ({
  ...PROJECT,
  sessions: sessionIds.map((id) => ({ id, summary: `title ${id}`, __provider: 'claude' }) as ProjectSession),
  sessionMeta: { hasMore: false, total: sessionIds.length },
});

type ServerEventListener = (event: Record<string, unknown>) => void;
const listeners = new Set<ServerEventListener>();
const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const archivedEvent = (sessionId: string, providerSessionId: string | null = null) => ({
  kind: 'session_archived',
  sessionId,
  providerSessionId,
  provider: 'claude',
  action: 'archived',
  project: PROJECT,
  timestamp: '2026-10-07T08:12:00.000Z',
});

const restoredEvent = (sessionId: string) => ({
  kind: 'session_restored',
  sessionId,
  providerSessionId: null,
  provider: 'claude',
  session: { id: sessionId, summary: `title ${sessionId}`, messageCount: 0, lastActivity: '2026-10-07T08:00:00.000Z' },
  project: PROJECT,
  timestamp: '2026-10-07T08:20:00.000Z',
});

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>, urlSessionId?: string) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(() =>
    useProjectsState({
      sessionId: urlSessionId,
      navigate: navigate as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

const sessionIdsOf = (projects: Project[]) => (projects[0]?.sessions ?? []).map((session) => session.id);

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('an archived background session leaves the project list and the total without navigating', async () => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject(['open', 'scheduled'])] });
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 2));

  await act(async () => {
    emit(archivedEvent('scheduled'));
  });

  assert.deepEqual(sessionIdsOf(result.current.projects), ['open']);
  assert.equal(result.current.projects[0]?.sessionMeta?.total, 1);
  assert.deepEqual(navigate.mock.calls, []);
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('scheduled'), false);
  assert.deepEqual(result.current.sidebarSharedProps.sessionArchiveChange, {
    seq: 1,
    sessionIds: ['scheduled'],
    archived: true,
  });
});

test('a row still listed under its provider id is removed too', async () => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject(['native-1', 'other'])] });
  const { result } = await renderProjectsState(vi.fn());
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 2));

  await act(async () => {
    emit(archivedEvent('app-1', 'native-1'));
  });

  assert.deepEqual(sessionIdsOf(result.current.projects), ['other']);
  assert.equal(result.current.projects[0]?.sessionMeta?.total, 1);
});

test('archiving the open session closes it, as a local archive does', async () => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject(['open', 'other'])] });
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate, 'open');
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 2));
  act(() => {
    result.current.handleSessionSelect({ id: 'open' } as ProjectSession);
  });
  navigate.mockClear();

  await act(async () => {
    emit(archivedEvent('open'));
  });

  assert.equal(result.current.selectedSession, null);
  assert.deepEqual(navigate.mock.calls, [['/']]);
  assert.deepEqual(sessionIdsOf(result.current.projects), ['other']);
});

test('the local archive and its own event, in either order, remove the row once', async () => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject(['a', 'b', 'c'])] });
  const { result } = await renderProjectsState(vi.fn());
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 3));

  // Local first, then the broadcast.
  act(() => {
    result.current.handleSessionDelete('a');
  });
  const afterLocal = result.current.projects;
  await act(async () => {
    emit(archivedEvent('a'));
  });
  assert.equal(result.current.projects, afterLocal, 'a second removal of a gone row changes nothing');

  // Broadcast first, then the local handler.
  await act(async () => {
    emit(archivedEvent('b'));
  });
  act(() => {
    result.current.handleSessionDelete('b');
  });

  assert.deepEqual(sessionIdsOf(result.current.projects), ['c']);
  assert.equal(result.current.projects[0]?.sessionMeta?.total, 1);
});

test('a restored session is re-inserted without an attention mark', async () => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject(['other'])] });
  const { result } = await renderProjectsState(vi.fn());
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 1));

  await act(async () => {
    emit(restoredEvent('back'));
  });

  assert.deepEqual(sessionIdsOf(result.current.projects).sort(), ['back', 'other']);
  assert.equal(result.current.projects[0]?.sessionMeta?.total, 2);
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has('back'), false);
  assert.equal(result.current.externalMessageUpdate, 0);
  assert.deepEqual(result.current.sidebarSharedProps.sessionArchiveChange, {
    seq: 1,
    sessionIds: ['back'],
    archived: false,
  });
});
