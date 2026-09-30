import path from 'node:path';

/** Environment variable naming extra directories the file viewer may read from. */
export const VIEW_ROOTS_ENVIRONMENT_VARIABLE = 'CLOUDCLI_VIEW_ROOTS';

/**
 * Parses the `CLOUDCLI_VIEW_ROOTS` value: absolute directories separated by
 * `:` (for example `/home/yuri/Projects:/data`).
 *
 * Empty entries and surrounding whitespace are dropped; a relative entry is
 * dropped too, since a root that depends on the working directory would move
 * with it. Order is kept, duplicates are collapsed.
 */
export function parseViewRoots(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const roots = value
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));

  return [...new Set(roots)];
}
