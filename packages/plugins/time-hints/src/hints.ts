/**
 * Plugins wave 1: what a value says about time, for a cell. An ObjectId carries the second it was
 * made; a number in the range of Unix times from 2001 to 2100 (seconds or milliseconds) reads as
 * that date — marked approximate, it may be a count. Values arrive as canonical Extended JSON.
 */
import { langTag } from '../../kit/src/ui'

const FROM_S = 1_000_000_000 // 2001-09-09
const UNTIL_S = 4_102_444_800 // 2100-01-01

export function hint(
  value: unknown,
  locale: string,
  timeZone?: string,
): { text: string; tone: 'neutral' } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const format = (ms: number) =>
    new Intl.DateTimeFormat(langTag(locale), {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ms))
  if (typeof v.$oid === 'string') {
    if (!/^[0-9a-f]{24}$/i.test(v.$oid)) return null
    return { text: format(parseInt(v.$oid.slice(0, 8), 16) * 1000), tone: 'neutral' }
  }
  const raw = v.$numberInt ?? v.$numberLong ?? v.$numberDouble
  if (typeof raw !== 'string' || Object.keys(v).length !== 1) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const ms = n >= FROM_S && n < UNTIL_S ? n * 1000 : n >= FROM_S * 1000 && n < UNTIL_S * 1000 ? n : null
  return ms === null ? null : { text: `≈ ${format(ms)}`, tone: 'neutral' }
}
