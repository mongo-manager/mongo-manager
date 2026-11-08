// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { answerOf, apiLog, fakeClient, flush } from '../../kit/test/fakeClient'
import { findReferences } from '../src/find'
import { PER_FIELD, findReferring } from '../src/referenced'
import { createRenderer } from '../src/renderer'
import { mount } from '../src/view'

/**
 * User report 2026-11-07: API logs of ~60 KB a document. 200 of them are over the 1 MB one answer
 * may be, and every Find stopped with "This is too large to send".
 */
type Doc = Record<string, unknown>
const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, 'c') })
const PLACE = { connectionId: 'c', connectionName: 'Logs', db: 'shop', coll: 'logs', documentId: null }
/** Ten customers, each named at length (~150 KB): five fit in one answer. */
const CUSTOMERS = Array.from({ length: 10 }, (_, i) => ({ _id: oid(i), name: `${i}-${'n'.repeat(150_000)}` }))
const LOGS = Array.from({ length: 300 }, (_, i) => ({ ...apiLog(i), customerId: oid(i % 10) }))
const LIST = [
  { name: 'logs', type: 'collection' },
  { name: 'customers', type: 'collection' },
]
/** The documents of `db[coll]` whose _id the filter's $in names, answered as the app answers. */
const findIn = (db: Record<string, Doc[]>) => (p: Record<string, unknown>) => {
  const wanted = (p.filter as { _id: { $in: Array<{ $oid: string }> } })._id.$in.map((x) => x.$oid)
  const matched = (db[p.coll as string] ?? []).filter((d) =>
    wanted.includes((d._id as { $oid: string }).$oid),
  )
  return answerOf(matched, p, 'findIn')
}
const handlers = {
  'documents.aggregate': (p: Record<string, unknown>) => answerOf(LOGS, p, 'aggregate'),
  'collections.list': () => LIST,
  'documents.findIn': findIn({ customers: CUSTOMERS }),
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})

describe('references among documents too large for one answer (user report 2026-11-07)', () => {
  it('finds them on a collection of large documents, from the documents that fit in one answer', async () => {
    const fake = fakeClient({ place: PLACE }, handlers)
    mount(document.getElementById('app')!, fake.client)
    fake.greet()
    await flush(8)
    const app = document.getElementById('app')!
    expect(app.textContent).not.toContain('too large')
    expect(app.querySelector('[data-relation="customerId"]')!.textContent).toContain('customers')
    expect(fake.calls.find((c) => c.method === 'documents.aggregate')!.params).toMatchObject({ fit: true })
  })

  it('finds every referenced document, when their names are too large for one answer', async () => {
    const ask = <T>(method: string, params?: unknown) =>
      Promise.resolve(
        (handlers as Record<string, (p: Record<string, unknown>) => unknown>)[method]!(
          (params ?? {}) as Record<string, unknown>,
        ) as T,
      )
    const found = await findReferences(ask, () => {})
    const relation = found.relations.find((r) => r.path === 'customerId')!
    expect(found.stopped).toBeNull()
    expect(relation.matched).toBe(10)
    expect(relation.share).toBe(1)
  })

  it('names every referencing id in a cell, when their names are too large for one answer', async () => {
    const ask = async (method: string, params?: unknown) =>
      method === 'collections.list'
        ? LIST
        : findIn({ customers: CUSTOMERS })((params ?? {}) as Record<string, unknown>)
    const render = createRenderer(ask as never)
    const values = CUSTOMERS.map((c) => c._id)
    const answer = (await render(
      values,
      values.map(() => 'customerId'),
      { connectionId: 'c', db: 'shop', coll: 'logs' },
      'en',
    )) as Array<{ text: string; tone: string } | null>
    expect(answer.every((a) => a?.tone === 'info')).toBe(true)
  })

  it('lists the referring documents that fit, and says there are more', async () => {
    const MODEL = {
      collections: [{ name: 'logs', type: 'collection' }],
      references: [{ from: 'logs', field: 'customerId', to: 'customers', toField: '_id' }],
    }
    const referring = Array.from({ length: PER_FIELD + 1 }, (_, i) => ({ _id: i, name: 'n'.repeat(150_000) }))
    const ask = async <T>(method: string, params?: unknown): Promise<T> =>
      (method === 'database.model'
        ? MODEL
        : answerOf(referring, (params ?? {}) as Record<string, unknown>, 'findIn')) as T
    const found = await findReferring(ask, 'customers', oid(1))
    expect(found.failed).toEqual([])
    expect(found.groups).toHaveLength(1)
    expect(found.groups[0]!.documents.length).toBeGreaterThan(0)
    expect(found.groups[0]!.documents.length).toBeLessThan(PER_FIELD)
    expect(found.groups[0]!.more).toBe(true)
  })
})
