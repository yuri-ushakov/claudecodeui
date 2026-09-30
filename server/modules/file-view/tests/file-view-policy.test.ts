import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolvePathUnderRoots } from '@/shared/utils.js';

import { createFileViewPolicy } from '../file-view-policy.js';

/**
 * Real directories beside this file: a temp directory would sit under `/tmp`,
 * which is a built-in read-only root, and hide what the policy itself allows.
 */
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

async function withDirectories(run: (directories: { configured: string; project: string; outside: string }) => Promise<void>) {
  const configured = await fsPromises.mkdtemp(path.join(testDirectory, 'view-configured-'));
  const project = await fsPromises.mkdtemp(path.join(testDirectory, 'view-project-'));
  const outside = await fsPromises.mkdtemp(path.join(testDirectory, 'view-outside-'));
  try {
    await run({ configured, project, outside });
  } finally {
    await Promise.all([configured, project, outside].map((directory) =>
      fsPromises.rm(directory, { recursive: true, force: true })));
  }
}

function createPolicy(configured: string[], projects: string[], builtIn: (targetPath: string) => Promise<string | null> = async () => null) {
  return createFileViewPolicy({
    resolveBuiltInRoot: builtIn,
    configuredRoots: configured,
    listProjectPaths: () => projects,
    resolveUnderRoots: resolvePathUnderRoots,
  });
}

test('a file under a configured root resolves; the same file outside every root does not', async () => {
  await withDirectories(async ({ configured, outside }) => {
    const report = path.join(configured, 'reports', 'night.md');
    await fsPromises.mkdir(path.dirname(report));
    await fsPromises.writeFile(report, '# night', 'utf8');
    const stray = path.join(outside, 'night.md');
    await fsPromises.writeFile(stray, '# stray', 'utf8');

    const policy = createPolicy([configured], []);
    assert.equal(await policy.resolveReadablePath(report), await fsPromises.realpath(report));
    assert.equal(await policy.resolveReadablePath(stray), null);
  });
});

test('a registered project directory is a root, read at call time', async () => {
  await withDirectories(async ({ project }) => {
    const analysis = path.join(project, 'docs', 'analysis.md');
    await fsPromises.mkdir(path.dirname(analysis));
    await fsPromises.writeFile(analysis, '# analysis', 'utf8');

    const projects: string[] = [];
    const policy = createPolicy([], projects);
    assert.equal(await policy.resolveReadablePath(analysis), null);

    projects.push(project);
    assert.equal(await policy.resolveReadablePath(analysis), await fsPromises.realpath(analysis));
  });
});

test('a symlink planted under a root that leads outside is refused', async () => {
  await withDirectories(async ({ configured, outside }) => {
    await fsPromises.writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
    await fsPromises.symlink(outside, path.join(configured, 'escape'));

    const policy = createPolicy([configured], []);
    assert.equal(await policy.resolveReadablePath(path.join(configured, 'escape', 'secret.md')), null);
  });
});

test('a `..` segment cannot climb out of a root', async () => {
  await withDirectories(async ({ configured, outside }) => {
    await fsPromises.writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
    const policy = createPolicy([configured], []);
    const climbing = path.join(configured, '..', path.basename(outside), 'secret.md');
    assert.equal(await policy.resolveReadablePath(climbing), null);
  });
});

test('relative paths and the root itself are handled: relative refused, root resolved', async () => {
  await withDirectories(async ({ configured }) => {
    const policy = createPolicy([configured], []);
    assert.equal(await policy.resolveReadablePath('reports/night.md'), null);
    assert.equal(await policy.resolveReadablePath(configured), await fsPromises.realpath(configured));
  });
});

test('the built-in read-only roots are asked first', async () => {
  const policy = createPolicy([], [], async (targetPath) => (targetPath === '/tmp/agent.output' ? '/tmp/agent.output' : null));
  assert.equal(await policy.resolveReadablePath('/tmp/agent.output'), '/tmp/agent.output');
  assert.equal(await policy.resolveReadablePath('/tmp/other.output'), null);
});

test('roots() lists configured roots and project directories together', () => {
  const policy = createPolicy(['/data'], ['/home/yuri/Projects/hq']);
  assert.deepEqual(policy.roots(), ['/data', '/home/yuri/Projects/hq']);
});
