// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ApiError } from '@/api/client'

/** Why a widget cannot show its server (final review 3: not always "cannot be reached"). */
export type WidgetErrorCode = 'FORBIDDEN' | 'NOT_PERMITTED' | 'TOO_MANY' | 'UNREACHABLE' | 'BUSY' | 'INVALID'

/**
 * MongoDB refused the command (the account lacks a role: code 13, sent as 403 with that reason), the
 * user may not (403), or the server could not be read (anything else).
 */
export function widgetError(e: unknown): WidgetErrorCode {
  if (!(e instanceof ApiError)) return 'UNREACHABLE'
  if ((e.details as { reason?: unknown } | undefined)?.reason === 'mongo_not_permitted')
    return 'NOT_PERMITTED'
  if (e.status === 403) return 'FORBIDDEN'
  // Review of wave 2 (I1): the user's runs all taken, a request refused as not valid — not "unreachable".
  if (e.status === 429) return 'BUSY'
  if (e.status === 400) return 'INVALID'
  return 'UNREACHABLE'
}
