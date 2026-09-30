/**
 * The one answer to "may this absolute path be read as a page, whatever project
 * is open?" — used by the file viewer (`GET /api/files/view`) and, through the
 * File Tree module's read-only root gateway, by the in-app editor when a chat
 * reference points outside the current project.
 *
 * Reads only: nothing here is consulted by a write path.
 */

export type FileViewPolicyDependencies = {
  /**
   * Resolves a path under the built-in read-only roots (system temp directory,
   * Claude projects directory) — `resolveReadOnlyRootPath` in production.
   */
  resolveBuiltInRoot(targetPath: string): Promise<string | null>;
  /** Directories from `CLOUDCLI_VIEW_ROOTS`, already absolute. */
  configuredRoots: string[];
  /** Directories of every registered project, read at call time so a project added later counts. */
  listProjectPaths(): string[];
  /**
   * Resolves a path under one of the roots with symlinks followed first, or
   * `null` — `resolvePathUnderRoots` in production.
   */
  resolveUnderRoots(targetPath: string, roots: string[]): Promise<string | null>;
};

export type FileViewPolicy = {
  /**
   * The real path of `targetPath` when it lies under a configured root, a
   * registered project directory or a built-in read-only root; `null` when it
   * does not, including when it only reaches one of them through a symlink
   * that leads outside.
   */
  resolveReadablePath(targetPath: string): Promise<string | null>;
  /** Every root the policy currently honours, for diagnostics. */
  roots(): string[];
};

/** Builds the policy for the composition root and for tests. */
export function createFileViewPolicy(dependencies: FileViewPolicyDependencies): FileViewPolicy {
  const roots = (): string[] => [
    ...dependencies.configuredRoots,
    ...dependencies.listProjectPaths(),
  ];

  return {
    async resolveReadablePath(targetPath) {
      const builtIn = await dependencies.resolveBuiltInRoot(targetPath);
      if (builtIn) {
        return builtIn;
      }
      return dependencies.resolveUnderRoots(targetPath, roots());
    },
    roots,
  };
}
