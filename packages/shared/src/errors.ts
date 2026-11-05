// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'DOCUMENT_CHANGED',
  'QUERY_PARSE_ERROR',
  'MONGO_ERROR',
  'UNSUPPORTED_SERVER',
  'RATE_LIMITED',
  'READ_ONLY',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
  // Phase 3a-1: the advanced shell.
  'SHELL_DISABLED',
  'SHELL_UNSUPPORTED_AUTH',
  'TOO_MANY',
  'BUSY',
  // Phase 3d-1: file import and export.
  'BAD_FILE',
  'GONE',
  // 2026-10-11: a service the server reached out to (GitHub) did not help.
  'UPSTREAM_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ApiErrorBody {
  code: ErrorCode
  message: string
  details?: unknown
  correlationId?: string
}
