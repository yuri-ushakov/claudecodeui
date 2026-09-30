import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createFileViewService } from '../file-view.service.js';

type Overrides = {
  resolved?: string | null;
  size?: number;
  isFile?: boolean;
  content?: string;
};

function createService(overrides: Overrides = {}) {
  const reads: string[] = [];
  const service = createFileViewService({
    policy: {
      resolveReadablePath: async () => ('resolved' in overrides ? overrides.resolved ?? null : '/roots/report.md'),
      roots: () => ['/roots'],
    },
    fileSystem: {
      stat: async () => ({ size: overrides.size ?? 12, isFile: () => overrides.isFile ?? true }),
      readTextFile: async (filePath) => {
        reads.push(filePath);
        return overrides.content ?? '# report';
      },
    },
    maximumFileSizeBytes: 5 * 1024 * 1024,
  });
  return { service, reads };
}

const rejectsWith = (code: string, statusCode: number) => (error: unknown) =>
  error instanceof AppError && error.code === code && error.statusCode === statusCode;

test('a readable file comes back with its resolved path, name, size and text', async () => {
  const { service, reads } = createService();
  assert.deepEqual(await service.readFile('/roots/link-to-report.md'), {
    path: '/roots/report.md',
    name: 'report.md',
    size: 12,
    content: '# report',
  });
  assert.deepEqual(reads, ['/roots/report.md']);
});

test('a relative path is a client error before the policy is asked', async () => {
  const { service, reads } = createService();
  await assert.rejects(service.readFile('reports/report.md'), rejectsWith('INVALID_VIEW_PATH', 400));
  assert.deepEqual(reads, []);
});

test('a path outside every root is forbidden and never read', async () => {
  const { service, reads } = createService({ resolved: null });
  await assert.rejects(service.readFile('/etc/passwd'), rejectsWith('PATH_OUTSIDE_VIEW_ROOTS', 403));
  assert.deepEqual(reads, []);
});

test('a directory is refused', async () => {
  const { service, reads } = createService({ isFile: false });
  await assert.rejects(service.readFile('/roots'), rejectsWith('NOT_A_FILE', 400));
  assert.deepEqual(reads, []);
});

test('a file over the size limit is refused before it is read', async () => {
  const { service, reads } = createService({ size: 5 * 1024 * 1024 + 1 });
  await assert.rejects(service.readFile('/roots/huge.log'), rejectsWith('VIEW_FILE_TOO_LARGE', 413));
  assert.deepEqual(reads, []);
});
