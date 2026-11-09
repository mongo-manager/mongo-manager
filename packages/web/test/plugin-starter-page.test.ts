// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Review 2026-10-11: the starter's page, run as the app runs it — greeted, asked, answered — so what
// it promises (text only, Reload reads the Documents filter again, a labelled table) holds.
interface Request {
  mm: 1
  id: number
  method: string
  params?: Record<string, unknown>
  token: string
}
const sent: Request[] = []
const answer = (id: number, result: unknown) =>
  window.dispatchEvent(new MessageEvent('message', { data: { mm: 1, id, result }, source: window }))
const nextRequest = async (method: string) => {
  let found: Request | undefined
  await vi.waitFor(() => {
    found = sent.find((r) => r.method === method)
    expect(found, method).toBeTruthy()
  })
  sent.splice(sent.indexOf(found!), 1)
  return found!
}
const context = (filter: object) => ({
  plugin: { id: 'hello-documents', version: '0.1.0' },
  contribution: { kind: 'collectionTab', id: 'list' },
  locale: 'en',
  theme: 'light',
  accent: 'emerald',
  place: {
    connectionId: 'c1',
    connectionName: 'Prod',
    db: 'shop',
    coll: 'orders',
    view: false,
    documentId: null,
    filter,
  },
  settings: {},
})

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>'
  vi.spyOn(window, 'postMessage').mockImplementation(((m: Request) => void sent.push(m)) as never)
  // @ts-expect-error -- a page script that exports nothing: imported to run it, as the frame does.
  await import('../../plugins/starter/main.js')
  window.dispatchEvent(
    new MessageEvent('message', { data: { mm: 1, type: 'hello', token: 't1' }, source: window }),
  )
})
afterAll(() => vi.restoreAllMocks())

describe('the starter’s page', () => {
  it('reads with the Documents filter, shows values as text, labels every column', async () => {
    answer((await nextRequest('context.get')).id, context({ status: 'paid' }))
    const find = await nextRequest('documents.find')
    expect(find.token).toBe('t1')
    expect(find.params).toEqual({ filter: { status: 'paid' }, limit: 50, fit: true })
    answer(find.id, {
      documents: [{ _id: { $oid: '64b0f0f0f0f0f0f0f0f0f0f0' }, name: '<img src=x onerror=alert(1)>' }],
      hasMore: false,
    })
    await vi.waitFor(() => expect(document.querySelector('tbody td')).not.toBeNull())
    expect(document.querySelector('#app img')).toBeNull()
    expect(document.querySelector('tbody')!.textContent).toContain('<img src=x onerror=alert(1)>')
    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers.every((h) => h)).toBe(true)
    expect(headers.at(-1)).toBe('Actions')
  })

  it('asks for the context again on Reload: the Documents filter may have changed', async () => {
    const reload = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reload')!
    reload.click()
    answer((await nextRequest('context.get')).id, context({ status: 'refunded' }))
    const find = await nextRequest('documents.find')
    expect(find.params).toEqual({ filter: { status: 'refunded' }, limit: 50, fit: true })
    answer(find.id, { documents: [], hasMore: false })
    await vi.waitFor(() => expect(document.body.textContent).toContain('No documents'))
  })
})
