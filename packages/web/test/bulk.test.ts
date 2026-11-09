// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import BulkDialog from '../src/documents/BulkDialog.vue'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PREFIX = 'connections/c1/databases/shop/collections/orders'
const T = { connectionId: 'c1', db: 'shop', coll: 'orders' }

function open(
  operation: 'update' | 'delete',
  handlers: Record<string, Handler>,
  initialFilter = "{ status: 'old' }",
) {
  const api = mockApi(handlers)
  const { wrapper } = mountApp(BulkDialog, { props: { target: T, operation, initialFilter, fields: [] } })
  return { ...api, wrapper }
}

const run = () => button('Run')

describe('bulk delete', () => {
  it('previews, then runs with the signed preview', async () => {
    const { calls, wrapper } = open('delete', {
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 3, total: 10, requiresConfirmation: false, filterHash: 'tok' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [200, { deleted: 3 }],
    })
    expect(run().disabled).toBe(true)
    button('Preview').click()
    await flushPromises()
    expect(calls[0]!.body).toEqual({ filter: { status: 'old' }, operation: 'delete' })
    expect(document.body.textContent).toContain('3 of 10 documents match.')
    run().click()
    await flushPromises()
    expect(calls[1]!.body).toEqual({ filter: { status: 'old' }, operation: 'delete', filterHash: 'tok' })
    expect(useToastStore().toasts.at(-1)?.message).toBe('3 documents deleted.')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('forgets the preview when the filter changes (Review Focus 4)', async () => {
    open('delete', {
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 3, total: 10, requiresConfirmation: false, filterHash: 'tok' },
      ],
    })
    button('Preview').click()
    await flushPromises()
    expect(run().disabled).toBe(false)
    await typeInto(byLabel<HTMLTextAreaElement>('Filter'), "{ status: 'new' }")
    expect(run().disabled).toBe(true)
    expect(document.body.textContent).not.toContain('3 of 10')
  })

  it('needs the collection name when every document is affected', async () => {
    const { calls } = open(
      'delete',
      {
        [`POST ${PREFIX}/bulk/preview`]: () => [
          200,
          { matched: 10, total: 10, requiresConfirmation: true, filterHash: 'tok' },
        ],
        [`POST ${PREFIX}/bulk/execute`]: () => [200, { deleted: 10 }],
      },
      '{}',
    )
    button('Preview').click()
    await flushPromises()
    expect(document.body.textContent).toContain('This affects every document in orders.')
    expect(run().disabled).toBe(true)
    await typeInto(byLabel('Type orders to confirm'), 'orders')
    run().click()
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({ confirm: 'orders', filterHash: 'tok' })
  })

  it('asks for a new preview when the server says it is stale', async () => {
    open('delete', {
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 3, total: 10, requiresConfirmation: false, filterHash: 'tok' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [
        409,
        { code: 'CONFLICT', message: 'The number of matching documents changed from 3 to 4; preview again' },
      ],
    })
    button('Preview').click()
    await flushPromises()
    run().click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('changed from 3 to 4')
    expect(run().disabled).toBe(true)
  })
})

describe('bulk update', () => {
  it('sends update operators as canonical EJSON and rejects replacement documents', async () => {
    const { calls } = open('update', {
      [`POST ${PREFIX}/bulk/preview`]: () => [
        200,
        { matched: 2, total: 10, requiresConfirmation: false, filterHash: 'tok' },
      ],
      [`POST ${PREFIX}/bulk/execute`]: () => [200, { matched: 2, modified: 2 }],
    })
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), '{ qty: 1 }')
    button('Preview').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Expected update operators or a pipeline of stages.')
    expect(calls).toHaveLength(0)
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), '{ $inc: { qty: 1 } }')
    button('Preview').click()
    await flushPromises()
    run().click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({
      filter: { status: 'old' },
      operation: 'update',
      update: { $inc: { qty: { $numberInt: '1' } } },
      filterHash: 'tok',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('2 of 2 documents updated.')
  })
})

