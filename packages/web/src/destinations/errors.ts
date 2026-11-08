// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { useI18n } from 'vue-i18n'
import type { DestinationType } from '@mongo-manager/shared/browser'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

/**
 * Short names reviews 6 and 7 (I-1): what a refusal says beyond its reason — the folder name a
 * path_name refusal is about (quoted by the server), and which folder refusal a path one is.
 */
export interface RefusalExtra {
  name?: string
  why?: string
}

/**
 * Short names review 8 (M-4): a `why` this page has words for. One it does not know (a newer server
 * behind a cached page) is as if there were none: the reason's own words and its general hint.
 */
function useKnownWhy() {
  const { te } = useI18n()
  return (why: string | undefined): why is string => !!why && te(`destinations.pathWhy.${why}`)
}

/** The words of a reason, or null where there are none: see useReasonText. */
function useWords() {
  const { t, te } = useI18n()
  const known = useKnownWhy()
  return (reason: string | null | undefined, type?: DestinationType | null, extra: RefusalExtra = {}) => {
    if (!reason) return null
    if (extra.name !== undefined && te(`destinations.reasonNamed.${reason}`))
      return t(`destinations.reasonNamed.${reason}`, { name: extra.name })
    if (reason === 'path' && known(extra.why)) return t(`destinations.pathWhy.${extra.why}`)
    if (type && te(`destinations.reason.${reason}_${type}`)) return t(`destinations.reason.${reason}_${type}`)
    if (te(`destinations.reason.${reason}`)) return t(`destinations.reason.${reason}`)
    return null
  }
}

/**
 * Phase 3d-3b final review: a reason code in words, in the words of the destination's type where
 * that matters (a wrong WebDAV password is no "access key"): destinations.reason.<code>_<type>
 * first, then destinations.reason.<code>, else the provider's generic refusal. A refusal that names
 * a folder is said with the name (destinations.reasonNamed), and a folder refusal by which it is
 * (destinations.pathWhy).
 */
export function useReasonText() {
  const { t } = useI18n()
  const words = useWords()
  return (reason: string | null | undefined, type?: DestinationType | null, extra?: RefusalExtra): string =>
    words(reason, type, extra) ?? t('destinations.reason.provider')
}

const detail = (e: unknown, key: string): string | undefined => {
  const v = e instanceof ApiError ? (e.details as Record<string, unknown> | undefined)?.[key] : undefined
  return typeof v === 'string' ? v : undefined
}
/** The reason code an API refusal carries, if any. */
export const reasonOf = (e: unknown): string | undefined => detail(e, 'reason')
/** What an API refusal says beyond its reason. */
export const extraOf = (e: unknown): RefusalExtra => {
  const name = detail(e, 'name')
  const why = detail(e, 'why')
  return { ...(name !== undefined ? { name } : {}), ...(why !== undefined ? { why } : {}) }
}

/**
 * Phase 3d-3b: a destination's refusal in the reader's words. The server names a reason
 * (`path`, `connect`, `auth`, …) and destinations.reason holds a sentence for each; anything
 * else falls back to the generic description.
 */
export function useDestinationError() {
  const { t } = useI18n()
  const words = useWords()
  return (e: unknown, type?: DestinationType | null): string =>
    words(reasonOf(e), type, extraOf(e)) ?? describeError(e, t)
}

/**
 * The fix for a reason, in the words of the destination's type where there are some
 * (destinations.fixHint.<code>_<type>, then destinations.fixHint.<code>); '' where there is none.
 * Short names review 7 (I-1): a folder refusal that says which it is gets that one's fix only
 * (destinations.pathWhyFix), or none — never the roots hint for a data-directory refusal.
 */
export function useFixHint() {
  const { t, te } = useI18n()
  const known = useKnownWhy()
  return (
    reason: string | null | undefined,
    type?: DestinationType | null,
    extra: RefusalExtra = {},
  ): string => {
    if (!reason) return ''
    if (reason === 'path' && known(extra.why))
      return te(`destinations.pathWhyFix.${extra.why}`) ? t(`destinations.pathWhyFix.${extra.why}`) : ''
    if (type && te(`destinations.fixHint.${reason}_${type}`))
      return t(`destinations.fixHint.${reason}_${type}`)
    return te(`destinations.fixHint.${reason}`) ? t(`destinations.fixHint.${reason}`) : ''
  }
}
