import { describe, expect, it, vi } from 'vitest'
import { createRenderer } from '../src/renderer'

const oid = (c: string) => ({ $oid: c.repeat(24) })
const place = { connectionId: 'c1', db: 'shop', coll: 'orders' }

function fakeApp(found: Record<string, Array<Record<string, unknown>>>) {
  const asked: Array<{ method: string; params: Record<string, unknown> }> = []
  const ask = vi.fn(async (method: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>
    asked.push({ method, params: p })
    if (method === 'collections.list')
      return [
        { name: 'customers', type: 'collection' },
        { name: 'recent', type: 'view' },
      ]
    if (method === 'documents.findIn') {
      const wanted = ((p.filter as { _id: { $in: Array<{ $oid: string }> } })._id.$in ?? []).map(
        (x) => x.$oid,
      )
      return {
        documents: (found[p.coll as string] ?? []).filter((d) =>
          wanted.includes((d._id as { $oid: string }).$oid),
        ),
      }
    }
    throw new Error(`unexpected ${method}`)
  })
  return { ask, asked }
}

describe('the names beside referencing ObjectIds (references renderer)', () => {
  it('learns where a field refers to, names what it finds, and says what is missing', async () => {
    const { ask, asked } = fakeApp({ customers: [{ _id: oid('1'), name: 'Ada' }] })
    const render = createRenderer(ask as never)
    const answer = await render([oid('1'), oid('2')], ['customerId', 'customerId'], place, 'en')
    expect(answer).toEqual([
      { text: '→ Ada', tone: 'info' },
      { text: '→ not found', tone: 'warning' },
    ])
    const findIn = asked.find((a) => a.method === 'documents.findIn')!
    expect(findIn.params).toMatchObject({ place, coll: 'customers', limit: 200 })
    // Asked again: from what it knows, reading nothing.
    const calls = ask.mock.calls.length
    expect(await render([oid('1')], ['customerId'], place, 'tr')).toEqual([{ text: '→ Ada', tone: 'info' }])
    expect(await render([oid('2')], ['customerId'], place, 'tr')).toEqual([
      { text: '→ bulunamadı', tone: 'warning' },
    ])
    expect(ask.mock.calls.length).toBe(calls)
  })

  it('says nothing for a field no collection is named like, or without a place', async () => {
    const { ask } = fakeApp({})
    const render = createRenderer(ask as never)
    expect(await render([oid('1')], ['ownerId'], place, 'en')).toEqual([null])
    expect(await render([oid('1')], ['customerId'], null, 'en')).toEqual([null])
    expect(await render([oid('1')], [null], place, 'en')).toEqual([null])
    expect(ask.mock.calls.filter(([m]) => m === 'documents.findIn')).toHaveLength(0)
  })

  it('asks to be asked again when the app refuses a read, and then names it', async () => {
    let refuse = true
    const ask = vi.fn(async (method: string) => {
      if (method === 'collections.list') return [{ name: 'customers', type: 'collection' }]
      if (refuse) throw new Error('too_many')
      return { documents: [{ _id: oid('1'), title: 'First' }] }
    })
    const render = createRenderer(ask as never)
    // Asked again later by the app (review M2), not answered "nothing" for good.
    expect(await render([oid('1')], ['customerId'], place, 'en')).toEqual([{ retry: true }])
    refuse = false
    expect(await render([oid('1')], ['customerId'], place, 'en')).toEqual([{ text: '→ First', tone: 'info' }])
  })
})
