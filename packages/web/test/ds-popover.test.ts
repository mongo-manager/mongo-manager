// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import DsPopover from '../src/ds/DsPopover.vue'
import { mountApp } from './support/app'

afterEach(() => {
  document.body.innerHTML = ''
})

/** A popover beside a box of its own that scrolls (as a terminal's viewport does). */
const Page = defineComponent(
  () => () =>
    h('div', { 'data-page': '' }, [
      h('div', { 'data-beside': '', style: 'overflow:auto;height:20px' }, [
        h('div', { style: 'height:200px' }),
      ]),
      h(
        DsPopover,
        { label: 'Theme' },
        {
          trigger: () => 'open',
          default: () => h('button', { type: 'button', 'data-inside': '' }, 'inside'),
        },
      ),
    ]),
)

describe('DsPopover', () => {
  // User report 2026-10-12: the terminal theme's popover closed as soon as it opened — the terminal
  // beside it scrolled its own viewport.
  it('stays open when something beside it scrolls, and closes when what holds its button scrolls', async () => {
    const { wrapper } = mountApp(Page)
    const trigger = () => wrapper.find('button[aria-label="Theme"]')
    await trigger().trigger('click')
    await flushPromises()
    expect(trigger().attributes('aria-expanded')).toBe('true')
    document.querySelector('[data-beside]')!.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(trigger().attributes('aria-expanded')).toBe('true')
    // Its button moved: the page, or a box holding it, scrolled.
    document.querySelector('[data-page]')!.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(trigger().attributes('aria-expanded')).toBe('false')
    await trigger().trigger('click')
    await flushPromises()
    document.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(trigger().attributes('aria-expanded')).toBe('false')
  })

  // E2e 2026-11-04: a button at the edge of a scrolled table — its focus nudged the table a few pixels
  // as the popover opened, and the popover closed at once. A nudge moves it along; a scroll closes it.
  it('follows a nudge of its button, and closes when its button is scrolled away', async () => {
    const { wrapper } = mountApp(Page)
    const button = wrapper.find('button[aria-label="Theme"]')
    let left = 100
    const rect = () =>
      ({ top: 50, left, right: left + 40, bottom: 66, width: 40, height: 16, x: left, y: 50 }) as DOMRect
    ;(button.element as HTMLElement).getBoundingClientRect = rect
    await button.trigger('click')
    await flushPromises()
    left = 98
    document.querySelector('[data-page]')!.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(button.attributes('aria-expanded')).toBe('true')
    left = 60
    document.querySelector('[data-page]')!.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(button.attributes('aria-expanded')).toBe('false')
  })

  // Review 2026-10-12 (I1): a radio group opens on its checked radio.
  it('puts the focus on the checked radio when it opens, else on the first control', async () => {
    const Radios = defineComponent(
      () => () =>
        h(
          DsPopover,
          { label: 'Pick' },
          {
            trigger: () => 'open',
            default: () =>
              h('div', { role: 'radiogroup' }, [
                h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-r': 'a' }, 'a'),
                h('button', { type: 'button', role: 'radio', 'aria-checked': 'true', 'data-r': 'b' }, 'b'),
              ]),
          },
        ),
    )
    const { wrapper } = mountApp(Radios)
    await wrapper.find('button[aria-label="Pick"]').trigger('click')
    await flushPromises()
    expect((document.activeElement as HTMLElement).dataset.r).toBe('b')
  })

  // User report 2026-11-07: a table cell's nested value, a branch opened inside it — the panel grew
  // where it stood and ran off the bottom of the window.
  it('is placed again, inside the window, when what it holds grows', async () => {
    const observed: Array<{ cb: () => void; el: Element | null }> = []
    const Original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      private entry: { cb: () => void; el: Element | null }
      constructor(cb: () => void) {
        this.entry = { cb, el: null }
        observed.push(this.entry)
      }
      observe(el: Element) {
        this.entry.el = el
      }
      unobserve() {}
      disconnect() {
        this.entry.el = null
      }
    } as unknown as typeof ResizeObserver
    try {
      const { wrapper } = mountApp(Page)
      const button = wrapper.find('button[aria-label="Theme"]')
      ;(button.element as HTMLElement).getBoundingClientRect = () =>
        ({ top: 600, left: 100, right: 140, bottom: 616, width: 40, height: 16, x: 100, y: 600 }) as DOMRect
      let height = 100
      const panelRect = () =>
        ({ top: 0, left: 0, right: 300, bottom: height, width: 300, height, x: 0, y: 0 }) as DOMRect
      await button.trigger('click')
      await flushPromises()
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!
      expect(panel.style.top).toBe('622px')
      panel.getBoundingClientRect = panelRect
      height = 500
      const watching = observed.find((o) => o.el === panel)
      expect(watching).toBeDefined()
      watching!.cb()
      await flushPromises()
      const top = parseFloat(panel.style.top)
      expect(top + height).toBeLessThanOrEqual(window.innerHeight)
      // Closed, it is watched no more.
      await button.trigger('click')
      await flushPromises()
      expect(observed.some((o) => o.el === panel)).toBe(false)
    } finally {
      globalThis.ResizeObserver = Original
    }
  })

  // Review 2026-10-12 (M11): a scroll the window itself reports closes it, never throws.
  it('closes on a scroll of the window', async () => {
    const { wrapper } = mountApp(Page)
    await wrapper.find('button[aria-label="Theme"]').trigger('click')
    await flushPromises()
    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(wrapper.find('button[aria-label="Theme"]').attributes('aria-expanded')).toBe('false')
  })

  // Review 2026-10-12 (M9): Tab past its last control left it open with the focus nowhere.
  it('closes when the focus leaves it for nowhere, never on a click inside it', async () => {
    const { wrapper } = mountApp(Page)
    const trigger = () => wrapper.find('button[aria-label="Theme"]')
    await trigger().trigger('click')
    await flushPromises()
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!
    // A click on the panel itself (no control): it stays.
    panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    ;(document.activeElement as HTMLElement).blur()
    panel.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null, bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
    expect(trigger().attributes('aria-expanded')).toBe('true')
    // Tab past its last control: the focus left for nowhere.
    const inside = document.querySelector<HTMLButtonElement>('[data-inside]')!
    inside.focus()
    inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    inside.blur()
    inside.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null, bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
    expect(trigger().attributes('aria-expanded')).toBe('false')
  })
})
