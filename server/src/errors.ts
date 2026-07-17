/**
 * Typed application errors. The Fastify error handler (app.ts) turns these into
 * the `{ error: { code, message } }` envelope from @den/shared. Client branches
 * on `code`, never on `message` (BACKBONE Conventions).
 */
import type { ErrorCodeName } from '@den/shared';
import { ErrorCode } from '@den/shared';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeName;

  constructor(statusCode: number, code: ErrorCodeName, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const unauthorized = (msg = 'Not authenticated') =>
  new AppError(401, ErrorCode.Unauthorized, msg);
export const forbidden = (msg = 'Not allowed') =>
  new AppError(403, ErrorCode.Forbidden, msg);
export const notFound = (msg = 'Not found') =>
  new AppError(404, ErrorCode.NotFound, msg);
export const validation = (msg: string) =>
  new AppError(400, ErrorCode.Validation, msg);
export const rateLimited = (msg = 'Too many requests') =>
  new AppError(429, ErrorCode.RateLimited, msg);
