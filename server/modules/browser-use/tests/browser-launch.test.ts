import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBrowserLaunchOptions,
  isBrowserExecutableInstalled,
  readBrowserLaunchConfig,
  resolveBrowserExecutablePath,
} from '@/modules/browser-use/browser-launch.js';

test('launch config defaults to the full chromium channel in headless mode', () => {
  assert.deepEqual(readBrowserLaunchConfig({}), { channel: 'chromium', headless: true });
  assert.deepEqual(readBrowserLaunchConfig({ CLOUDCLI_BROWSER_USE_CHANNEL: '  ' }), { channel: 'chromium', headless: true });
});

test('launch config reads channel and headless from the environment', () => {
  assert.deepEqual(
    readBrowserLaunchConfig({ CLOUDCLI_BROWSER_USE_CHANNEL: ' chrome ', CLOUDCLI_BROWSER_USE_HEADLESS: 'false' }),
    { channel: 'chrome', headless: false },
  );
  for (const word of ['0', 'no', 'OFF', 'False']) {
    assert.equal(readBrowserLaunchConfig({ CLOUDCLI_BROWSER_USE_HEADLESS: word }).headless, false, word);
  }
  for (const word of ['1', 'true', 'yes', 'anything']) {
    assert.equal(readBrowserLaunchConfig({ CLOUDCLI_BROWSER_USE_HEADLESS: word }).headless, true, word);
  }
});

test('launch options select the full browser and hide automation markers', () => {
  const options = buildBrowserLaunchOptions({ channel: 'chromium', headless: true });

  assert.equal(options.channel, 'chromium');
  assert.equal(options.headless, true);
  assert.ok(options.args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(options.args.includes('--disable-dev-shm-usage'));
  assert.deepEqual(options.ignoreDefaultArgs, ['--enable-automation']);
});

test('launch options carry the configured channel and headless flag', () => {
  const options = buildBrowserLaunchOptions({ channel: 'chrome', headless: false });

  assert.equal(options.channel, 'chrome');
  assert.equal(options.headless, false);
});

test('launch options are fresh copies, so callers cannot mutate the shared defaults', () => {
  const first = buildBrowserLaunchOptions({ channel: 'chromium', headless: true });
  first.args.push('--custom');
  first.ignoreDefaultArgs.length = 0;

  const second = buildBrowserLaunchOptions({ channel: 'chromium', headless: true });
  assert.ok(!second.args.includes('--custom'));
  assert.deepEqual(second.ignoreDefaultArgs, ['--enable-automation']);
});

test('chromium channel asks playwright for its public executable path', () => {
  const playwright = { chromium: { executablePath: () => '/cache/chromium-1243/chrome-linux64/chrome' } };

  assert.equal(
    resolveBrowserExecutablePath(playwright, { channel: 'chromium', headless: true }),
    '/cache/chromium-1243/chrome-linux64/chrome',
  );
});

test('chromium channel reports null when playwright cannot answer', () => {
  assert.equal(resolveBrowserExecutablePath({ chromium: { executablePath: () => '' } }, { channel: 'chromium', headless: true }), null);
  assert.equal(resolveBrowserExecutablePath({ chromium: { executablePath: () => { throw new Error('boom'); } } }, { channel: 'chromium', headless: true }), null);
  assert.equal(resolveBrowserExecutablePath(null, { channel: 'chromium', headless: true }), null);
});

test('branded channel path comes from the playwright registry when the package is installed', (t) => {
  let playwright: any;
  try {
    playwright = createRequire(import.meta.url)('playwright');
  } catch {
    t.skip('playwright is not installed');
    return;
  }

  const chromePath = resolveBrowserExecutablePath(playwright, { channel: 'chrome', headless: true });
  assert.ok(chromePath === null || typeof chromePath === 'string');
  if (process.platform === 'linux' && chromePath) {
    assert.equal(chromePath, '/opt/google/chrome/chrome');
  }
  assert.equal(resolveBrowserExecutablePath(playwright, { channel: 'no-such-channel', headless: true }), null);
});

test('executable is installed only when the file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-launch-'));
  const file = path.join(dir, 'chrome');
  fs.writeFileSync(file, '');

  assert.equal(isBrowserExecutableInstalled(file), true);
  assert.equal(isBrowserExecutableInstalled(path.join(dir, 'missing')), false);
  assert.equal(isBrowserExecutableInstalled(null), false);
  assert.equal(isBrowserExecutableInstalled(''), false);

  fs.rmSync(dir, { recursive: true, force: true });
});
