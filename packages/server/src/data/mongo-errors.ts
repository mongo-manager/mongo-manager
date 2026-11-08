// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { FastifyRequest } from 'fastify'
import type { MongoClient } from 'mongodb'
import { serializeValue } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { ConnectionError, OIDC_PER_PERSON, classifyError, redactUris } from '../connections/errors'
import { markMongo } from '../masking/errors'
import { isRestricted, personOf } from '../connections/access'
import { AGENT_CALL_HEADER } from '../ai/agent/calls'
import { validationProblems, validationSummary } from './validation-errors'

function safe(value: unknown): unknown {
  try {
    return value === undefined ? undefined : serializeValue(value)
  } catch {
    return undefined
  }
}

/**
 * The status of a connection failure: an open stopped (the app closing, its connection changed) is
 * the server unavailable now; anything else, the server behind it failing (third review of the
 * open's stop, minor 1: one rule for every route).
 */
export const connectionStatus = (kind: string): number => (kind === 'closed' ? 503 : 502)

/**
 * A failure to get a connection's client, named as every route names it: the driver's own errors
 * classified first (an auth refusal, a host not found), then as toAppError answers a connection
 * error (fourth review of the open's stop, minor 1).
 */
export function connectionAppError(e: unknown): AppError {
  // Fifth review (nit 5): an answer already made is kept as it is.
  if (e instanceof AppError) return e
  return toAppError(classifyError(e)) as AppError
}

/** For `getClient(...).catch(asConnectionFailure)`: throws the failure as connectionAppError names it. */
export function asConnectionFailure(e: unknown): never {
  throw connectionAppError(e)
}

/** What a run stopped at its time limit is told: the request's (maxTimeMS)... */
export const TIME_LIMIT = 'The operation exceeded its time limit (maxTimeMS)'
/** ...or the one the app sets on a few commands of its own (timeoutMS): nothing a user sets. */
export const OPERATION_TIME_LIMIT = 'The operation exceeded its time limit'

/**
 * An operation's timeoutMS spent reaching the server, selecting it or waiting for a pooled
 * connection: what failed is that, answered as it is without timeoutMS (the driver wraps it, with
 * it as the cause). A selection "after 0 ms" began with no time left: that is the time limit.
 */
function reachingServer(e: unknown): unknown {
  const { name, cause } = (e ?? {}) as { name?: unknown; cause?: { name?: unknown; message?: unknown } }
  if (name !== 'MongoOperationTimeoutError' || !cause) return null
  if (cause.name === 'MongoWaitQueueTimeoutError') return cause
  if (cause.name === 'MongoServerSelectionError' && !/after 0 ms$/.test(String(cause.message))) return cause
  return null
}

/**
 * A command MongoDB stopped at its time limit (MaxTimeMSExpired), or one the driver stopped at an
 * operation's own timeoutMS while it ran (not while reaching the server). By name, not class: two
 * copies of the driver are installed. toAppError answers both 504; any other error with code 50 it
 * answers 504 too, but is not retried on.
 */
export const ranOutOfTime = (e: unknown): boolean => {
  const { name, code } = (e ?? {}) as { name?: unknown; code?: unknown }
  if (name === 'MongoServerError') return code === 50
  return name === 'MongoOperationTimeoutError' && reachingServer(e) === null
}

/**
 * MongoDB's codes for a server, a shard or a primary not available for now (a host out of reach, a
 * read preference no member satisfies, a socket that failed, a step-down, a shutdown).
 */
export const UNAVAILABLE: ReadonlySet<number> = new Set([
  6, 7, 89, 91, 133, 189, 202, 9001, 10107, 11600, 11602, 13435, 13436,
])

/**
 * The server's own error under the driver's: the driver reports any write the server refuses as
 * IllegalOperation (20) as "does not support retryable writes", with no code of its own, keeping the
 * server's error on originalError (CI 2026-10-23: MongoDB 6.0 deleting one document of a time
 * series). Any other error — one with a code of its own, or nothing MongoDB raised under it — is
 * itself.
 */
export function serverError(e: unknown): unknown {
  if (e === null || typeof e !== 'object') return e
  const { code, originalError } = e as { code?: unknown; originalError?: unknown }
  if (code !== undefined && code !== null) return e
  const original = originalError as { code?: unknown; name?: unknown } | null | undefined
  return original !== null &&
    typeof original === 'object' &&
    typeof original.name === 'string' &&
    original.name.startsWith('Mongo') &&
    original.code !== undefined &&
    original.code !== null
    ? original
    : e
}

