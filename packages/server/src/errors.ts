import type { ApiErrorBody, ErrorCode } from '@mongo-manager/shared'

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }

  toBody(correlationId?: string): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(correlationId ? { correlationId } : {}),
    }
  }
}

export const Errors = {
  validation: (message: string, details?: unknown) => new AppError('VALIDATION_ERROR', message, 400, details),
  unauthenticated: (message = 'Authentication required', details?: unknown) =>
    new AppError('UNAUTHENTICATED', message, 401, details),
  forbidden: (message = 'You do not have permission to do this', details?: unknown) =>
    new AppError('FORBIDDEN', message, 403, details),
  notFound: (message = 'Not found') => new AppError('NOT_FOUND', message, 404),
  conflict: (message: string, details?: unknown) => new AppError('CONFLICT', message, 409, details),
  rateLimited: (retryAfterMs: number, reason?: string) =>
    new AppError('RATE_LIMITED', 'Too many requests; try again later', 429, {
      retryAfterMs,
      ...(reason ? { reason } : {}),
    }),
  readOnly: () => new AppError('READ_ONLY', 'Mongo Manager is running in read-only mode', 403),
  payloadTooLarge: () => new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413),
  /** Phase 3d-1: a file that cannot be read safely (spec §7). */
  badFile: (message: string, details?: unknown) => new AppError('BAD_FILE', message, 400, details),
  gone: (message: string) => new AppError('GONE', message, 410),
  unsupportedType: () =>
    new AppError('VALIDATION_ERROR', 'Send the file as application/octet-stream', 415, {
      reason: 'content_type',
    }),
}
