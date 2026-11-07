import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import { appConfigDb } from '@/modules/database/index.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('user browser actions share the agent lock while MCP screenshots remain opt-in', { timeout: 5000 }, async (t) => {
  const playwright = createRequire(import.meta.url)('playwright') as typeof import('playwright');
  const actions: string[] = [];
  let finishNavigation!: () => void;
  let navigationStarted!: () => void;
  const navigating = new Promise<void>((resolve) => { navigationStarted = resolve; });
  const navigationGate = new Promise<void>((resolve) => { finishNavigation = resolve; });
  const page = {
    async goto() {
      actions.push('navigate');
      navigationStarted();
      await navigationGate;
    },
    async screenshot() { return Buffer.from('preview'); },
    async title() { return 'Browser test'; },
    url() { return 'https://example.com/'; },
    viewportSize() { return { width: 1440, height: 900 }; },
    locator() { return { async innerText() { return 'Visible page'; } }; },
    mouse: { async click() { actions.push('user_click'); } },
  };
  const context = { async newPage() { return page; }, async close() {} };
  const browser = { async newContext() { return context; }, async close() {} };
  t.mock.method(appConfigDb, 'get', () => JSON.stringify({ enabled: true }));
  t.mock.method(playwright.chromium, 'executablePath', () => process.execPath);
  const launch = t.mock.method(playwright.chromium, 'launch', async () => browser);

  const session = await browserUseService.createAgentSession();
  try {
    assert.equal('screenshotDataUrl' in session, false);
    assert.equal(launch.mock.calls[0].arguments[0]?.channel, 'chromium');
    assert.ok((await browserUseService.listSessions())[0].screenshotDataUrl);

    const navigation = browserUseService.agentNavigate(session.id, 'https://example.com/');
    await navigating;
    const userAction = browserUseService.userInput(session.id, { type: 'click', x: 10, y: 20 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(actions, ['navigate']);
    finishNavigation();
    assert.equal('screenshotDataUrl' in await navigation, false);
    assert.ok((await userAction).screenshotDataUrl);
    assert.deepEqual(actions, ['navigate', 'user_click']);

    const snapshot = await browserUseService.agentSnapshot(session.id);
    assert.equal(snapshot.text, 'Visible page');
    assert.equal('screenshotDataUrl' in snapshot, false);
    assert.equal('screenshotDataUrl' in snapshot.session, false);
    assert.ok((await browserUseService.agentSnapshot(session.id, { includeScreenshot: true })).screenshotDataUrl);
    assert.ok((await browserUseService.agentScreenshot(session.id)).screenshotDataUrl);
    assert.equal('screenshotDataUrl' in (await browserUseService.agentStopSession(session.id)).session, false);
  } finally {
    finishNavigation();
    await browserUseService.deleteSession(session.id);
  }
});
