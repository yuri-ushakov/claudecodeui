import express from 'express';
import type { Request, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

import type { FileViewService } from './file-view.service.js';

export type FileViewLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * The `path` query value as the viewer sent it, or a 400 when it is missing,
 * repeated or blank. Decoding is the query parser's; the service decides
 * whether the path is acceptable.
 */
export function readViewPath(query: Request['query']): string {
  const value = query.path;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('path query parameter is required', {
      code: 'INVALID_VIEW_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

function createRouteHandler(
  operation: (request: Request, response: Response) => Promise<void>,
  logger: FileViewLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('File view API error', error);
      response.status(500).json({ error: message });
    }
  };
}

/**
 * Builds the file-viewer router. Paths are relative to the `/api/files` mount
 * point: `GET /view?path=<absolute path>` answers `{ path, name, size, content }`.
 */
export function createFileViewRouter(service: FileViewService, logger: FileViewLogger): express.Router {
  const router = express.Router();

  router.get('/view', createRouteHandler(async (request, response) => {
    response.json(await service.readFile(readViewPath(request.query)));
  }, logger));

  return router;
}
