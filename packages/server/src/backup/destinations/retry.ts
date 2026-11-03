import { setTimeout as delay } from 'node:timers/promises'
import { EgressError } from '../../net/egress'
import { DestinationError } from './types'

/** Phase 3d-3b spec §2.1: three retries, 1, 4 and 16 s; Retry-After honoured up to 60 s. */
export const RETRY_DELAYS = [1000, 4000, 16000]
export const MAX_RETRY_AFTER_MS = 60_000

export function retryAfterMs(header: string | string[] | undefined, now: number): number | undefined {
  const v = Array.isArray(header) ? header[0] : header
  if (!v) return undefined
  if (/^\d+$/.test(v.trim())) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS)
}

export function isRetryable(e: unknown): boolean {
  if (e instanceof EgressError)
    return e.reason === 'network' || e.reason === 'timeout' || e.reason === 'connect'
  if (e instanceof DestinationError) {
    const s = e.extra.status
    // Transient answers only: 507 (full), 501 or 505 will say the same thing again.
    if (s !== undefined) return s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504
    return e.reason === 'network' || e.reason === 'timeout' || e.reason === 'connect'
  }
  return false
}

const sleepFor = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    signal: AbortSignal
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    /** How many retries at most (default: all of RETRY_DELAYS); 0 for someone waiting on the answer. */
    retries?: number
  },
): Promise<T> {
  const sleep = opts.sleep ?? sleepFor
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      const most = Math.min(opts.retries ?? RETRY_DELAYS.length, RETRY_DELAYS.length)
      if (attempt >= most || !isRetryable(e) || opts.signal.aborted) throw e
      const after = e instanceof DestinationError ? e.extra.retryAfterMs : undefined
      await sleep(
        after !== undefined ? Math.min(after, MAX_RETRY_AFTER_MS) : RETRY_DELAYS[attempt]!,
        opts.signal,
      )
    }
  }
}
