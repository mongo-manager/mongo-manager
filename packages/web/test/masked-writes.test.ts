// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentsView from '../src/documents/DocumentsView.vue'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { stripMasked } from '../src/masking/useMaskedPaths'
import { describeError } from '../src/api/errors'
import { ApiError } from '../src/api/client'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { button, byLabel, typeInto } from './support/dom'

/** Phase 3c §7 (3c-2): editing around the values the server hides. */
const isMasked = (p: readonly string[]) =>
  p.join('.') === 'email' || p.join('.') === 'customer.phone' || (p[0] === 'items' && p.at(-1) === 'cardNo')

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('editing around hidden values (phase 3c §7)', () => {
  it('drops hidden fields from a clone, and says which', () => {
    const { value, dropped } = stripMasked(
      {
        email: '***',
        name: 'Ali',
        customer: { phone: '***', city: 'Izmir' },
        items: [{ cardNo: '***', qty: { $numberInt: '1' } }],
        note: '***',
      },
      isMasked,
    )
    expect(value).toEqual({
      name: 'Ali',
      customer: { city: 'Izmir' },
      items: [{ qty: { $numberInt: '1' } }],
      note: '***',
    })
    expect(dropped).toEqual(['email', 'customer.phone', 'items.0.cardNo'])
  })

  it('walks into objects with $-prefixed field names, but keeps EJSON wrappers whole (final review M6)', () => {
    const { value, dropped } = stripMasked(
      {
        odd: { $tag: '***', a: 1 },
        id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
        when: { $date: '2026-01-01T00:00:00Z' },
      },
      (p) => p.join('.') === 'odd.$tag',
    )
    expect(value).toEqual({
      odd: { a: 1 },
      id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
      when: { $date: '2026-01-01T00:00:00Z' },
    })
    expect(dropped).toEqual(['odd.$tag'])
  })

  it('explains a refused personal write', () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`
    expect(
      describeError(new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_write', field: 'email' }), t),
    ).toBe('masking.personalWrite{"field":"email"}')
  })

  it('does not edit a hidden cell inline, and still edits the others', async () => {
    mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      'POST connections/c1/databases/crm/collections/users/find': () => [
        200,
        {
          documents: [{ document: { _id: 1, email: '***', name: 'Ali' }, hash: 'a'.repeat(64) }],
          hasMore: false,
        },
      ],
      'POST connections/c1/databases/crm/collections/users/count': () => [200, { count: 1, exact: true }],
    })
    useCollectionViewsStore().stateFor('tab-w')
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'crm', coll: 'users' },
        tabId: 'tab-w',
        canWrite: true,
        isView: false,
      },
    })
    await flushPromises()
    expect(document.querySelector('td[data-field="name"]')!.getAttribute('tabindex')).toBe('0')
    expect(document.querySelector('td[data-field="email"]')!.hasAttribute('tabindex')).toBe(false)
  })
})

describe('the document editor around hidden values (phase 3c §7)', () => {
  const PREFIX = 'connections/c1/databases/crm/collections/users'
  async function editor(handlers: Record<string, () => [number, unknown?]> = {}) {
    const api = mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: [
            { document: { _id: { $numberInt: '1' }, email: '***', name: 'Ali' }, hash: 'a'.repeat(64) },
          ],
          hasMore: false,
        },
      ],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
      ...handlers,
    })
    useCollectionViewsStore().stateFor('t')
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'crm', coll: 'users' },
        tabId: 't',
        canWrite: true,
        isView: false,
      },
    })
    mountApp(DialogHost)
    await flushPromises()
    return api
  }
  async function rowAction(label: string) {
    ;(document.querySelector('button[aria-label="Actions for document 1"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === label)!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-document-page]')).not.toBeNull())
    await flushPromises()
  }

  it('clones without the hidden fields, and says so', async () => {
    await editor()
    await rowAction('Clone')
    expect(byLabel<HTMLTextAreaElement>('Document').value).not.toContain('email')
    expect(document.querySelector('[data-clone-dropped]')!.textContent).toContain('email')
  })

  it('stops an edit of a hidden field before sending it', async () => {
    const { calls } = await editor({ [`POST ${PREFIX}/documents/update`]: () => [200, { modified: 1 }] })
    await rowAction('Edit')
    await typeInto(byLabel<HTMLTextAreaElement>('Document'), "{ _id: 1, email: 'x', name: 'Ali' }")
    button('Review and save').click()
    await flushPromises()
    expect(document.body.textContent).toContain(
      'email holds personal data hidden from you and cannot be changed.',
    )
    expect(calls.some((c) => c.path.endsWith('/documents/update'))).toBe(false)
  })
})

describe('filter suggestions around hidden values (UI redesign R1 review)', () => {
  it('offers the values of a visible field, and never those of a hidden one', async () => {
    const PREFIX = 'connections/c1/databases/crm/collections/users'
    mockApi({
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [['email']] }],
      [`POST ${PREFIX}/find`]: () => [
        200,
        {
          documents: [
            { document: { _id: { $numberInt: '1' }, email: '***', name: 'Ali' }, hash: 'a'.repeat(64) },
          ],
          hasMore: false,
        },
      ],
      [`POST ${PREFIX}/count`]: () => [200, { count: 1, exact: true }],
    })
    useCollectionViewsStore().stateFor('t')
    mountApp(DocumentsView, {
      props: {
        target: { connectionId: 'c1', db: 'crm', coll: 'users' },
        tabId: 't',
        canWrite: false,
        isView: false,
      },
    })
    await flushPromises()
    const filter = document.querySelector<HTMLTextAreaElement>('form[role="search"] textarea')!
    const typeAndList = async (text: string) => {
      filter.focus()
      filter.value = text
      filter.setSelectionRange(text.length, text.length)
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      filter.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true }),
      )
      await flushPromises()
      return [...document.querySelectorAll('[role="option"]')].map(
        (o) => o.querySelector('span')?.textContent,
      )
    }
    expect(await typeAndList('{ name: ')).toEqual(['"Ali"'])
    expect(await typeAndList('{ email: ')).not.toContain('"***"')
  })
})