/** The server's code, from under the driver's wrapper too (second independent review, Minor 1). */
export const serverCode = (e: unknown): unknown => (serverError(e) as { code?: unknown } | null)?.code

/**
 * The server's words, from under the driver's wrapper too; something thrown as text is said as
 * itself, anything else with no words of its own as a refusal (third independent review, nit 4;
 * final review, nit 5).
 */
export function serverText(e: unknown): string {
  const server = serverError(e)
  const message = (server as { message?: unknown } | null | undefined)?.message
  if (typeof message === 'string') return message
  return typeof server === 'string' ? server : 'MongoDB refused the operation'
}

/**
 * A record a job's write was refused, for its report (phase 3d-1 §8.2): MongoDB's message — it can
 * quote values, so only its code where the caller may not see personal data — and the rules of a
 * validator's refusal (research 2026-10-28), never the value that failed. The server's own error,
 * from under the driver's wrapper.
 */
export function writeRefusal(refused: unknown, codeOnly: boolean): string {
  const e = serverError(refused) as { errmsg?: unknown; message?: unknown; code?: unknown; errInfo?: unknown }
  const rules = e.code === 121 ? validationSummary(e.errInfo, codeOnly) : null
  if (codeOnly)
    return `MongoDB refused the write (code ${String(e.code ?? 'unknown')}${rules ? `: ${rules}` : ''})`
  const said = String(e.errmsg ?? e.message ?? 'MongoDB refused the write').slice(0, 500)
  return rules ? `${said.slice(0, 150)}: ${rules}` : said
}

/** A bulk write's errors: the driver gives one or several (OneOrMore). */
const firstWriteError = (e: { writeErrors?: unknown }): { err?: Record<string, unknown> } | undefined => {
  const first = Array.isArray(e.writeErrors) ? e.writeErrors[0] : e.writeErrors
  return first !== null && typeof first === 'object'
    ? (first as { err?: Record<string, unknown> })
    : undefined
}

/** Driver and connection failures → AppError with a message safe to show (spec §4.9). */
export function toAppError(e: unknown): unknown {
  if (e instanceof AppError) return e
  // A gate's failed index listing (review of the agent's gate): answered as the failure it was.
  if (e instanceof Error && e.name === 'IndexListingFailed' && e.cause !== undefined)
    return toAppError(e.cause)
  if (e instanceof ConnectionError && e.kind === 'unsupported')
    return new AppError('UNSUPPORTED_SERVER', e.message, 422, { kind: e.kind })
  if (e instanceof ConnectionError)
    return new AppError('MONGO_ERROR', e.message, connectionStatus(e.kind), {
      kind: e.kind,
      // Fifth review of the open's stop (minor 1): work with no person behind it on a per-person
      // connection cannot be helped by a sign-in, so none is asked for.
      ...(e.kind === 'oidc'
        ? { reason: e.message === OIDC_PER_PERSON ? 'oidc_per_person' : 'oidc_sign_in' }
        : {}),
      // A refusal kept, said again without dialling: the page says how to try again (Test).
      ...(e.remembered ? { remembered: true } : {}),
    })
  const err = e as {
    name?: unknown
    code?: unknown
    codeName?: unknown
    message?: unknown
    keyValue?: unknown
    keyPattern?: unknown
    errInfo?: unknown
    writeErrors?: unknown
  }
  if (typeof err.name !== 'string' || !err.name.startsWith('Mongo')) return e
  // The server's own error, from under the driver's (its text and its code, not the driver's advice).
  const server = serverError(e)
  if (server !== e) return toAppError(server)
  // An operation's timeoutMS ran out: reaching the server is answered as that; while it ran, as its
  // time limit, with MongoDB's MaxTimeMSExpired as the details when the server stopped it.
  if (err.name === 'MongoOperationTimeoutError') {
    const reaching = reachingServer(e)
    if (reaching) return toAppError(reaching)
    const cause = (e as { cause?: { code?: unknown; codeName?: unknown } }).cause
    return new AppError(
      'MONGO_ERROR',
      OPERATION_TIME_LIMIT,
      504,
      cause?.code === 50 ? { code: cause.code, codeName: cause.codeName } : undefined,
    )
  }
  // No pooled connection was free in time: all busy (maxPoolSize), or a new one slow to open.
  if (err.name === 'MongoWaitQueueTimeoutError')
    return new AppError(
      'MONGO_ERROR',
      'No connection to the MongoDB server was free in time; try again shortly',
      503,
      {
        kind: 'pool',
      },
    )
  if (/^Mongo(Network|NetworkTimeout|ServerSelection|NotConnected|TopologyClosed)Error$/.test(err.name)) {
    return new AppError('MONGO_ERROR', 'Lost the connection to the MongoDB server; try again', 502, {
      kind: 'network',
    })
  }
  const details = { code: err.code, codeName: err.codeName }
  switch (err.code) {
    case 11000: {
      // insertMany/bulkWrite raise MongoBulkWriteError; the key sits on the first write error.
      // Bulk writes carry no keyValue: the index and key are only in the server message.
      const first = firstWriteError(err)?.err
      const text = String(first?.errmsg ?? err.message ?? '')
      const parsed = /index: (\S+) dup key: (\{.*\})/.exec(text)
      return markMongo(
        new AppError('CONFLICT', 'A document with the same unique key already exists', 409, {
          ...(parsed ? { index: parsed[1], duplicateKey: parsed[2] } : {}),
          keyValue: safe(err.keyValue ?? first?.keyValue),
          keyPattern: safe(err.keyPattern ?? first?.keyPattern),
        }),
      )
    }
    // MaxTimeMSExpired, and ExceededTimeLimit: a time limit too (review of the agent's gate, nit).
    case 50:
    case 262:
      return new AppError('MONGO_ERROR', TIME_LIMIT, 504, details)
    case 11601:
      return new AppError('MONGO_ERROR', 'The operation was cancelled', 409, details)
    case 13:
      return new AppError('FORBIDDEN', 'MongoDB denied this operation for the connection user', 403)
    case 26:
      return Errors.notFound('Namespace not found')
    case 48:
      return Errors.conflict('A collection or view with that name already exists')
  }
  const message = redactUris(String(err.message ?? '').split('\n')[0] ?? '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]')
    .slice(0, 500)
  // A server, a shard or a primary not there for now (a step-down, a shutdown, a host out of reach):
  // try again later, not a request to change (review of the agent's gate, nit).
  if (UNAVAILABLE.has(Number(err.code)))
    return markMongo(new AppError('MONGO_ERROR', message || 'MongoDB is not available', 503, details))
  // A write the collection's validator refused: which rules, from errInfo (a bulk write keeps it on
  // its first write error). The value that failed is not passed on.
  const validation =
    err.code === 121 ? validationProblems(err.errInfo ?? firstWriteError(err)?.err?.errInfo) : null
  // Phase 3c §4.7: MongoDB's own text, hidden from a restricted user by the error handler.
  return markMongo(
    new AppError(
      'MONGO_ERROR',
      message || 'MongoDB error',
      400,
      validation ? { ...details, ...validation } : details,
    ),
  )
}

