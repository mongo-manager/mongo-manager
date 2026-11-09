// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { answerOf, apiLog, fakeClient, flush } from '../../kit/test/fakeClient'
import { PREVIEW_DELAY, mount } from '../src/view'

/**
 * User report 2026-11-07: a collection of API logs of ~60 KB a document. 50 of them are over the
 * 1 MB one answer may be: the tab stopped with "This is too large to send" when it opened.
 */
const PLACE = {
  connectionId: 'c',
  connectionName: 'Logs',
  db: 'shop',
  coll: 'logs',
  documentId: null,
  hidden: [],
}
type Doc = Record<string, unknown>

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
const settle = async () => {
  await new Promise((r) => setTimeout(r, PREVIEW_DELAY + 30))
  await flush()
}

/** `reshaped` stands in for MongoDB running the steps on each document the preview names by _id. */
async function opened(docs: Doc[], reshaped = (d: Doc) => d) {
  const fake = fakeClient(
    { place: PLACE },
    {
      'documents.find': (p) => answerOf(docs, p),
      'documents.aggregate': (p) => {
        const ids = (p.pipeline as Array<{ $match?: { _id: { $in: unknown[] } } }>)[0]!.$match!._id.$in.map(
          (id) => JSON.stringify(id),
        )
        return answerOf(docs.filter((d) => ids.includes(JSON.stringify(d._id))).map(reshaped), p, 'aggregate')
      },
    },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

describe('the reshape tab on documents too large for one answer (user report 2026-11-07)', () => {
  it('opens, its fields read from the documents that fit in one answer', async () => {
    const { calls } = await opened(Array.from({ length: 100 }, (_, i) => apiLog(i)))
    expect(app().textContent).not.toContain('too large')
    expect(calls.find((c) => c.method === 'documents.find')!.params).toMatchObject({ fit: true })
    app().querySelector<HTMLSelectElement>('#kind')!.value = 'remove'
    app().querySelector<HTMLButtonElement>('#add-step')!.click()
    await settle()
    const options = [...app().querySelectorAll<HTMLOptionElement>('#steps select option')].map((o) => o.value)
    expect(options).toContain('path')
    expect(options).toContain('response.body')
  })

  it('previews the documents that fit, each beside itself, never an empty "after"', async () => {
    // Five documents of ~150 KB fit in one answer; reshaped to ~300 KB each (a copied field), three do.
    const big = Array.from({ length: 5 }, (_, i) => ({
      ...apiLog(i),
      request: { body: 'b'.repeat(120_000) },
    }))
    const { calls } = await opened(big, (d) => ({ ...d, copy: 'c'.repeat(150_000) }))
    app().querySelector<HTMLSelectElement>('#kind')!.value = 'remove'
    app().querySelector<HTMLButtonElement>('#add-step')!.click()
    await settle()
    expect(calls.find((c) => c.method === 'documents.aggregate')!.params).toMatchObject({ fit: true })
    expect(app().textContent).not.toContain('too large')
    const before = app().querySelector('#before')!.textContent!
    const after = app().querySelector('#after')!.textContent!
    const count = (text: string) => text.split('\n\n').filter((d) => d.trim()).length
    expect(count(after)).toBeGreaterThan(0)
    expect(count(after)).toBeLessThan(5)
    expect(count(before)).toBe(count(after))
    expect(after).not.toContain('{}')
    expect(after).toContain('copy')
  })
})
