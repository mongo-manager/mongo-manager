// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentTreeView from '../src/documents/page/DocumentTreeView.vue'
import { searchDocument } from '../src/documents/page/search'
import { decodeDocument, typeOf } from '../src/documents/values'
import { useDialogStore } from '../src/stores/dialogs'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// Document page design §6.4, §6.5, §6.9: a tree walked by keyboard, edited in place.
const DOC = decodeDocument({
  _id: { $numberInt: '7' },
  guest: { name: 'Ada Lin' },
  payments: [
    { method: 'card', amount: { $numberInt: '350' }, card: '***' },
    { method: 'transfer', amount: { $numberInt: '120' } },
  ],
  status: 'pending',
})
const masked = (path: readonly string[]) => path.join('.') === 'payments.0.card'

function tree(props: Record<string, unknown> = {}) {
  return mountApp(DocumentTreeView, {
    props: { doc: DOC, base: DOC, editable: true, matches: [], current: -1, isMasked: () => false, ...props },
  })
}
const items = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
const item = (path: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
const lastChange = (wrapper: ReturnType<typeof tree>['wrapper']) =>
  wrapper.emitted('change')!.at(-1)![0] as Record<string, unknown>

describe('the document tree', () => {
  it('is a tree, walked and opened by keyboard', async () => {
    tree()
    expect(document.querySelector('[role="tree"]')).not.toBeNull()
    expect(items().map((i) => i.dataset.path)).toEqual(['_id', 'guest', 'payments', 'status'])
    key(item('_id'), 'ArrowDown')
    key(item('guest'), 'ArrowDown')
    await flushPromises()
    expect(document.activeElement).toBe(item('payments'))
    key(item('payments'), 'ArrowRight')
    await flushPromises()
    expect(item('payments').getAttribute('aria-expanded')).toBe('true')
    expect(items().map((i) => i.dataset.path)).toContain('payments.0')
    key(item('payments'), 'ArrowRight')
    await flushPromises()
    expect(document.activeElement).toBe(item('payments.0'))
    key(item('payments.0'), 'ArrowLeft')
    await flushPromises()
    expect(document.activeElement).toBe(item('payments'))
  })

  it('changes a value where it stands, keeping its type', async () => {
    const { wrapper } = tree({ doc: DOC })
    ;(wrapper.vm as unknown as { reveal: (p: string[]) => void }).reveal(['payments', '0', 'amount'])
    await flushPromises()
    key(item('payments.0.amount'), 'Enter')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-tree-editor] input')!
    input.value = '999'
    input.dispatchEvent(new Event('input'))
    key(input, 'Enter')
    await flushPromises()
    const out = lastChange(wrapper)
    const amount = (out.payments as Array<Record<string, unknown>>)[0]!.amount
    expect(typeOf(amount)).toBe('int32')
    expect(Number(amount)).toBe(999)
  })

  it('says what does not fit the type, and changes nothing', async () => {
    const { wrapper } = tree()
    ;(wrapper.vm as unknown as { reveal: (p: string[]) => void }).reveal(['payments', '0', 'amount'])
    await flushPromises()
    key(item('payments.0.amount'), 'Enter')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-tree-editor] input')!
    input.value = '12a'
    input.dispatchEvent(new Event('input'))
    key(input, 'Enter')
    await flushPromises()
    expect(document.querySelector('[data-tree-editor] [role="alert"]')).not.toBeNull()
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('removes a field once confirmed', async () => {
    vi.spyOn(useDialogStore(), 'confirm').mockResolvedValue(true)
    const { wrapper } = tree()
    key(item('status'), 'Delete')
    await flushPromises()
    expect(Object.keys(lastChange(wrapper))).toEqual(['_id', 'guest', 'payments'])
  })

  it('refuses a name MongoDB refuses, and says why', async () => {
    const { wrapper } = tree()
    key(item('status'), 'F2')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-tree-editor] input')!
    input.value = '$x'
    input.dispatchEvent(new Event('input'))
    key(input, 'Enter')
    await flushPromises()
    expect(document.querySelector('[data-tree-editor] [role="alert"]')!.textContent).toMatch(/\$/)
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('never offers to change _id or a hidden value', async () => {
    const { wrapper } = tree({ isMasked: masked })
    key(item('_id'), 'Enter')
    ;(wrapper.vm as unknown as { reveal: (p: string[]) => void }).reveal(['payments', '0', 'card'])
    await flushPromises()
    key(item('payments.0.card'), 'Enter')
    key(item('payments.0.card'), 'Delete')
    await flushPromises()
    expect(document.querySelector('[data-tree-editor]')).toBeNull()
    expect(item('payments.0.card').querySelector('[data-masked]')).not.toBeNull()
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('dims what holds no match and opens the way to one far down an array', async () => {
    const long = decodeDocument({
      _id: { $numberInt: '1' },
      note: 'x',
      items: Array.from({ length: 300 }, (_, i) => ({ v: i === 230 ? 'needle' : 'hay' })),
    })
    const { matches } = searchDocument(long, 'needle', 'both', () => false)
    tree({ doc: long, base: long, matches, current: 0 })
    await flushPromises()
    expect(item('items.230.v')).not.toBeNull()
    expect(item('items.230.v').querySelector('mark[data-search-mark]')!.textContent).toBe('needle')
    expect(item('note').hasAttribute('data-dimmed')).toBe(true)
    expect(item('items').hasAttribute('data-dimmed')).toBe(false)
  })

  it('marks what the draft changed', async () => {
    const edited = { ...DOC, status: 'paid' }
    tree({ doc: edited, base: DOC })
    expect(item('status').hasAttribute('data-changed')).toBe(true)
    expect(item('guest').hasAttribute('data-changed')).toBe(false)
  })

  it('offers no edits when it may not write', async () => {
    const { wrapper } = tree({ editable: false })
    key(item('status'), 'Enter')
    key(item('status'), 'Delete')
    await flushPromises()
    expect(document.querySelector('[data-tree-editor]')).toBeNull()
    expect(document.querySelector('[data-tree-actions]')).toBeNull()
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('says which field is selected', async () => {
    const { wrapper } = tree()
    key(item('_id'), 'ArrowDown')
    await flushPromises()
    expect(wrapper.emitted('select')!.at(-1)).toEqual([['guest']])
  })

  // Final review I6: the tree is one stop for Tab; a line's menu opens with Shift+F10.
  it('is one stop for Tab, and opens a line’s menu with Shift+F10', async () => {
    tree()
    const stops = [...document.querySelectorAll<HTMLElement>('[role="tree"] [tabindex="0"]')]
    expect(stops).toEqual([item('_id')])
    key(item('status'), 'F10', { shiftKey: true })
    await flushPromises()
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())).toContain(
      'Rename',
    )
  })

  // Final review minor: when the line with the focus is closed away, the tree is still a Tab stop.
  it('stays reachable when its focused line is closed away', async () => {
    const { wrapper } = tree()
    ;(wrapper.vm as unknown as { reveal: (p: string[]) => void }).reveal(['payments', '0', 'amount'])
    await flushPromises()
    ;(wrapper.vm as unknown as { closeAll: () => void }).closeAll()
    await flushPromises()
    expect(document.querySelectorAll('[role="tree"] [tabindex="0"]')).toHaveLength(1)
  })

  // Final review minor: positions in the tree for a screen reader.
  it('says each line’s place among its siblings', () => {
    tree()
    expect(item('payments').getAttribute('aria-posinset')).toBe('3')
    expect(item('payments').getAttribute('aria-setsize')).toBe('4')
  })

  // Final review I3: an item holding a hidden value is not taken out; the tree says why.
  it('says why an item holding a hidden value is not taken out', async () => {
    vi.spyOn(useDialogStore(), 'confirm').mockResolvedValue(true)
    const rule = (path: readonly string[]) =>
      path.filter((p) => !/^\d+$/.test(p)).join('.') === 'payments.card'
    const { wrapper } = tree({ isMasked: rule })
    ;(wrapper.vm as unknown as { reveal: (p: string[]) => void }).reveal(['payments', '0'])
    await flushPromises()
    key(item('payments.0'), 'Delete')
    await flushPromises()
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(useToastStore().toasts.at(-1)?.message).toContain('hidden')
  })
})
