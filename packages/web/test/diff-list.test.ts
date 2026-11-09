// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import DiffList from '../src/documents/DiffList.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const TRACE = Array.from({ length: 40 }, (_, i) => `    at step${i} (app.js:${i}:1)`).join('\n')
const sides = () => {
  const [before, after] = [...document.querySelectorAll<HTMLElement>('[data-test="diff"] li .break-all')]
  return { before: before!, after: after! }
}

// Review 2026-11-07: both sides of a long value were cut after 200 characters, so a change further
// in (line 30 of a stack trace, or its line breaks gone) looked like no change at all.
describe('the list of changes before a save', () => {
  it('shows a long value around its first change, the changed part marked', () => {
    mountApp(DiffList, {
      props: { changes: [{ path: 'log', before: TRACE, after: TRACE.replace('step30', 'retry30') }] },
    })
    const { before, after } = sides()
    expect(before.querySelector('mark')!.textContent).toBe('step')
    expect(after.querySelector('mark')!.textContent).toBe('retry')
    expect(after.textContent).toContain('retry30 (app.js:30:1)')
    expect(after.textContent!.replace('After:', '').trim().startsWith('…')).toBe(true)
  })

  it('shows lost line breaks as a change', () => {
    mountApp(DiffList, {
      props: { changes: [{ path: 'log', before: TRACE, after: TRACE.replace(/\n/g, '') }] },
    })
    const { before, after } = sides()
    expect(before.querySelector('mark')!.textContent).toContain('\\n')
    expect(after.querySelector('mark')).not.toBeNull()
  })

  it('shows a short value whole, as before', () => {
    mountApp(DiffList, { props: { changes: [{ path: 'status', before: 'pending', after: 'paid' }] } })
    const { before, after } = sides()
    expect(before.textContent).toContain('"pending"')
    expect(after.textContent).toContain('"paid"')
    expect(after.querySelector('mark')).toBeNull()
  })
})
