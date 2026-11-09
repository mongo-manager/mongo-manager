// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { AskError, type Accent, type PluginClient, type PluginContext } from '../src/client'

/**
 * Plugins wave 3: a plugin client for view tests, answering from `handlers` as the app would — its
 * context a copy (what the page keeps never changes under it), one pipeline at a time. `greet`
 * plays the app's greeting; `contexts` are the page's listeners for a language or theme change.
 */
export function fakeClient(
  opts: {
    place: PluginContext['place']
    kind?: string
    id?: string
    settings?: PluginContext['settings']
    locale?: string
  },
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let ready: (() => void) | null = null
  let aggregating = false
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const contribution = { kind: opts.kind ?? 'collectionTab', id: opts.id ?? 'tab' }
  const client: PluginClient = {
    contribution,
    ask: async <T>(method: string, params?: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: p })
      if (method === 'context.get')
        return {
          plugin: { id: 'test', version: '1' },
          contribution,
          locale: opts.locale ?? 'en',
          theme: 'light',
          accent: 'emerald',
          place: structuredClone(opts.place),
          settings: opts.settings ?? {},
        } as T
      const handler = handlers[method]
      if (!handler) throw new AskError('unavailable', `No ${method} here`)
      if (method === 'documents.aggregate') {
        if (aggregating) throw new AskError('busy', 'Its last pipeline is still running')
        aggregating = true
        try {
          return (await handler(p)) as T
        } finally {
          aggregating = false
        }
      }
      return (await handler(p)) as T
    },
    onReady: (fn) => {
      ready = fn
    },
    onContext: (fn) => {
      contexts.push(fn)
    },
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

/**
 * User report 2026-11-07: an API log of about 60 KB — 17 of them fit in one answer, 100 do not.
 * `i` makes each one's _id (in order) and its at.
 */
export const apiLog = (i: number) => ({
  _id: { $oid: i.toString(16).padStart(24, '0') },
  at: { $date: new Date(Date.UTC(2026, 10, 5, 10, 0, i)).toISOString() },
  path: '/api/v1/orders',
  status: { $numberInt: '200' },
  request: { headers: { 'user-agent': 'x'.repeat(200) }, body: 'b'.repeat(30_000) },
  response: { status: { $numberInt: '200' }, body: 'r'.repeat(30_000) },
})

/** What one answer may be, less its envelope, as the app measures it (bridge.ts answerRoom). */
const ROOM = 1024 * 1024 - 512
const sizeOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

/**
 * User report 2026-11-07: documents answered as the app answers documents.find / findIn / aggregate:
 * at most `limit` (100 by default), an answer over 1 MB `too_large` — unless asked with `fit`, then
 * the whole documents that fit, in order, and `cut`. `documents` are those the read matched, in order.
 */
export function answerOf(
  documents: readonly unknown[],
  params: Record<string, unknown>,
  method: 'find' | 'findIn' | 'aggregate' = 'find',
) {
  const limit = typeof params.limit === 'number' ? params.limit : method === 'findIn' ? 50 : 100
  const read = documents.slice(0, limit)
  const more = documents.length > read.length
  const fit = params.fit === true
  let used = sizeOf({ documents: [], hasMore: false, truncated: false, cut: false })
  let n = 0
  for (const d of read) {
    const grown = used + sizeOf(d) + (n ? 1 : 0)
    if (grown > ROOM) break
    used = grown
    n++
  }
  const cut = n < read.length
  if (cut && (!fit || n === 0)) throw new AskError('too_large', 'The answer is over 1 MB')
  const kept = read.slice(0, n)
  if (method === 'aggregate') return { documents: kept, truncated: more || cut, ...(fit ? { cut } : {}) }
  if (method === 'findIn' && !fit) return { documents: kept }
  return { documents: kept, hasMore: more || cut, ...(fit ? { cut } : {}) }
}

/** A few turns of the event loop. */
export const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
