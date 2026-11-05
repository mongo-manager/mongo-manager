// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
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
  vi.restoreAllMocks()
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

/**
 * CI 2026-11-03 (e2e, the local time plugin): a date was hovered before the plugin answered, and
 * its tooltip never came, though the pointer stayed on it. A tip that comes while the pointer or
 * the keyboard's focus is on its host shows then; one that comes after they left does not.
 */
describe('DsTooltip whose text comes later', () => {
  const text = ref('')
  const later = defineComponent(
    () => () => h(DsTooltip, { text: text.value, disabled: !text.value }, () => h('button', 'A')),
  )
  beforeEach(() => {
    text.value = ''
  })

  it('shows for a pointer that came before its text, once the text comes', async () => {
    const { wrapper } = mountApp(later)
    await wrapper.get('span').trigger('mouseenter')
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(tip()).toBeNull()
    text.value = 'Local time: 12:00 (UTC+3)'
    await flushPromises()
    vi.advanceTimersByTime(400)
    await flushPromises()
    expect(tip()!.textContent).toContain('Local time')
  })

  it('shows for the keyboard’s focus that came before its text, once the text comes', async () => {
    const { wrapper } = mountApp(later)
    await wrapper.get('span').trigger('focusin')
    text.value = 'Local time: 12:00 (UTC+3)'
    await flushPromises()
    vi.advanceTimersByTime(150)
    await flushPromises()
    expect(tip()).not.toBeNull()
  })

  it('does not show once the pointer left before its text came', async () => {
    const { wrapper } = mountApp(later)
    const anchor = wrapper.get('span')
    await anchor.trigger('mouseenter')
    await anchor.trigger('mouseleave')
    text.value = 'Local time: 12:00 (UTC+3)'
    await flushPromises()
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(tip()).toBeNull()
  })

  it('shows when it is drawn under a pointer already there', async () => {
    text.value = 'Local time: 12:00 (UTC+3)'
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':hover' ? true : matches.call(this, selector)
    })
    mountApp(later)
    vi.advanceTimersByTime(400)
    await flushPromises()
    expect(tip()).not.toBeNull()
  })
})
