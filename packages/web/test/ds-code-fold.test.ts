// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeView from '../src/ds/DsCodeView.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * User report 2026-11-05: an image as base64 filled the JSON views with thousands of lines, and
 * scrolling dragged. A long string shows its start and a button that shows it all.
 */
const photo = `"data:image/png;base64,${'iVBORw0KGgo'.repeat(5000)}"`
const text = `{\n  "name": "Guest 1",\n  "photo": ${photo},\n  "note": "quiet"\n}`
const pre = () => document.querySelector('pre')!
const more = () => document.querySelector<HTMLButtonElement>('pre button[data-show-long]')

describe('a long string in a code view', () => {
  it('shows its start and its size, the rest on request', async () => {
    mountApp(DsCodeView, { props: { text } })
    expect(pre().textContent!.length).toBeLessThan(600)
    expect(pre().textContent).toContain('"data:image/png;base64,iVBORw0KGgo')
    expect(pre().textContent).toContain('"note": "quiet"')
    expect(more()!.textContent!.trim()).toBe('Show all (54 KB)')
    more()!.click()
    await nextTick()
    expect(pre().textContent).toBe(text)
    expect(more()).toBeNull()
  })

  it('shows a string with a search match whole, and marks what comes after it', () => {
    const at = text.indexOf('iVBORw0KGgo', 2000)
    mountApp(DsCodeView, { props: { text, marks: [[at, at + 5]], currentMark: 0 } })
    expect(more()).toBeNull()
    expect(document.querySelector('mark')!.textContent).toBe('iVBOR')
    document.body.innerHTML = ''
    const quiet = text.indexOf('quiet')
    mountApp(DsCodeView, { props: { text, marks: [[quiet, quiet + 5]], currentMark: 0 } })
    expect(more()).not.toBeNull()
    expect(document.querySelector('mark')!.textContent).toBe('quiet')
  })

  it('folds them in a text too long to highlight too', () => {
    const big = `"${'QUJD'.repeat(100_000)}"`
    const many = `{
  "a": ${big},
  "b": ${big},
  "c": ${big}
}`
    expect(many.length).toBeGreaterThan(1_000_000)
    mountApp(DsCodeView, { props: { text: many } })
    expect(document.querySelectorAll('pre button[data-show-long]')).toHaveLength(3)
    expect(pre().textContent!.length).toBeLessThan(1000)
  })

  it('leaves a string under the limit as it is', () => {
    const short = `{ a: "${'x'.repeat(1500)}" }`
    mountApp(DsCodeView, { props: { text: short } })
    expect(more()).toBeNull()
    expect(pre().textContent).toBe(short)
  })
})
