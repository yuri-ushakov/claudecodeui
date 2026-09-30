import assert from 'node:assert/strict';

import type { Paragraph, PhrasingContent, Root } from 'mdast';
import { test } from 'vitest';

import { isAbsoluteMarkdownPath, remarkAbsoluteMarkdownPaths } from '@/modules/chat/utils/markdownFilePaths';

/**
 * Trees are built by hand: the plugin only rewrites text nodes, so what the
 * parser makes of the surrounding markdown is not in question here, and the
 * parser is a transitive dependency of react-markdown rather than one of ours.
 */
const paragraph = (...children: PhrasingContent[]): Root => ({
  type: 'root',
  children: [{ type: 'paragraph', children }],
});

const transform = remarkAbsoluteMarkdownPaths();

const rendered = (tree: Root) => {
  transform(tree);
  return (tree.children[0] as Paragraph).children.map((child) => [
    child.type,
    child.type === 'link' ? child.url : 'value' in child ? child.value : null,
  ]);
};

test('a bare absolute .md path in text becomes a link to that path', () => {
  const tree = paragraph({ type: 'text', value: 'Report: /home/yuri/Projects/hq/reports/night.md is ready.' });
  assert.deepEqual(rendered(tree), [
    ['text', 'Report: '],
    ['link', '/home/yuri/Projects/hq/reports/night.md'],
    ['text', ' is ready.'],
  ]);
});

test('a `:line` suffix travels with the path; a trailing full stop does not', () => {
  const tree = paragraph({ type: 'text', value: 'See /data/notes.md:12.' });
  assert.deepEqual(rendered(tree), [
    ['text', 'See '],
    ['link', '/data/notes.md:12'],
    ['text', '.'],
  ]);
});

test('two paths in one text node both become links', () => {
  const tree = paragraph({ type: 'text', value: '/a/x.md and /b/y.markdown' });
  assert.deepEqual(rendered(tree), [
    ['link', '/a/x.md'],
    ['text', ' and '],
    ['link', '/b/y.markdown'],
  ]);
});

test('paths that are not bare absolute markdown files are left alone', () => {
  for (const text of [
    'Open https://example.test/docs/guide.md now',
    'Relative ../notes.md and ./notes.md stay',
    'A source file /home/yuri/src/main.ts is not markdown',
    'An mdx file /home/yuri/page.mdx is not markdown either',
  ]) {
    assert.deepEqual(rendered(paragraph({ type: 'text', value: text })), [['text', text]], text);
  }
});

test('a path already inside a link keeps that link, with no link nested inside', () => {
  const tree = paragraph({
    type: 'link',
    url: '/view?path=/home/yuri/report.md',
    children: [{ type: 'text', value: '/home/yuri/report.md' }],
  });
  assert.deepEqual(rendered(tree), [['link', '/view?path=/home/yuri/report.md']]);
  const link = (tree.children[0] as Paragraph).children[0];
  assert.equal(link.type, 'link');
  assert.deepEqual((link as { children: PhrasingContent[] }).children.map((child) => child.type), ['text']);
});

test('inline code is a separate node and is not touched here', () => {
  const tree = paragraph(
    { type: 'text', value: 'Run ' },
    { type: 'inlineCode', value: '/home/yuri/report.md' },
    { type: 'text', value: ' first' },
  );
  assert.deepEqual(rendered(tree), [
    ['text', 'Run '],
    ['inlineCode', '/home/yuri/report.md'],
    ['text', ' first'],
  ]);
});

test('text nested in emphasis or list items is rewritten too', () => {
  const tree: Root = {
    type: 'root',
    children: [{
      type: 'list',
      children: [{
        type: 'listItem',
        children: [{
          type: 'paragraph',
          children: [{ type: 'strong', children: [{ type: 'text', value: 'see /x/y.md' }] }],
        }],
      }],
    }],
  };
  transform(tree);
  const strong = ((tree.children[0] as { children: Array<{ children: Paragraph[] }> }).children[0].children[0]).children[0];
  assert.equal(strong.type, 'strong');
  assert.deepEqual((strong as { children: PhrasingContent[] }).children.map((child) => child.type), ['text', 'link']);
});

test('isAbsoluteMarkdownPath accepts a whole absolute markdown path with an optional line', () => {
  assert.equal(isAbsoluteMarkdownPath('/home/yuri/Projects/hq/reports/night.md'), true);
  assert.equal(isAbsoluteMarkdownPath(' /home/yuri/report.md:3 '), true);
  assert.equal(isAbsoluteMarkdownPath('/home/yuri/report.md:7'), true);
  assert.equal(isAbsoluteMarkdownPath('/home/yuri/report.md and more'), false);
  assert.equal(isAbsoluteMarkdownPath('reports/night.md'), false);
  assert.equal(isAbsoluteMarkdownPath('/home/yuri/main.ts'), false);
});
