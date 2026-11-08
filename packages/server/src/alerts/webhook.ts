// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHmac, randomUUID } from 'node:crypto'
import { EgressError, discard, type Egress } from '../net/egress'

/**
 * W3.3: a webhook delivery. The body is JSON; its HMAC-SHA256 over "<timestamp>.<body>" with the
 * webhook's own secret goes in x-mm-signature (as "sha256=<hex>") with the timestamp beside it, so
 * the receiver can check both who sent it and that it is fresh. Through the egress guard (no
 * redirects, no proxies, public addresses unless the operator listed a network); a failure the
 * other side may recover from (network, 5xx, 408, 429) is tried again after growing waits.
 */
export const DEFAULT_RETRY_MS = [2_000, 10_000, 60_000]
const ANSWER_MS = 15_000

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

export interface WebhookResult {
  ok: boolean
  attempts: number
  /** "HTTP 400", or the egress reason (address_refused, timeout…). */
  error: string | null
}

const retriable = (status: number) => status >= 500 || status === 408 || status === 429

export async function postWebhook(
  egress: Egress,
  target: { url: string; secret: string },
  payload: { type: string } & Record<string, unknown>,
  opts: { retryMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<WebhookResult> {
  const delays = opts.retryMs ?? DEFAULT_RETRY_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()))
  const body = JSON.stringify(payload)
  const delivery = randomUUID()
  let attempts = 0
  let error: string | null
  for (;;) {
    attempts++
    // Signed per attempt: a retry carries a fresh timestamp (receivers may refuse old ones).
    const timestamp = String(Math.floor((opts.now ?? Date.now)() / 1000))
    try {
      const res = await egress.request({
        method: 'POST',
        url: target.url,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'mongo-manager-alerts',
          'x-mm-event': payload.type,
          'x-mm-delivery': delivery,
          'x-mm-timestamp': timestamp,
          'x-mm-signature': signWebhook(target.secret, timestamp, body),
        },
        body: Buffer.from(body, 'utf8'),
        deadlineMs: ANSWER_MS,
      })
      discard(res.body)
      if (res.status >= 200 && res.status < 300) return { ok: true, attempts, error: null }
      error = `HTTP ${res.status}`
      if (!retriable(res.status)) return { ok: false, attempts, error }
    } catch (e) {
      error = e instanceof EgressError ? e.reason : 'network'
      // An address the guard refuses stays refused: no retry.
      if (
        e instanceof EgressError &&
        ['address_refused', 'address_never', 'http_refused', 'bad_url', 'redirect'].includes(e.reason)
      )
        return { ok: false, attempts, error }
    }
    if (attempts > delays.length) return { ok: false, attempts, error }
    await sleep(delays[attempts - 1]!)
  }
}
