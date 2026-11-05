// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  DEFAULT_SESSION_IDLE_MINUTES,
  SESSION_IDLE_CHOICES,
  SessionIdleMinutesSchema,
  type SessionIdleMinutes,
  type SessionPolicy,
} from '@mongo-manager/shared'
import { SettingsRepo } from '../store/settings'
import { SESSION_ABSOLUTE_MS } from './sessions'
import type { ServerContext } from '../http/context'

const KEY = 'auth.sessionIdle'
const StoredSchema = z.strictObject({ minutes: SessionIdleMinutesSchema })
const MIN = 60_000

/**
 * Session lifetime (2026-10-29): the idle time an administrator chose — 30 minutes when none was, and
 * the shortest when what is stored no longer reads (never a longer one than was meant).
 */
export function sessionIdleMinutes(db: DatabaseSync, now: () => number): SessionIdleMinutes {
  const settings = new SettingsRepo(db, now)
  const fallback = settings.has(KEY) ? SESSION_IDLE_CHOICES[0] : DEFAULT_SESSION_IDLE_MINUTES
  return settings.get(KEY, StoredSchema, { minutes: fallback }).minutes
}

export const sessionIdleMs = (db: DatabaseSync, now: () => number): number =>
  sessionIdleMinutes(db, now) * MIN

export function sessionPolicy(ctx: ServerContext): SessionPolicy {
  return {
    idleMinutes: sessionIdleMinutes(ctx.store.db, ctx.now),
    absoluteMinutes: SESSION_ABSOLUTE_MS / MIN,
  }
}

/**
 * Stored, and in force for every session at once. What the time in force has already ended is removed
 * first, so a longer time never brings a session back (review of 2026-10-29, I1); open sockets look
 * again at once (what the new time ends, a request or a socket's look already refuses).
 */
export function setSessionIdle(ctx: ServerContext, minutes: SessionIdleMinutes): void {
  ctx.sessions.pruneExpired()
  new SettingsRepo(ctx.store.db, ctx.now).set(KEY, { minutes })
  ctx.sessions.setIdleMs(minutes * MIN)
  ctx.access.changed()
}
