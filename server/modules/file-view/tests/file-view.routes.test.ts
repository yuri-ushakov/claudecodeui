import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createFileViewRouter, readViewPath } from '../file-view.routes.js';
import type { FileViewService } from '../file-view.service.js';

async function withServer(service: FileViewService, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/api/files', createFileViewRouter(service, { error: () => undefined }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('readViewPath returns the path as sent and rejects a missing, blank or repeated one', () => {
  assert.equal(readViewPath({ path: '/home/yuri/Projects/hq/reports/a b.md' }), '/home/yuri/Projects/hq/reports/a b.md');
  for (const query of [{}, { path: '' }, { path: '   ' }, { path: ['/a.md', '/b.md'] }]) {
    assert.throws(() => readViewPath(query as never), (error: unknown) =>
      error instanceof AppError && error.statusCode === 400);
  }
});

test('GET /api/files/view decodes the path from the query and answers the service result', async () => {
  const requested: string[] = [];
  const service: FileViewService = {
    readFile: async (requestedPath) => {
      requested.push(requestedPath);
      return { path: requestedPath, name: 'night mew.md', size: 6, content: '# hi' };
    },
  };

  await withServer(service, async (baseUrl) => {
    const filePath = '/home/yuri/Projects/BinanceGate/docs/analysis_2026-09-30_night mew.md';
    const response = await fetch(`${baseUrl}/api/files/view?path=${encodeURIComponent(filePath)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: filePath, name: 'night mew.md', size: 6, content: '# hi' });
    assert.deepEqual(requested, [filePath]);
  });
});

test('GET /api/files/view without a path is a 400 and never reaches the service', async () => {
  let calls = 0;
  const service: FileViewService = {
    readFile: async () => { calls += 1; throw new Error('unexpected'); },
  };

  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/files/view`);
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });
});

test('service errors keep their status code and message', async () => {
  const service: FileViewService = {
    readFile: async () => {
      throw new AppError('Path is outside the directories the viewer may read', { code: 'PATH_OUTSIDE_VIEW_ROOTS', statusCode: 403 });
    },
  };

  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/files/view?path=%2Fetc%2Fpasswd`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Path is outside the directories the viewer may read',
      code: 'PATH_OUTSIDE_VIEW_ROOTS',
    });
  });
});
