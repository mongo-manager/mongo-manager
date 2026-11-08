// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import type { FieldChange } from '@mongo-manager/shared/browser'
import ReviewDiff from '../src/documents/page/ReviewDiff.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  try {
    localStorage.clear()
  } catch {
    // no storage in this run
  }
})
afterEach(() => {
  document.body.innerHTML = ''
})

const items = (changedAt: number, price: number) =>
  Array.from({ length: 40 }, (_, i) => ({ line: i + 1, price: i === changedAt ? price : 10 + i }))

function mount(changes: FieldChange[]) {
  mountApp(defineComponent(() => () => h(ReviewDiff, { changes })))
  return document.querySelector<HTMLElement>('[data-review-diff]')!
}
const rows = (kind: string) => [...document.querySelectorAll(`tr[data-row="${kind}"]`)]
const click = async (el: Element | null | undefined) => {
  ;(el as HTMLElement).click()
  await nextTick()
  await nextTick()
}
const press = async (key: string) => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await nextTick()
  await nextTick()
}

describe('the review as a side-by-side diff (user request 2026-11-07)', () => {
  it('shows the line that changed beside its old text, the changed part marked, the rest folded', async () => {
    const root = mount([{ path: 'items', before: items(30, 142), after: items(30, 143) }])
    await nextTick()
    const field = root.querySelector('[data-review-field]')!
    expect(field.getAttribute('data-kind')).toBe('changed')
    expect(field.querySelector('h3')!.textContent).toMatch(/items.*Changed.*\+1.*−1/s)
    expect(rows('mod')).toHaveLength(1)
    const cells = [...rows('mod')[0]!.querySelectorAll('td')]
    expect(cells).toHaveLength(4)
    expect(cells[1]!.textContent).toContain('price: 142')
    expect(cells[3]!.textContent).toContain('price: 143')
    expect(cells[1]!.querySelector('mark')!.textContent).toBe('2')
    expect(cells[3]!.querySelector('mark')!.textContent).toBe('3')
    expect(cells[0]!.textContent).toBe(cells[2]!.textContent)
    expect(root.querySelectorAll('tr[data-fold]')).toHaveLength(2)
  })

  it('says in words which values changed in a nested field, and not for a plain value', async () => {
    const root = mount([
      { path: 'items', before: items(30, 142), after: items(30, 143) },
      { path: 'status', before: 'paid', after: 'refunded' },
    ])
    await nextTick()
    const [nestedField, plain] = root.querySelectorAll('[data-review-field]')
    const summary = nestedField!.querySelector('[data-review-summary]')!
    expect(summary.getAttribute('aria-label')).toBe('Values changed')
    expect(summary.querySelector('li')!.textContent).toMatch(/items\.30\.price.*142.*143/s)
    expect(summary.querySelector('del')!.textContent).toBe('142')
    expect(summary.querySelector('ins')!.textContent).toBe('143')
    expect(plain!.querySelector('[data-review-summary]')).toBeNull()
  })

  it('takes the focus when it opens, so its keys work at once', async () => {
    const root = mount([{ path: 'status', before: 'paid', after: 'refunded' }])
    await nextTick()
    expect(document.activeElement).toBe(root.querySelector('[role="region"]'))
  })

  it('names its tables for a screen reader and shows no column headings (user report 2026-11-07)', async () => {
    const root = mount([{ path: 'status', before: 'paid', after: 'refunded' }])
    await nextTick()
    expect(root.querySelector('thead')).toBeNull()
    expect(root.querySelector('table')!.getAttribute('aria-label')).toBe('status, before and after')
  })
})

describe('folded lines (user report 2026-11-07: opened, they could not be folded again)', () => {
  it('open all and fold again', async () => {
    const root = mount([{ path: 'items', before: items(30, 142), after: items(30, 143) }])
    await nextTick()
    const sameBefore = rows('same').length
    await click(root.querySelector('tr[data-fold] [data-open-all]'))
    expect(rows('same').length).toBeGreaterThan(sameBefore)
    const hide = root.querySelector('tr[data-hide-row] [data-hide]')
    expect(hide!.textContent).toMatch(/Hide \d+ unchanged lines/)
    await click(hide)
    expect(rows('same')).toHaveLength(sameBefore)
    expect(root.querySelectorAll('tr[data-fold]')).toHaveLength(2)
  })

  it('open 20 lines at a time above the change, the fold staying with a Hide', async () => {
    const root = mount([{ path: 'items', before: items(30, 142), after: items(30, 143) }])
    await nextTick()
    const first = root.querySelector('tr[data-fold]')!
    // The fold before the first change opens upward only: nothing is above it.
    expect(first.querySelector('[data-open-below]')).toBeNull()
    const sameBefore = rows('same').length
    await click(first.querySelector('[data-open-above]'))
    expect(rows('same')).toHaveLength(sameBefore + 20)
    const fold = root.querySelector('tr[data-fold]')!
    expect(fold.textContent).toMatch(/\d+ unchanged lines/)
    await click(fold.querySelector('[data-hide]'))
    expect(rows('same')).toHaveLength(sameBefore)
    expect(root.querySelector('tr[data-fold] [data-hide]')).toBeNull()
  })

  it('opens every fold from the bar, and folds them all again', async () => {
    const root = mount([{ path: 'items', before: items(30, 142), after: items(30, 143) }])
    await nextTick()
    const all = root.querySelector('[data-review-all]')!
    expect(all.textContent).toContain('Show all lines')
    await click(all)
    expect(root.querySelectorAll('tr[data-fold]')).toHaveLength(0)
    expect(all.textContent).toContain('Show changes only')
    await click(all)
    expect(root.querySelectorAll('tr[data-fold]')).toHaveLength(2)
  })
})

