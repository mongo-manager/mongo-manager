import { useI18n } from 'vue-i18n'
import type { WatchFeed } from './feeds'

const KNOWN_OPS = new Set([
  'insert',
  'update',
  'replace',
  'delete',
  'invalidate',
  'drop',
  'rename',
  'dropDatabase',
  'create',
  'createIndexes',
  'dropIndexes',
  'modify',
  'shardCollection',
  'refineCollectionShardKey',
  'reshardCollection',
])

/** Spec §4.2, final review M3: a live feed further behind than this says how far. */
export const BEHIND_MS = 2_000

/** Phase 3e-1: the Watch feed's words, in the reader's language. */
export function useWatchWords() {
  const { t, locale } = useI18n()
  const op = (name: string) => t(`watch.ops.${KNOWN_OPS.has(name) ? name : 'other'}`)
  function reason(feed: Pick<WatchFeed, 'reason' | 'detail' | 'status'>): string {
    if (feed.status.value === 'unavailable') return t('watch.reason.unavailable')
    const r = feed.reason.value
    if (!r) return ''
    if (r === 'limit') {
      const which = feed.detail.value
      return t(
        which === 'socket'
          ? 'watch.reason.limitSocket'
          : which === 'user'
            ? 'watch.reason.limitUser'
            : which === 'server'
              ? 'watch.reason.limitServer'
              : which === 'rate'
                ? 'watch.reason.limitRate'
                : 'watch.reason.limit',
      )
    }
    if (r === 'filter') {
      const problem = feed.detail.value
      return t(
        `watch.reason.filterProblem.${problem === 'size' || problem === 'depth' || problem === 'server_js' || problem === 'ejson' ? problem : 'other'}`,
      )
    }
    if (r === 'masking_filter' && feed.detail.value === 'scope') return t('watch.reason.maskingScope')
    if (r === 'masking_filter' && feed.detail.value === 'shape') return t('watch.reason.maskingShape')
    return t(`watch.reason.${r}`, { detail: feed.detail.value ?? '' })
  }
  function status(feed: Pick<WatchFeed, 'status' | 'lagMs'>): string {
    const s = feed.status.value
    if (s === 'live' && feed.lagMs.value >= BEHIND_MS)
      return t('watch.status.behind', { n: Math.round(feed.lagMs.value / 1000) })
    return t(`watch.status.${s}`)
  }
  /** Relative time ("12 seconds ago"), in the reader's locale. */
  function when(ms: number, now: number): string {
    const seconds = Math.round((ms - now) / 1000)
    const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return rtf.format(seconds, 'second')
    const minutes = Math.round(seconds / 60)
    if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
    return rtf.format(Math.round(minutes / 60), 'hour')
  }
  return { op, reason, status, when }
}

/** An event's time in milliseconds: MongoDB's wall time, or its cluster time. */
export const eventTime = (e: { wallTime?: number; clusterTime: number }) => e.wallTime ?? e.clusterTime * 1000