/**
 * Monitoring answers are only shown, and can hold text the server could not encode: a down member's
 * heartbeat message is the operating system's error, in its own code page (Turkish Windows, for
 * one). Strict UTF-8 checking would fail the whole answer; invalid bytes become U+FFFD instead.
 */
export const LENIENT = { enableUtf8Validation: false } as const

/**
 * Replica set status is read from any member (primaryPreferred): a set without a primary is exactly
 * what it must still show (final review 1j, Critical 1). Bounded, so a set that answers nothing
 * fails in seconds, not after a whole server-selection timeout.
 */
export const ANY_MEMBER = { ...LENIENT, readPreference: 'primaryPreferred', timeoutMS: 5_000 } as const

export async function withMongo<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toAppError(e)
  }
}

/**
 * The client a request works with. W7: in team mode a connection that signs people in with OIDC
 * gives each person their own (their tokens). W8: on a connection with client-side encryption, the
 * client that decrypts reads and encrypts writes is for those who may see the data; anyone else —
 * and `asStored` (key management) — reads values as stored, ciphertext never decrypted.
 */
export async function clientFor(
  request: FastifyRequest,
  opts: { asStored?: boolean } = {},
): Promise<MongoClient> {
  const { ctx } = request.server
  const { manager } = ctx
  const id = request.connection!.id
  const principal = request.principal!
  // W8 × W6: a route the agent calls for a person reads as stored — what it reads may go to an AI
  // provider, which never gets a decrypted value.
  // (A request made for work on its own — a two-way sync's way back, W4 — carries no headers.)
  const forAgent = request.headers?.[AGENT_CALL_HEADER] !== undefined
  const decrypt =
    !opts.asStored &&
    !forAgent &&
    request.connection!.settings.encryption?.enabled === true &&
    !isRestricted(ctx, principal, id)
  // Held until the request answers: a long operation never loses its client to the idle timer.
  const release = manager.hold(id)
  ;(request.releases ??= []).push(release)
  try {
    return await manager.getClient(id, { user: personOf(principal), decrypt })
  } catch (e) {
    throw connectionAppError(e)
  }
}
