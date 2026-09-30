// fileViewRoutes: mounted by the server entrypoint at `/api/files` (viewer page reads).
// fileViewPolicy: the one answer to "may this absolute path be read as a page?";
// the File Tree module's read-only root gateway delegates to it.
export { configuredViewRoots, fileViewPolicy, fileViewRoutes } from './file-view.module.js';
