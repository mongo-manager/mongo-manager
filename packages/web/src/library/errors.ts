import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** Why saving a favourite or a pipeline failed; a full collection is said as such (final review 2c, Minor 12). */
export function saveError(e: unknown, t: Translate): string {
  const details =
    e instanceof ApiError ? (e.details as { reason?: unknown; max?: unknown } | undefined) : undefined
  if (e instanceof ApiError && e.code === 'CONFLICT' && details?.reason === 'limit')
    return t('library.limitReached', { max: Number(details.max) })
  return describeError(e, t)
}
