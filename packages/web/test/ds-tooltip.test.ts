import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import DsTooltip from '../src/ds/DsTooltip.vue'
import { mountApp } from './support/app'

/**
 * Review 2026-10-13 (minor 4): a click focused the control and its tooltip came up over it, staying
 * until the pointer left. Hovering and the keyboard's focus show it; the pointer's focus never does.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const Host = defineComponent(() => () => h(DsTooltip, { text: 'Assistant' }, () => h('button', 'A')))
const tip = () => document.querySelector('[role="tooltip"]')

describe('DsTooltip', () => {
  it('shows for the keyboard’s focus and a hover, never for a click’s focus', async () => {
    const { wrapper } = mountApp(Host)
    const anchor = wrapper.get('span')
    await anchor.trigger('pointerdown')
    await anchor.trigger('focusin')
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(tip()).toBeNull()
    await anchor.trigger('focusout')
    await anchor.trigger('focusin')
    vi.advanceTimersByTime(150)
    await flushPromises()
    expect(tip()!.textContent).toContain('Assistant')
    await anchor.trigger('focusout')
    expect(tip()).toBeNull()
    await anchor.trigger('mouseenter')
    vi.advanceTimersByTime(400)
    await flushPromises()
    expect(tip()).not.toBeNull()
  })
})
