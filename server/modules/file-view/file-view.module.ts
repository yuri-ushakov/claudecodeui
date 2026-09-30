import { promises as fsPromises } from 'node:fs';

import { projectsDb } from '@/modules/database/index.js';
import { resolvePathUnderRoots, resolveReadOnlyRootPath } from '@/shared/utils.js';

import { createFileViewPolicy } from './file-view-policy.js';
import { parseViewRoots, VIEW_ROOTS_ENVIRONMENT_VARIABLE } from './file-view-roots.js';
import { createFileViewRouter } from './file-view.routes.js';
import { createFileViewService } from './file-view.service.js';

const MAXIMUM_VIEW_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Directories the viewer may read from, as configured for this process.
 * Read once: the service unit sets the variable, and a change there comes
 * with a restart anyway.
 */
export const configuredViewRoots = parseViewRoots(process.env[VIEW_ROOTS_ENVIRONMENT_VARIABLE]);

/**
 * The production policy: configured roots, the directories of every
 * registered project (active and archived — an archived project's files are
 * still the user's), and the built-in read-only roots.
 */
export const fileViewPolicy = createFileViewPolicy({
  resolveBuiltInRoot: resolveReadOnlyRootPath,
  configuredRoots: configuredViewRoots,
  listProjectPaths: () => [
    ...projectsDb.getProjectPaths(),
    ...projectsDb.getArchivedProjectPaths(),
  ].map((project) => project.project_path),
  resolveUnderRoots: resolvePathUnderRoots,
});

const fileViewService = createFileViewService({
  policy: fileViewPolicy,
  fileSystem: {
    stat: (filePath) => fsPromises.stat(filePath),
    readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  },
  maximumFileSizeBytes: MAXIMUM_VIEW_FILE_SIZE_BYTES,
});

/** Router the server entrypoint mounts at `/api/files` behind authentication. */
export const fileViewRoutes = createFileViewRouter(fileViewService, {
  error: (message, error) => console.error(message, error),
});
