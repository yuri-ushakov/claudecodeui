import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import browserUseMcpRouter from '@/modules/browser-use/browser-use-mcp.routes.js';
import { appConfigDb } from '@/modules/database/index.js';

// File validation runs before the session lookup, so these cases need no browser runtime.
const upload = (paths: string[]) => browserUseService.agentUploadFiles('missing-session', { paths });

test('upload rejects an empty file list', async () => {
  await assert.rejects(upload([]), /at least one file/i);
});

test('upload rejects relative paths', async () => {
  await assert.rejects(upload(['banner.png']), /must be absolute/i);
});

test('upload rejects missing files and directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-'));
  try {
    await assert.rejects(upload([path.join(dir, 'nope.png')]), /file not found/i);
    await assert.rejects(upload([dir]), /not a regular file/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upload rejects more than ten files', async () => {
  const many = Array.from({ length: 11 }, (_, index) => `/tmp/file-${index}.png`);
  await assert.rejects(upload(many), /at most 10/i);
});

// Whether agent tools are enabled depends on saved settings, so either message proves the files passed validation.
test('upload accepts a valid file and then fails on the unknown session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-'));
  const file = path.join(dir, 'icon.png');
  fs.writeFileSync(file, 'x');
  try {
    await assert.rejects(upload([file]), /disabled|session not found/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('successful MCP upload returns filenames without a screenshot and refreshes the UI preview', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['résumé.txt', 'attachment.zip'].map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'upload fixture');
    return fs.realpathSync(file);
  });
  const uploads: Array<{ selector: string; paths: string[] }> = [];
  let captures = 0;
  const page = {
    async screenshot() { return Buffer.alloc(75_000, ++captures); },
    async title() { return 'Upload form'; },
    url() { return 'https://example.com/upload'; },
    viewportSize() { return { width: 1440, height: 900 }; },
    locator(selector: string) {
      return { first: () => ({
        async setInputFiles(paths: string[]) { uploads.push({ selector, paths }); },
      }) };
    },
  };
  const context = { async newPage() { return page; }, async close() {} };
  const browser = { async newContext() { return context; }, async close() {} };
  const playwright = createRequire(import.meta.url)('playwright') as typeof import('playwright');
  t.mock.method(appConfigDb, 'get', () => JSON.stringify({ enabled: true }));
  t.mock.method(browserUseService, 'getMcpToken', () => 'upload-test-token');
  t.mock.method(playwright.chromium, 'executablePath', () => process.execPath);
  t.mock.method(playwright.chromium, 'launch', async () => browser);

  const session = await browserUseService.createAgentSession();
  t.after(() => browserUseService.deleteSession(session.id));
  assert.equal(session.status, 'ready');
  const app = express();
  app.use(express.json(), browserUseMcpRouter);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  for (const selector of [undefined, '#attachments']) {
    const previousPreview = (await browserUseService.listSessions())[0].screenshotDataUrl;
    const response = await fetch(`http://127.0.0.1:${address.port}/tools/browser_upload_file`, {
      method: 'POST',
      headers: { Authorization: 'Bearer upload-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, selector, paths: files }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const result = JSON.parse(body);
    assert.equal(result.success, true);
    assert.deepEqual(uploads.at(-1), { selector: selector ?? 'input[type="file"]', paths: files });
    assert.deepEqual(result.data.uploaded, files.map((file) => path.basename(file)));
    assert.equal(result.data.session.id, session.id);
    assert.equal(result.data.session.lastAction, 'upload_files:2');
    assert.equal('screenshotDataUrl' in result.data.session, false);
    assert.equal(body.includes('data:image/'), false);
    const preview = (await browserUseService.listSessions())[0].screenshotDataUrl;
    assert.ok(preview?.startsWith('data:image/jpeg;base64,'));
    assert.notEqual(preview, previousPreview);
  }
});
