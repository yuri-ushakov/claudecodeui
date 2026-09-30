import path from 'node:path';

import { AppError } from '@/shared/utils.js';

import type { FileViewPolicy } from './file-view-policy.js';

export type FileViewFileSystem = {
  stat(filePath: string): Promise<{ size: number; isFile(): boolean }>;
  readTextFile(filePath: string): Promise<string>;
};

export type FileViewServiceDependencies = {
  policy: FileViewPolicy;
  fileSystem: FileViewFileSystem;
  maximumFileSizeBytes: number;
};

export type ViewedFile = {
  path: string;
  name: string;
  size: number;
  content: string;
};

export type FileViewService = {
  /**
   * Reads a file the viewer page may show: an absolute path under one of the
   * policy's roots, a regular file, at most `maximumFileSizeBytes` long.
   * Returns the resolved path (symlinks followed), the file name, its size and
   * its text.
   */
  readFile(requestedPath: string): Promise<ViewedFile>;
};

function createViewError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

/** Creates the file-viewer workflow for the composition root and route tests. */
export function createFileViewService(dependencies: FileViewServiceDependencies): FileViewService {
  return {
    async readFile(requestedPath) {
      if (!path.isAbsolute(requestedPath)) {
        throw createViewError('Path must be absolute', 400, 'INVALID_VIEW_PATH');
      }

      const resolvedPath = await dependencies.policy.resolveReadablePath(requestedPath);
      if (!resolvedPath) {
        throw createViewError('Path is outside the directories the viewer may read', 403, 'PATH_OUTSIDE_VIEW_ROOTS');
      }

      const stats = await dependencies.fileSystem.stat(resolvedPath);
      if (!stats.isFile()) {
        throw createViewError('Path is not a file', 400, 'NOT_A_FILE');
      }
      if (stats.size > dependencies.maximumFileSizeBytes) {
        throw createViewError(
          `File is larger than the ${Math.round(dependencies.maximumFileSizeBytes / (1024 * 1024))} MB the viewer shows`,
          413,
          'VIEW_FILE_TOO_LARGE',
        );
      }

      const content = await dependencies.fileSystem.readTextFile(resolvedPath);
      return {
        path: resolvedPath,
        name: path.basename(resolvedPath),
        size: stats.size,
        content,
      };
    },
  };
}
