import type { Link, Parent, Root, Text } from 'mdast';

/**
 * Absolute paths to markdown files written bare in a message — `see
 * /home/yuri/Projects/hq/reports/night.md` — become links, so a report can be
 * opened from the chat without the model having to wrap it in `[]()`.
 *
 * Only `.md`/`.markdown` paths, only absolute ones, and only in plain text:
 * a path already inside a link keeps that link, and inline code is a
 * separate node the chat's code renderer handles on its own.
 */

// An absolute POSIX path ending in a markdown extension, optionally with a
// `:line` suffix; not preceded by a word character, `:`, `.` or `/`, so the
// path part of `https://host/doc.md` or `../notes.md` is left alone. The word
// boundary after the extension stops at `.md.` (end of sentence) but rejects
// `.mdx`.
const ABSOLUTE_MARKDOWN_PATH = /(?<![\w:./-])\/[^\s`'"<>()[\]]*\.(?:md|markdown)\b(?::\d+)?/gi;

/** Whether the whole reference (trimmed, `:line` allowed) is an absolute markdown path. */
export function isAbsoluteMarkdownPath(reference: string): boolean {
  const trimmed = reference.trim();
  const match = trimmed.match(new RegExp(ABSOLUTE_MARKDOWN_PATH.source, 'i'));
  return match !== null && match.index === 0 && match[0].length === trimmed.length;
}

/** Splits one text node into text and link nodes around the paths it contains. */
function linkPathsInText(node: Text): Array<Text | Link> {
  const parts: Array<Text | Link> = [];
  let lastIndex = 0;
  for (const match of node.value.matchAll(ABSOLUTE_MARKDOWN_PATH)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({ type: 'text', value: node.value.slice(lastIndex, start) });
    }
    parts.push({ type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] });
    lastIndex = start + match[0].length;
  }
  if (parts.length === 0) {
    return [node];
  }
  if (lastIndex < node.value.length) {
    parts.push({ type: 'text', value: node.value.slice(lastIndex) });
  }
  return parts;
}

function visit(parent: Parent): void {
  const rewritten: Parent['children'] = [];
  for (const child of parent.children) {
    if (child.type === 'text') {
      rewritten.push(...linkPathsInText(child));
      continue;
    }
    // A path inside an existing link is that link's text, not a new one.
    if ('children' in child && child.type !== 'link' && child.type !== 'linkReference') {
      visit(child);
    }
    rewritten.push(child);
  }
  parent.children = rewritten;
}

/** remark plugin: turns bare absolute markdown paths in text into links. */
export function remarkAbsoluteMarkdownPaths() {
  return (tree: Root) => {
    visit(tree);
  };
}