/** W2.3 (2026-10-16): the preview shows sampled documents before and after, not only counts. */
describe('bulk preview samples', () => {
  const preview = (samples: unknown) => (): [number, unknown] => [
    200,
    { matched: 2, total: 10, requiresConfirmation: false, filterHash: 'tok', samples },
  ]

  it('shows what changes in each sampled document, and one the update would fail on', async () => {
    open('update', {
      [`POST ${PREFIX}/bulk/preview`]: preview({
        documents: [
          {
            before: { _id: { $numberInt: '1' }, qty: { $numberInt: '1' }, email: '***' },
            after: { _id: { $numberInt: '1' }, qty: { $numberInt: '2' }, email: '***' },
          },
          { before: { _id: { $numberInt: '2' }, qty: 'text' }, fails: true },
          {
            before: { _id: { $numberInt: '3' }, qty: { $numberInt: '5' } },
            after: { _id: { $numberInt: '3' }, qty: { $numberInt: '5' } },
          },
        ],
      }),
    })
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), '{ $inc: { qty: 1 } }')
    button('Preview').click()
    await flushPromises()
    const samples = [...document.querySelectorAll('[data-bulk-sample]')]
    expect(samples).toHaveLength(3)
    expect(samples[0]!.querySelector('[data-kind="changed"]')!.textContent).toContain('qty')
    // A masked value stays masked, and is not a change.
    expect(samples[0]!.textContent).not.toContain('email')
    expect(samples[1]!.textContent).toContain('The update would fail on this document')
    expect(samples[2]!.textContent).toContain('Unchanged')
  })

  // Re-review (minor 5): the page says when samples were left out to keep the glance small.
  it('says when some samples were left out', async () => {
    open('delete', {
      [`POST ${PREFIX}/bulk/preview`]: preview({
        documents: [{ before: { _id: { $numberInt: '7' }, status: 'old' } }],
        cut: true,
      }),
    })
    button('Preview').click()
    await flushPromises()
    expect(document.querySelector('[data-bulk-samples]')!.textContent).toContain(
      'Larger documents were left out of these samples.',
    )
  })

  it('shows the documents a delete removes', async () => {
    open('delete', {
      [`POST ${PREFIX}/bulk/preview`]: preview({
        documents: [{ before: { _id: { $numberInt: '7' }, status: 'old' } }],
      }),
    })
    button('Preview').click()
    await flushPromises()
    const [sample] = document.querySelectorAll('[data-bulk-sample]')
    expect(sample!.textContent).toContain('status')
    expect(sample!.textContent).toContain('"old"')
  })

  // W2 review (I3, minor 3): _id updates, documents that changed between the reads, large ones.
  it.each([
    ['id', 'MongoDB refuses any change of _id'],
    ['changed', 'changed while they were read'],
    ['large', 'too large to show here'],
  ])('says why there are no samples: %s', async (reason, words) => {
    open('update', { [`POST ${PREFIX}/bulk/preview`]: preview({ unavailable: reason }) })
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), '{ $set: { _id: 1 } }')
    button('Preview').click()
    await flushPromises()
    expect(document.querySelector('[data-bulk-samples]')!.textContent).toContain(words)
  })

  it('says why there are no samples, with MongoDB’s words when it gave some', async () => {
    open('update', { [`POST ${PREFIX}/bulk/preview`]: preview({ unavailable: 'positional' }) })
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), "{ $set: { 'a.$[]': 1 } }")
    button('Preview').click()
    await flushPromises()
    expect(document.querySelector('[data-bulk-samples]')!.textContent).toContain('positional')
    document.body.innerHTML = ''
    open('update', {
      [`POST ${PREFIX}/bulk/preview`]: preview({ unavailable: 'error', message: 'Failed to parse' }),
    })
    await typeInto(byLabel<HTMLTextAreaElement>('Update'), '[{ $set: { n: 1 } }]')
    button('Preview').click()
    await flushPromises()
    expect(document.querySelector('[data-bulk-samples]')!.textContent).toContain('Failed to parse')
  })
})
