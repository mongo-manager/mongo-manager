// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Accent, PluginClient, PluginContext } from '../../kit/src/client'
import { AskError } from '../../kit/src/client'
import { mount } from '../src/view'
import { bucketFilter } from '../src/ttl'

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}
type Params = { pipeline?: Array<Record<string, unknown>>; filter?: unknown }
type Handler = (params: Params) => unknown

function fakeClient(place: PluginContext['place'], handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'expiry' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'context.get')
        return {
          plugin: { id: 'ttl-view', version: '1' },
          contribution: { kind: 'collectionTab', id: 'expiry' },
          locale: 'en',
          theme: 'light',
          accent: 'violet',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts }
}

const int = (n: number) => ({ $numberInt: String(n) })
const NOW = Date.UTC(2026, 9, 28, 12)
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'sessions', documentId: null }
const INDEXES = [
  { name: '_id_', key: { _id: int(1) }, options: {} },
  { name: 'lastSeen_1', key: { lastSeen: int(1) }, options: { expireAfterSeconds: int(86400) } },
]
const TTL = { name: 'lastSeen_1', field: 'lastSeen', after: 86400, partial: null }
/** Counts by group, matched on the pipeline's filter. */
const COUNTS: Record<string, number> = { waiting: 0, hour: 12, day: 340, week: 0, later: 0, never: 3 }
const counting: Handler = (p) => {
  const filter = JSON.stringify((p.pipeline![0] as { $match: unknown }).$match)
  for (const [bucket, n] of Object.entries(COUNTS))
    if (JSON.stringify(bucketFilter(TTL, bucket as never, NOW)) === filter)
      return { documents: n ? [{ n: int(n) }] : [] }
  throw new Error(`unexpected ${filter}`)
}
const app = () => document.getElementById('app')!
const row = (bucket: string) => document.querySelector<HTMLElement>(`[data-bucket="${bucket}"]`)!

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
})

describe('the Expiry tab', () => {
  it('counts each group of each TTL index, one pipeline at a time, and says when they go', async () => {
    let inFlight = 0
    let most = 0
    const { client, greet, calls } = fakeClient(PLACE, {
      'indexes.list': () => INDEXES,
      'documents.aggregate': async (p) => {
        most = Math.max(most, ++inFlight)
        await new Promise((r) => setTimeout(r, 0))
        inFlight--
        return counting(p)
      },
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(calls.filter((c) => c.method === 'documents.aggregate')).toHaveLength(6)
    expect(most).toBe(1)
    expect(document.querySelector('[data-index="lastSeen_1"]')!.textContent).toContain(
      'Removes a document 1 day after its lastSeen',
    )
    expect(row('hour').textContent).toContain('12 documents')
    expect(row('day').textContent).toContain('340 documents')
    expect(row('never').textContent).toContain('3 documents')
    expect(row('waiting').textContent).toContain('0 documents')
    expect(row('waiting').querySelector('[data-show]')).toBeNull()
  })

  it('shows a group’s documents in Documents', async () => {
    const { client, greet, calls } = fakeClient(PLACE, {
      'indexes.list': () => INDEXES,
      'documents.aggregate': counting,
      'ui.useQuery': () => true,
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    row('never').querySelector<HTMLButtonElement>('[data-show]')!.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.useQuery')!.params.filter).toEqual({
      lastSeen: { $not: { $type: 'date' } },
    })
  })

  it('says a group it could not count, and lists the others', async () => {
    const { client, greet } = fakeClient(PLACE, {
      'indexes.list': () => INDEXES,
      'documents.aggregate': (p) => {
        const filter = JSON.stringify((p.pipeline![0] as { $match: unknown }).$match)
        if (filter === JSON.stringify(bucketFilter(TTL, 'never', NOW))) throw new AskError('failed', 'denied')
        return counting(p)
      },
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(row('never').textContent).toContain('Could not be counted')
    // Its reason is on the page, not only in a tooltip (review 2026-10-28).
    expect(document.querySelector('[data-index="lastSeen_1"] .tt-errors')!.textContent).toBe('Never: denied')
    expect(row('day').textContent).toContain('340 documents')
  })

  it('says when there is no TTL index, on a view, and when the indexes could not be read', async () => {
    const { client, greet } = fakeClient(PLACE, { 'indexes.list': () => INDEXES.slice(0, 1) })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(app().textContent).toContain('This collection has no TTL index')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const view = fakeClient({ ...PLACE, view: true } as PluginContext['place'], { 'indexes.list': () => [] })
    mount(app(), view.client, () => NOW)
    view.greet()
    await flush()
    expect(app().textContent).toContain('A view has no indexes of its own')
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    const failing = fakeClient(PLACE, {
      'indexes.list': () => {
        throw new AskError('failed', 'MongoDB is not available')
      },
    })
    mount(app(), failing.client, () => NOW)
    failing.greet()
    await flush()
    expect(app().textContent).toContain('The indexes could not be read')
  })

  it('names a partial filter and an expiry at the field’s date, and says it in Turkish', async () => {
    const partial = [
      {
        name: 'at_1',
        key: { at: int(1) },
        options: { expireAfterSeconds: int(0), partialFilterExpression: { kind: 'temp' } },
      },
    ]
    const { client, greet, contexts } = fakeClient(PLACE, {
      'indexes.list': () => partial,
      'documents.aggregate': () => ({ documents: [] }),
    })
    mount(app(), client, () => NOW)
    greet()
    await flush()
    const card = document.querySelector('[data-index="at_1"]')!
    expect(card.textContent).toContain('Removes a document at the field’s date')
    expect(card.textContent).toContain("Only documents matching { kind: 'temp' }")
    for (const fn of contexts) fn('tr', 'light', 'violet')
    expect(document.querySelector('[data-index="at_1"]')!.textContent).toContain(
      'Bir belgeyi at alanındaki tarihte siler',
    )
    expect(row('never').textContent).toContain('Hiçbir zaman')
  })

  it('needs a collection', async () => {
    const { client, greet, calls } = fakeClient(null, {})
    mount(app(), client, () => NOW)
    greet()
    await flush()
    expect(app().textContent).toContain('Open a collection to see when its documents expire.')
    expect(calls.some((c) => c.method === 'indexes.list')).toBe(false)
  })
})
