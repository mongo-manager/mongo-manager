// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import { AppError } from '../errors'
import { isRestricted } from '../connections/access'
import { namesOnly } from '../data/validation-errors'

const FROM_MONGO = Symbol('mm.fromMongo')

/** An AppError whose message or details carry MongoDB's own text (it can quote document values). */
export function markMongo<T extends AppError>(e: T): T {
  Object.defineProperty(e, FROM_MONGO, { value: true })
  return e
}

export const isFromMongo = (e: AppError): boolean =>
  (e as unknown as Record<symbol, unknown>)[FROM_MONGO] === true

/** The caller may not see this connection's personal data. */
export function restrictedRequest(request: FastifyRequest): boolean {
  const { connection, principal } = request
  return Boolean(connection && principal && isRestricted(request.server.ctx, principal, connection.id))
}

const HIDDEN = 'its message is hidden because it can quote personal data'

/**
 * Phase 3c §4.7: MongoDB's text replaced by its code for a restricted user; a duplicate key keeps
 * its index and field names. Errors with a fixed message of our own pass unchanged.
 */
export function forRestricted(e: AppError): AppError {
  if (!isFromMongo(e)) return e
  const d = (e.details ?? {}) as {
    code?: unknown
    codeName?: unknown
    index?: unknown
    keyPattern?: unknown
    problems?: unknown
    more?: unknown
  }
  if (e.code === 'CONFLICT') {
    const fields = d.keyPattern && typeof d.keyPattern === 'object' ? Object.keys(d.keyPattern) : []
    const index = typeof d.index === 'string' ? d.index.slice(0, 128) : null
    return markMongo(
      new AppError('CONFLICT', `Duplicate key${index ? ` on index ${index}` : ''}; ${HIDDEN}`, 409, {
        index,
        fields,
        hidden: true,
      }),
    )
  }
  // Reads with promoteValues off hand the code over as a BSON Int32.
  const numeric = d.code === null || d.code === undefined ? Number.NaN : Number(d.code)
  const code = Number.isFinite(numeric) ? numeric : null
  const codeName = typeof d.codeName === 'string' ? d.codeName.slice(0, 64) : null
  const label = code === null ? '' : ` (${code}${codeName ? ` ${codeName}` : ''})`
  return markMongo(
    // A server not available for now did not refuse it: it could not complete (nit).
    new AppError(
      e.code,
      `MongoDB ${e.statusCode === 503 ? 'could not complete' : 'refused'} the operation${label}; ${HIDDEN}`,
      e.statusCode,
      {
        code,
        codeName,
        hidden: true,
        // A validator's refusal keeps its fields and rules, not what the rules hold.
        ...(Array.isArray(d.problems) ? { problems: namesOnly(d.problems), more: d.more === true } : {}),
      },
    ),
  )
}
