import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentScreenshotView,
  agentSessionView,
  agentSnapshotView,
  publicSessionView,
  type BrowserSessionState,
} from '@/modules/browser-use/browser-session-views.js';

const SCREENSHOT = `data:image/jpeg;base64,${'A'.repeat(100_000)}`;

function sampleSession(): BrowserSessionState {
  return {
    id: 'session-1',
    ownerId: 'agent',
    createdBy: 'agent',
    runtime: 'local',
    status: 'ready',
    url: 'https://example.com/',
    title: 'Example Domain',
    screenshotDataUrl: SCREENSHOT,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:05.000Z',
    lastAction: 'navigate:https://example.com/',
    message: 'Browser session is ready.',
    profileName: 'hq-test',
    viewport: { width: 1440, height: 900 },
    cursor: { x: 10, y: 20, actor: 'agent' },
  };
}

test('UI view hides the owner but keeps the screenshot for the preview', () => {
  const view = publicSessionView(sampleSession());

  assert.equal('ownerId' in view, false);
  assert.equal(view.screenshotDataUrl, SCREENSHOT);
  assert.equal(view.id, 'session-1');
  assert.equal(view.title, 'Example Domain');
});

test('agent view carries metadata only: no owner, no screenshot', () => {
  const view = agentSessionView(sampleSession());

  assert.equal('ownerId' in view, false);
  assert.equal('screenshotDataUrl' in view, false);
  assert.deepEqual(view, {
    id: 'session-1',
    createdBy: 'agent',
    runtime: 'local',
    status: 'ready',
    url: 'https://example.com/',
    title: 'Example Domain',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:05.000Z',
    lastAction: 'navigate:https://example.com/',
    message: 'Browser session is ready.',
    profileName: 'hq-test',
    viewport: { width: 1440, height: 900 },
    cursor: { x: 10, y: 20, actor: 'agent' },
  });
  assert.ok(JSON.stringify(view).length < 1_000, 'agent view stays small');
});

test('screenshot view is the agent view plus the screenshot', () => {
  const view = agentScreenshotView(sampleSession());

  assert.equal(view.screenshotDataUrl, SCREENSHOT);
  assert.equal('ownerId' in view, false);
  assert.equal(view.id, 'session-1');
});

test('snapshot view returns text without a screenshot by default', () => {
  const view = agentSnapshotView(sampleSession(), 'Example Domain body', false);

  assert.deepEqual(Object.keys(view).sort(), ['session', 'text']);
  assert.equal(view.text, 'Example Domain body');
  assert.equal('screenshotDataUrl' in view.session, false);
});

test('snapshot view attaches the screenshot only when asked', () => {
  const view = agentSnapshotView(sampleSession(), 'body', true);

  assert.equal(view.screenshotDataUrl, SCREENSHOT);
  assert.equal('screenshotDataUrl' in view.session, false);
});

test('views do not mutate the session state', () => {
  const session = sampleSession();
  agentSessionView(session);
  agentSnapshotView(session, 'body', false);

  assert.equal(session.ownerId, 'agent');
  assert.equal(session.screenshotDataUrl, SCREENSHOT);
});
