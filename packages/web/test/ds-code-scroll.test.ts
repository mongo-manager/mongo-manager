// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
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

// User report 2026-11-05: "in the edit view, scrolling freezes" — a document with a signature as
// base64. The text field scrolled by itself and its colours (the text drawn under it) followed a
// scroll event later: when the page was busy, the colours stood still while the field moved. Both
// now sit in one scrolling box, which the browser moves as one.
const scroller = () => document.querySelector<HTMLElement>('[data-code-scroller]')!
const area = () => document.querySelector('textarea')!
const colours = () => document.querySelector<HTMLElement>('pre[aria-hidden="true"]')!

describe('the code editor scrolls as one', () => {
  it('holds the text field and its colours in one scrolling box', () => {
    mountApp(DsCodeEditor, { props: { modelValue: '{ a: 1 }', label: 'Document', multiline: true } })
    expect(area().parentElement).toBe(scroller())
    expect(colours().parentElement).toBe(scroller())
    expect(scroller().className).toMatch(/(?:^|\s)overflow-y-auto(?:\s|$)/)
    // Neither scrolls by itself, and nothing follows a scroll.
    expect(area().className).toMatch(/(?:^|\s)overflow-hidden(?:\s|$)/)
    expect(colours().className).not.toMatch(/overflow-(?:y-)?auto/)
    expect(colours().className).not.toMatch(/(?:^|\s)absolute(?:\s|$)/)
  })

  it('is as tall as its rows, and a multi-line one can be made taller', () => {
    mountApp(DsCodeEditor, { props: { modelValue: 'x', label: 'Pipeline', multiline: true, rows: 12 } })
    expect(scroller().style.height).toBe('calc(12 * 1.25rem + 1rem)')
    expect(scroller().className).toContain('resize-y')
    expect(area().className).not.toContain('resize-y')
  })

  it('grows a one-line field with its lines, up to six, and never makes it resizable', async () => {
    const { wrapper } = mountApp(DsCodeEditor, { props: { modelValue: 'a', label: 'Filter' } })
    expect(scroller().style.height).toBe('calc(1 * 1.25rem + 1rem)')
    await wrapper.setProps({ modelValue: 'a\nb\nc' })
    expect(scroller().style.height).toBe('calc(3 * 1.25rem + 1rem)')
    await wrapper.setProps({ modelValue: 'a\nb\nc\nd\ne\nf\ng\nh' })
    expect(scroller().style.height).toBe('calc(6 * 1.25rem + 1rem)')
    expect(scroller().className).not.toContain('resize-y')
  })

  it('fills the height it is given when asked to', () => {
    mountApp(DsCodeEditor, { props: { modelValue: 'abc', label: 'Document', multiline: true, fill: true } })
    expect(scroller().className).toMatch(/(?:^|\s)h-full(?:\s|$)/)
    expect(scroller().style.height).toBe('')
    expect(scroller().className).not.toContain('resize-y')
  })

  // The jump to a search's match went by lines: a value that wraps over a hundred rows (the
  // signature) put every match after it out of sight. It goes by where the match is drawn.
  it('scrolls a match into the middle of the field from where it is drawn, wrapped lines and all', async () => {
    const text = `{\n  sig: "${'A'.repeat(5_000)}",\n  card: "visa"\n}`
    const { wrapper } = mountApp(DsCodeEditor, {
      props: { modelValue: text, label: 'Document', multiline: true, fill: true },
    })
    await nextTick()
    const from = text.indexOf('visa')
    let measured = ''
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      measured = this.toString()
      return { top: 2_100, bottom: 2_120, left: 0, right: 8, width: 8, height: 20, x: 0, y: 2_100 } as DOMRect
    })
    vi.spyOn(scroller(), 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    Object.defineProperty(scroller(), 'clientHeight', { value: 400 })
    scroller().scrollTop = 0
    ;(wrapper.vm as unknown as { select: (from: number, to: number, focus?: boolean) => void }).select(
      from,
      from + 4,
      false,
    )
    expect(measured).toBe('v')
    // 2100 − 100 from the box's top, less half its height: the match in the middle.
    expect(scroller().scrollTop).toBe(1_800)
    expect([area().selectionStart, area().selectionEnd]).toEqual([from, from + 4])
  })

  // The field does not scroll, so the browser no longer keeps the caret in sight: Ctrl+End, an
  // arrow held down or typing on the last line left it below the box (e2e, Chromium).
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
  function measuredAt(top: number) {
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 20,
      height: 20,
    } as DOMRect)
    vi.spyOn(scroller(), 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    Object.defineProperty(scroller(), 'clientHeight', { value: 400 })
  }

  it('keeps the caret in sight when a key moves it below the box', async () => {
    const text = `{\n  sig: "${'A'.repeat(3_000)}"\n}`
    mountApp(DsCodeEditor, { props: { modelValue: text, label: 'Document', multiline: true, fill: true } })
    await nextTick()
    measuredAt(1_000)
    area().focus()
    area().setSelectionRange(0, 0)
    area().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true }))
    area().setSelectionRange(text.length, text.length)
    await frame()
    await frame()
    // The caret's line ends at 1020, the box at 500: down by 520 and the padding below the text.
    expect(scroller().scrollTop).toBe(528)
  })

  it('brings the caret back when a key moves it above the box', async () => {
    mountApp(DsCodeEditor, {
      props: { modelValue: 'a\nb\nc', label: 'Document', multiline: true, fill: true },
    })
    await nextTick()
    area().setSelectionRange(4, 4)
    scroller().scrollTop = 300
    measuredAt(40)
    area().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }))
    area().setSelectionRange(0, 0)
    await frame()
    await frame()
    expect(scroller().scrollTop).toBe(300 - 60 - 8)
  })

  it('leaves the box where the user scrolled it when a key moves nothing (a copy)', async () => {
    mountApp(DsCodeEditor, {
      props: { modelValue: 'a\nb\nc', label: 'Document', multiline: true, fill: true },
    })
    await nextTick()
    area().setSelectionRange(0, 1)
    scroller().scrollTop = 300
    measuredAt(-500)
    area().dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    await frame()
    await frame()
    expect(scroller().scrollTop).toBe(300)
  })

  it('keeps the caret in sight as the text is typed', async () => {
    const { wrapper } = mountApp(DsCodeEditor, {
      props: { modelValue: 'a', label: 'Document', multiline: true, fill: true },
    })
    await nextTick()
    measuredAt(700)
    area().value = 'ab'
    area().setSelectionRange(2, 2)
    area().dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.setProps({ modelValue: 'ab' })
    await frame()
    await frame()
    expect(scroller().scrollTop).toBe(700 + 20 - 500 + 8)
  })
})
