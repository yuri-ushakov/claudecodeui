import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * A file opened outside any project — the /view page — is read through the
 * viewer endpoint, shown rendered when it is markdown, and offers no save:
 * there is no project to write it to.
 */

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'from project' }) }));
const viewFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: '# Night report\n\nAll quiet.' }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, viewFile, saveFile: vi.fn() },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, readOnly }: { value: string; readOnly?: boolean }) {
    return <textarea data-testid="editor" value={value} readOnly={readOnly} onChange={() => undefined} />;
  }
  return { default: CodeMirrorStub };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

test('without a project the file is read through the viewer endpoint', async () => {
  readFile.mockClear();
  viewFile.mockClear();
  const file: CodeEditorFile = { name: 'gate.log', path: '/data/logs/gate.log' };
  render(<CodeEditor file={file} onClose={() => undefined} isSidebar />);

  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, '# Night report\n\nAll quiet.'));
  assert.deepEqual(viewFile.mock.calls, [['/data/logs/gate.log']]);
  assert.equal(readFile.mock.calls.length, 0);
  // Read-only: the source cannot be typed into and there is nothing to save
  // with. (Titles are translation keys here: i18n is not initialised in tests.)
  assert.equal(editor.readOnly, true);
  assert.equal(screen.queryByTitle('actions.save'), null);
});

test('with a project the file is read through the project endpoint and can be saved', async () => {
  readFile.mockClear();
  viewFile.mockClear();
  const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };
  render(<CodeEditor file={file} onClose={() => undefined} isSidebar />);

  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'from project'));
  assert.deepEqual(readFile.mock.calls, [['p1', '/repo/a.txt']]);
  assert.equal(viewFile.mock.calls.length, 0);
  assert.equal(editor.readOnly, false);
  assert.ok(screen.getByTitle('actions.save'));
});

test('markdown opens rendered, and the header toggle switches to the source', async () => {
  viewFile.mockClear();
  const file: CodeEditorFile = { name: 'night.md', path: '/home/yuri/Projects/hq/reports/night.md' };
  render(<CodeEditor file={file} onClose={() => undefined} isSidebar />);

  const heading = await screen.findByRole('heading', { level: 1 });
  assert.equal(heading.textContent, 'Night report');
  assert.equal(screen.queryByTestId('editor'), null);

  screen.getByTitle('actions.editMarkdown').click();
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  assert.equal(editor.value, '# Night report\n\nAll quiet.');
});