describe('moving from change to change (user report 2026-11-07: the change was lost)', () => {
  const two: FieldChange[] = [
    { path: 'items', before: items(5, 1), after: items(5, 2) },
    { path: 'status', before: 'paid', after: 'refunded' },
  ]

  it('goes to the next and the previous change with the bar and with N and P', async () => {
    const root = mount(two)
    await nextTick()
    const position = () => root.querySelector('[data-review-position]')!.textContent!.trim()
    expect(position()).toBe('Change 1 of 2')
    await click(root.querySelector('[data-review-next] button, button[data-review-next]'))
    expect(position()).toBe('Change 1 of 2')
    expect(root.querySelector('[data-review-field="0"] tr[data-current]')).not.toBeNull()
    await press('n')
    expect(position()).toBe('Change 2 of 2')
    expect(root.querySelector('[data-review-field="1"] tr[data-current]')).not.toBeNull()
    await press('p')
    expect(position()).toBe('Change 1 of 2')
  })

  it('opens a field closed by its header to show its change', async () => {
    const root = mount(two)
    await nextTick()
    await click(root.querySelector('[data-review-field="1"] h3 button'))
    expect(root.querySelector('[data-review-field="1"] table')).toBeNull()
    await press('n')
    await press('n')
    expect(root.querySelector('[data-review-field="1"] table')).not.toBeNull()
  })
})

describe('the rest of the review', () => {
  it('shows a field added with nothing on the old side, and one removed with nothing on the new', async () => {
    const root = mount([
      { path: 'note', after: 'hello' },
      { path: 'old', before: 1 },
    ])
    await nextTick()
    const [added, removed] = root.querySelectorAll('[data-review-field]')
    expect(added!.getAttribute('data-kind')).toBe('added')
    expect(removed!.getAttribute('data-kind')).toBe('removed')
    expect(added!.querySelector('tr[data-row="add"] td:last-child')!.textContent).toContain('"hello"')
    expect(removed!.querySelector('tr[data-row="del"] td:nth-child(2)')!.textContent).toContain('1')
    expect(root.querySelector('[data-review-totals]')!.textContent).toMatch(/\+1.*−1/s)
  })

  it('stacks the sides in one column on request, and keeps the choice', async () => {
    const root = mount([{ path: 'status', before: 'paid', after: 'refunded' }])
    await nextTick()
    const unified = [...root.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) =>
      /Unified/.test(b.textContent ?? ''),
    )!
    await click(unified)
    expect(root.querySelector('table')!.getAttribute('data-layout')).toBe('unified')
    expect(rows('del')[0]!.textContent).toContain('"paid"')
    expect(rows('add')[0]!.textContent).toContain('"refunded"')
    expect(localStorage.getItem('mm.reviewDiffLayout')).toBe('unified')
  })

  it('closes and opens a field from its header', async () => {
    const root = mount([{ path: 'status', before: 'paid', after: 'refunded' }])
    await nextTick()
    const header = root.querySelector<HTMLButtonElement>('h3 button')!
    expect(header.getAttribute('aria-expanded')).toBe('true')
    await click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelector('table')).toBeNull()
  })

  it('shows a value of very many lines a part at a time', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => i)
    const root = mount([{ path: 'numbers', after: big }])
    await nextTick()
    expect(rows('add')).toHaveLength(3000)
    const more = root.querySelector<HTMLButtonElement>('[data-more-rows]')!
    expect(more.textContent).toContain('1002')
    await click(more)
    expect(rows('add')).toHaveLength(4002)
    expect(root.querySelector('[data-more-rows]')).toBeNull()
  })
})
