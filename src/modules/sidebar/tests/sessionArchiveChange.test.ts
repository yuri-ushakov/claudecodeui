import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem, SidebarSessionArchiveChange } from '@/shared/types';

/**
 * The Conversations and Archived lists live in the sidebar controller. A
 * session archived elsewhere (another tab, the API-key archive route) reaches
 * them as `sessionArchiveChange` from `useProjectsState`: the row leaves
 * Conversations and the Archived list is refetched. The change may land after
 * the local archive already removed the row, so it must not count it twice.
 */

const recentConversationsResponse = vi.fn();
const archivedSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversationsResponse(),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => archivedSessionsResponse(),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const conversation = (sessionId: string): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'repo',
  sessionTitle: sessionId,
  lastActivity: '2026-10-07T08:00:00.000Z',
});

// Stable across renders: the controller derives state from these, and a fresh
// array or Set per render re-runs those effects forever.
const noSessions: ReadonlySet<string> = new Set<string>();
const noProjects: Project[] = [];

const renderController = () => renderHook(
  ({ sessionArchiveChange }: { sessionArchiveChange: SidebarSessionArchiveChange | null }) => useSidebarController({
    projects: noProjects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: noSessions,
    backgroundSessionIds: noSessions,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    sessionArchiveChange,
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }),
  { initialProps: { sessionArchiveChange: null as SidebarSessionArchiveChange | null } },
);

beforeEach(() => {
  localStorage.clear();
  recentConversationsResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: { conversations: [conversation('s1'), conversation('s2'), conversation('s3')], total: 3, hasMore: false },
    }),
  });
  archivedSessionsResponse.mockReset();
  archivedSessionsResponse.mockResolvedValue({ ok: true, json: async () => ({ data: { sessions: [] } }) });
});

test('an archive change drops the row from Conversations once and refetches Archived', async () => {
  const rendered = renderController();
  act(() => {
    rendered.result.current.setSearchMode('conversations');
  });
  await waitFor(() => assert.equal(rendered.result.current.recentConversations.length, 3));
  const archivedFetchesBefore = archivedSessionsResponse.mock.calls.length;

  const change: SidebarSessionArchiveChange = { seq: 1, sessionIds: ['s2'], archived: true };
  rendered.rerender({ sessionArchiveChange: change });

  await waitFor(() => assert.deepEqual(
    rendered.result.current.recentConversations.map((row) => row.sessionId),
    ['s1', 's3'],
  ));
  assert.equal(rendered.result.current.recentConversationsTotal, 2);
  await waitFor(() => assert.equal(archivedSessionsResponse.mock.calls.length, archivedFetchesBefore + 1));

  // The same change seen again (a re-render) is not applied twice, and a new
  // change for a row that is already gone leaves the total alone.
  rendered.rerender({ sessionArchiveChange: { ...change } });
  rendered.rerender({ sessionArchiveChange: { seq: 2, sessionIds: ['s2'], archived: true } });
  await waitFor(() => assert.equal(archivedSessionsResponse.mock.calls.length, archivedFetchesBefore + 2));
  assert.equal(rendered.result.current.recentConversations.length, 2);
  assert.equal(rendered.result.current.recentConversationsTotal, 2);
});

test('a restore change refetches Archived and leaves Conversations alone', async () => {
  const rendered = renderController();
  act(() => {
    rendered.result.current.setSearchMode('conversations');
  });
  await waitFor(() => assert.equal(rendered.result.current.recentConversations.length, 3));
  const archivedFetchesBefore = archivedSessionsResponse.mock.calls.length;

  rendered.rerender({ sessionArchiveChange: { seq: 1, sessionIds: ['s9'], archived: false } });

  await waitFor(() => assert.equal(archivedSessionsResponse.mock.calls.length, archivedFetchesBefore + 1));
  assert.equal(rendered.result.current.recentConversations.length, 3);
  assert.equal(rendered.result.current.recentConversationsTotal, 3);
});
