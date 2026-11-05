// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { Plus } from 'lucide-vue-next'
import DsButton from '../src/ds/DsButton.vue'
import DsIconButton from '../src/ds/DsIconButton.vue'
import DsEmptyState from '../src/ds/DsEmptyState.vue'
import DsCallout from '../src/ds/DsCallout.vue'
import DsStatusDot from '../src/ds/DsStatusDot.vue'
import { place } from '../src/ds/position'
import { mountApp } from './support/app'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('DsButton', () => {
  it('is busy and disabled while loading, and carries its variant', () => {
    const { wrapper } = mountApp(DsButton, {
      props: { variant: 'primary', loading: true },
      slots: { default: 'Save' },
    })
    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.classes()).toContain('bg-accent')
    expect(button.text()).toBe('Save')
  })
})

// Review of the connection form fix (2026-10-16): a button told `disabled: false` while it loads was
// clickable again (the attribute fell through over its own), and a double click saved twice.
describe('DsButton while it loads', () => {
  it('stays off whatever its disabled says', () => {
    const { wrapper } = mountApp(DsButton, {
      props: { loading: true, disabled: false },
      slots: { default: 'Save' },
    })
    expect(wrapper.get('button').element.disabled).toBe(true)
    document.body.innerHTML = ''
    const off = mountApp(DsButton, { props: { disabled: true }, slots: { default: 'Save' } })
    expect(off.wrapper.get('button').element.disabled).toBe(true)
    document.body.innerHTML = ''
    const on = mountApp(DsButton, { props: { disabled: false }, slots: { default: 'Save' } })
    expect(on.wrapper.get('button').element.disabled).toBe(false)
  })
})

describe('DsIconButton', () => {
  // Gap audit 2026-10-16 (R1 §6): a control with a shortcut says so to assistive technology.
  it('names its shortcut for assistive technology', () => {
    const { wrapper } = mountApp(DsIconButton, {
      props: { label: 'Collapse', icon: Plus, shortcut: ['Mod', 'B'] },
    })
    expect(wrapper.get('button').attributes('aria-keyshortcuts')).toBe('Control+B')
    document.body.innerHTML = ''
    const plain = mountApp(DsIconButton, { props: { label: 'Add', icon: Plus } })
    expect(plain.wrapper.get('button').attributes('aria-keyshortcuts')).toBeUndefined()
  })

  it('names itself and shows its tooltip with the shortcut on keyboard focus', async () => {
    vi.useFakeTimers()
    const { wrapper } = mountApp(DsIconButton, {
      props: { label: 'Add connection', icon: Plus, shortcut: ['Ctrl', 'N'] },
    })
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('Add connection')
    await button.trigger('focusin')
    await vi.advanceTimersByTimeAsync(200)
    const tip = document.querySelector('[role="tooltip"]')!
    expect(tip.textContent).toContain('Add connection')
    expect(tip.textContent).toContain('Ctrl')
    await button.trigger('keydown', { key: 'Escape' })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})

describe('DsEmptyState and DsCallout', () => {
  it('says what is empty and offers the action', () => {
    const { wrapper } = mountApp(DsEmptyState, {
      props: { title: 'No connections yet', description: 'Add one to start.' },
      slots: { actions: () => h('button', 'Add connection') },
    })
    expect(wrapper.text()).toContain('No connections yet')
    expect(wrapper.text()).toContain('Add one to start.')
    expect(wrapper.find('button').text()).toBe('Add connection')
  })
  it('alerts for danger only', () => {
    expect(
      mountApp(DsCallout, { props: { tone: 'danger' }, slots: { default: 'Broken' } })
        .wrapper.get('[role="alert"]')
        .text(),
    ).toContain('Broken')
    expect(
      mountApp(DsCallout, { props: { tone: 'info' }, slots: { default: 'Note' } })
        .wrapper.find('[role="alert"]')
        .exists(),
    ).toBe(false)
  })
})

describe('DsStatusDot', () => {
  it('says its state in words', () => {
    expect(
      mountApp(DsStatusDot, { props: { state: 'error', label: 'Cannot connect' } }).wrapper.text(),
    ).toContain('Cannot connect')
  })
})

describe('place', () => {
  it('opens below, flips above near the bottom and stays inside the window', () => {
    const anchor = { top: 100, bottom: 120, left: 10, right: 60, width: 50, height: 20 } as DOMRect
    expect(place(anchor, { width: 200, height: 100 })).toEqual({ top: 126, left: 10 })
    const low = { ...anchor, top: window.innerHeight - 30, bottom: window.innerHeight - 10 } as DOMRect
    expect(place(low, { width: 200, height: 100 }).top).toBe(window.innerHeight - 30 - 100 - 6)
    const right = { ...anchor, left: window.innerWidth - 20, right: window.innerWidth } as DOMRect
    expect(place(right, { width: 200, height: 100 }).left).toBe(window.innerWidth - 200 - 8)
  })
})
