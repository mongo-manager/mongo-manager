// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ApiError } from '@/api/client'

/**
 * Security review 2026-10-13 round 2 (I7): the server reads one backup at a time per user. A read
 * refused for that is asked again after the wait it names — never taken for a password throttle.
 * The wait, or null when the error is something else.
 */
export function readBusyWait(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null
  const d = e.details as { reason?: unknown; retryAfterMs?: unknown } | undefined
  if (d?.reason !== 'backup_read_busy') return null
  const ms = Number(d.retryAfterMs)
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 10_000) : 2_000
}
