import type { CodeEditorFile } from '@/shared/types';

/**
 * The file the /view page was asked to show, from its `path` query value.
 *
 * Only an absolute path names one file on the server; anything else is
 * `null` and the page explains the expected form. No `projectId`: the editor
 * reads it through the viewer endpoint and shows it read-only.
 */
export function parseViewedFile(requestedPath: string | null): CodeEditorFile | null {
  const path = (requestedPath ?? '').trim();
  if (!path.startsWith('/')) {
    return null;
  }
  const name = path.split('/').filter(Boolean).pop() ?? path;
  return { name, path };
}
