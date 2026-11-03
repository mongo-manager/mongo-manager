import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { h, ref } from 'vue'
import DsTabs from '../src/ds/DsTabs.vue'
import { mountApp } from './support/app'

/**
 * Review of the connection tabs (2026-10-23): at a phone's width the connection's sections ran off
 * the bar, and nothing said more were there (the bar's scrollbar is hidden). The bar now fades on the
 * side with more, shows an arrow there, and keeps the chosen tab in full view.
 */
const NAMES = ['overview', 'performance', 'watch', 'access', 'alerts', 'backups', 'personal']

/** happy-dom lays nothing out: each tab is 100 px wide, the bar `width` px. */
let width = 300
const offsets = new WeakMap<Element, number>()
const moves: Array<{ left: number; behavior?: ScrollBehavior }> = []
const isBar = (el: Element) => el.getAttribute('role') === 'tablist'
const tabsOf = (el: Element) => el.querySelectorAll('[role="tab"]').length
const PATCHES: Record<string, PropertyDescriptor> = {
  clientWidth: {
    get(this: HTMLElement) {
      return isBar(this) ? width : 0
    },
  },
  scrollWidth: {
    get(this: HTMLElement) {
      return isBar(this) ? tabsOf(this) * 100 : 0
    },
  },
  scrollLeft: {
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0
    },
    set(this: HTMLElement, v: number) {
      offsets.set(this, v)
    },
  },
  offsetLeft: {
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'tab' ? [...this.parentElement!.children].indexOf(this) * 100 : 0
    },
  },
  offsetWidth: {
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'tab' ? 100 : 0
    },
  },
  scrollTo: {
    value(this: HTMLElement, o: ScrollToOptions) {
      const left = Math.max(0, Math.min(o.left ?? 0, tabsOf(this) * 100 - width))
      offsets.set(this, left)
      moves.push({ left, behavior: o.behavior })
      this.dispatchEvent(new Event('scroll'))
    },
  },
  scrollBy: {
    value(this: HTMLElement, o: ScrollToOptions) {
      this.scrollTo({ left: (offsets.get(this) ?? 0) + (o.left ?? 0), behavior: o.behavior })
    },
  },
}
const saved = new Map<string, PropertyDescriptor | undefined>()
beforeEach(() => {
  width = 300
  moves.length = 0
  for (const [name, d] of Object.entries(PATCHES)) {
    saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
    Object.defineProperty(HTMLElement.prototype, name, { ...d, configurable: true })
  }
})
afterEach(() => {
  document.body.innerHTML = ''
  for (const [name, d] of saved) {
    if (d) Object.defineProperty(HTMLElement.prototype, name, d)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

async function mount(start = 'overview') {
  const model = ref(start)
  const tabs = ref(NAMES.map((value) => ({ value, label: value })))
  mountApp({
    setup: () => () =>
      h(DsTabs, {
        label: 'Sections',
        tabs: tabs.value,
        modelValue: model.value,
        'onUpdate:modelValue': (v: string) => (model.value = v),
      }),
  })
  await flushPromises()
  return { model, tabs }
}
const bar = () => document.querySelector<HTMLElement>('[role="tablist"]')!
const tab = (name: string) => document.getElementById(`tab-${name}`)!
const at = async (left: number) => {
  bar().scrollLeft = left
  bar().dispatchEvent(new Event('scroll'))
  await flushPromises()
}
const back = () => document.querySelector<HTMLElement>('[data-tabs-more="back"]')
const forward = () => document.querySelector<HTMLElement>('[data-tabs-more="forward"]')

describe('DsTabs that do not fit', () => {
  it('shows an arrow and a fade on the side with more, and none when all fit', async () => {
    await mount()
    // The chosen tab is in view already: the bar is not scrolled for nothing.
    expect(moves).toEqual([])
    expect(back()).toBeNull()
    expect(forward()).not.toBeNull()
    expect(bar().style.maskImage).toContain('transparent')
    await at(200)
    expect(back()).not.toBeNull()
    expect(forward()).not.toBeNull()
    await at(400)
    expect(back()).not.toBeNull()
    expect(forward()).toBeNull()
  })

  it('shows nothing of a tab under an arrow: the fade starts past the arrow (2026-10-26)', async () => {
    await mount()
    await at(200)
    // The arrow is 28 px wide (w-7): half a tab's name drawn under it read as one word with it.
    expect(bar().style.maskImage).toContain('transparent 0, transparent 28px, #000 40px')
    expect(bar().style.maskImage).toContain('transparent calc(100% - 28px), transparent 100%')
  })

  it('shows neither when all fit', async () => {
    width = 700
    await mount()
    // Nothing to bring into view: the bar is not scrolled for nothing.
    expect(moves).toEqual([])
    expect(back()).toBeNull()
    expect(forward()).toBeNull()
    expect(bar().style.maskImage).toBe('')
  })

  it('has named arrows, outside the tablist, kept out of the Tab order and the focus', async () => {
    await mount()
    await at(200)
    for (const [arrow, name] of [
      [back()!, 'Show earlier tabs'],
      [forward()!, 'Show more tabs'],
    ] as const) {
      expect(arrow.getAttribute('aria-label')).toBe(name)
      expect(arrow.getAttribute('tabindex')).toBe('-1')
      // A helper for the eye: screen readers move along the tabs themselves.
      expect(arrow.getAttribute('aria-hidden')).toBe('true')
      expect(arrow.closest('[role="tablist"]')).toBeNull()
      // A click on one does not take the focus (it would fall to the page once that arrow goes).
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      arrow.dispatchEvent(press)
      expect(press.defaultPrevented).toBe(true)
    }
  })

  it('moves on by most of the bar when an arrow is clicked', async () => {
    await mount()
    forward()!.click()
    await flushPromises()
    expect(moves.at(-1)!.left).toBe(225)
    back()!.click()
    await flushPromises()
    expect(moves.at(-1)!.left).toBe(0)
  })

  it('brings the chosen tab into full view, clear of the fade', async () => {
    const { model } = await mount()
    // Alerts ends at 500: the bar shows it with the fade's 40 px after it.
    model.value = 'alerts'
    await flushPromises()
    expect(moves.at(-1)!.left).toBe(240)
    model.value = 'personal'
    await flushPromises()
    expect(moves.at(-1)!.left).toBe(400)
    model.value = 'overview'
    await flushPromises()
    expect(moves.at(-1)!.left).toBe(0)
  })

  it('opens on a chosen tab far along with it in view, at once', async () => {
    await mount('alerts')
    expect(moves.at(-1)).toEqual({ left: 240, behavior: 'auto' })
    expect(back()).not.toBeNull()
  })

  it('keeps the chosen tab in view when tabs are added before it, and measures again', async () => {
    width = 700
    const { tabs } = await mount('alerts')
    expect(forward()).toBeNull()
    width = 300
    tabs.value = [{ value: 'first', label: 'First' }, ...tabs.value]
    await flushPromises()
    // Alerts now ends at 600.
    expect(moves.at(-1)!.left).toBe(340)
    expect(back()).not.toBeNull()
    expect(forward()).not.toBeNull()
  })

  it('brings a tab the Tab key reaches out from under the fade', async () => {
    await mount()
    await at(400)
    moves.length = 0
    tab('overview').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await flushPromises()
    expect(moves.at(-1)!.left).toBe(0)
  })

  it('does not scroll a tab a mouse press focuses: the click chooses it, then it comes into view', async () => {
    const { model } = await mount()
    moves.length = 0
    tab('personal').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    tab('personal').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await flushPromises()
    expect(moves).toEqual([])
    tab('personal').click()
    await flushPromises()
    expect(model.value).toBe('personal')
    expect(moves.at(-1)!.left).toBe(400)
  })

  it('brings a tab the keyboard reaches into view again once a press ended, even outside the bar', async () => {
    await mount()
    tab('watch').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    // The button comes up elsewhere on the page.
    document.body.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await at(400)
    moves.length = 0
    tab('overview').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await flushPromises()
    expect(moves.at(-1)?.left).toBe(0)
  })

  it('leaves the bar where the user scrolled it when only a count changes', async () => {
    const { tabs } = await mount()
    await at(300)
    moves.length = 0
    tabs.value = tabs.value.map((t) => (t.value === 'alerts' ? { ...t, count: 3 } : t))
    await flushPromises()
    expect(moves).toEqual([])
  })

  it('keeps the arrow keys on the tabs, and the chosen one in view', async () => {
    const { model } = await mount('alerts')
    tab('alerts').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    expect(model.value).toBe('personal')
    expect(document.activeElement).toBe(tab('personal'))
    expect(moves.at(-1)!.left).toBe(400)
  })
})
