import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: what a file reference in a chat message hands to the
 * editor. Both suffix helpers are anchored at the end of the string, so a
 * reference picked up from the link text — which, unlike the href, keeps the
 * whitespace around it — used to reach the API with `:12 ` still attached and
 * answer a 404.
 */

const openFileInEditor = vi.fn();
const openDirectory = vi.fn();

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

const clickReference = (markdown: string, linkText: string) => {
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  render(<Markdown>{markdown}</Markdown>);
  fireEvent.click(screen.getByText(linkText));
};

test('a `path:line` reference opens the path without its suffix, at that line', () => {
  clickReference('See [src/foo.ts:130](src/foo.ts:130).', 'src/foo.ts:130');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 130]);
});

test('whitespace around a reference taken from the link text is dropped', () => {
  clickReference('See [`src/foo.ts:12` ]().', 'src/foo.ts:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 12]);
});

test('a directory reference goes to the file tree, not the editor', () => {
  clickReference('See [decisions/](decisions/).', 'decisions/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['decisions/']);
});

test('a plain file reference opens with no line', () => {
  clickReference('See [src/foo.ts](src/foo.ts).', 'src/foo.ts');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', null]);
});

test('a link to the file viewer opens in a new browser tab, not in the editor', () => {
  clickReference('Report: [night](/view?path=/home/yuri/Projects/hq/reports/night.md).', 'night');
  const anchor = screen.getByText('night').closest('a');
  assert.ok(anchor);
  assert.equal(anchor.getAttribute('href'), '/view?path=/home/yuri/Projects/hq/reports/night.md');
  assert.equal(anchor.getAttribute('target'), '_blank');
  assert.match(anchor.getAttribute('rel') ?? '', /noopener/);
  assert.equal(openFileInEditor.mock.calls.length, 0);
});

test('a bare absolute .md path in text opens in the editor', () => {
  clickReference(
    'Written to /home/yuri/Projects/BinanceGate/docs/analysis_night.md, have a look.',
    '/home/yuri/Projects/BinanceGate/docs/analysis_night.md',
  );
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/yuri/Projects/BinanceGate/docs/analysis_night.md', null]);
});

test('an absolute .md path in inline code opens in the editor, with its line', () => {
  clickReference('See `/home/yuri/Projects/hq/NOW.md:4` for the plan.', '/home/yuri/Projects/hq/NOW.md:4');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/yuri/Projects/hq/NOW.md', 4]);
});

test('an absolute path to a non-markdown file in text stays plain text', () => {
  openFileInEditor.mockReset();
  render(<Markdown>{'Built /home/yuri/Projects/BinanceGate/build/gate.'}</Markdown>);
  assert.equal(document.querySelector('a'), null);
  assert.equal(screen.queryByRole('link'), null);
});
