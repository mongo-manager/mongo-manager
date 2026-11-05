// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { Sun } from 'lucide-vue-next'
import DsSegmented from '../src/ds/DsSegmented.vue'
import DsSwatch from '../src/ds/DsSwatch.vue'
import DsCard from '../src/ds/DsCard.vue'
import DsChip from '../src/ds/DsChip.vue'
import ProductMark from '../src/workspace/ProductMark.vue'
import { mountApp } from './support/app'

afterEach(() => {
  document.body.innerHTML = ''
})
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

describe('DsSegmented (spec rev. 2 §2)', () => {
  it('is a radio group: one option checked, arrows move and choose, Tab enters on the checked one', async () => {
    const value = ref('light')
    const Host = {
      setup: () => () =>
        h(DsSegmented, {
          label: 'Theme',
          options: [
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark' },
          ],
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
    }
    const { wrapper } = mountApp(Host)
    const group = wrapper.get('[role="radiogroup"]')
    expect(group.attributes('aria-label')).toBe('Theme')
    const radios = () => wrapper.findAll('[role="radio"]')
    expect(radios().map((r) => r.attributes('aria-checked'))).toEqual(['true', 'false'])
    expect(radios().map((r) => r.attributes('tabindex'))).toEqual(['0', '-1'])
    key(radios()[0]!.element, 'ArrowRight')
    await nextTick()
    expect(value.value).toBe('dark')
    expect(document.activeElement).toBe(radios()[1]!.element)
    key(radios()[1]!.element, 'ArrowRight')
    await nextTick()
    expect(value.value).toBe('light')
  })

  // 2026-10-27: a metric chart's ranges another chart shows already.
  it('never chooses a disabled option: the arrows step over it, a click does nothing', async () => {
    const value = ref('a')
    const Host = {
      setup: () => () =>
        h(DsSegmented, {
          label: 'Range',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', disabled: true },
            { value: 'c', label: 'C' },
          ],
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
    }
    const { wrapper } = mountApp(Host)
    const radios = () => wrapper.findAll('[role="radio"]')
    expect(radios()[1]!.attributes('disabled')).toBeDefined()
    key(radios()[0]!.element, 'ArrowRight')
    await nextTick()
    expect(value.value).toBe('c')
    key(radios()[2]!.element, 'ArrowLeft')
    await nextTick()
    expect(value.value).toBe('a')
    key(radios()[0]!.element, 'ArrowLeft')
    await nextTick()
    expect(value.value).toBe('c')
    ;(radios()[1]!.element as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(value.value).toBe('c')
  })
})

describe('DsSwatch', () => {
  it('names every accent, shows each in its own color and checks the chosen one', async () => {
    const value = ref('emerald')
    const Host = {
      setup: () => () =>
        h(DsSwatch, {
          label: 'Accent color',
          options: [
            { value: 'emerald', label: 'Emerald' },
            { value: 'indigo', label: 'Indigo' },
          ],
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
    }
    const { wrapper } = mountApp(Host)
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((r) => r.attributes('aria-label'))).toEqual(['Emerald', 'Indigo'])
    expect(radios.map((r) => r.attributes('data-accent'))).toEqual(['emerald', 'indigo'])
    await radios[1]!.trigger('click')
    expect(value.value).toBe('indigo')
  })
})

describe('DsCard', () => {
  it('is a region named by its title, collapses and can be hidden from its menu', async () => {
    const collapsed = ref(false)
    let hidden = 0
    const Host = {
      setup: () => () =>
        h(
          DsCard,
          {
            title: 'Activity',
            count: 3,
            collapsed: collapsed.value,
            collapseLabel: 'Collapse',
            expandLabel: 'Expand',
            hideLabel: 'Hide',
            menuLabel: 'Activity options',
            'onUpdate:collapsed': (v: boolean) => (collapsed.value = v),
            onHide: () => hidden++,
          },
          { default: () => h('p', 'jobs') },
        ),
    }
    const { wrapper } = mountApp(Host)
    const region = wrapper.get('section')
    expect(document.getElementById(region.attributes('aria-labelledby')!)!.textContent).toContain('Activity')
    expect(region.text()).toContain('3')
    expect(region.text()).toContain('jobs')
    ;(wrapper.get('button[aria-label="Activity options"]').element as HTMLButtonElement).click()
    await nextTick()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Collapse'))!
      .click()
    await nextTick()
    expect(collapsed.value).toBe(true)
    expect(wrapper.text()).not.toContain('jobs')
    ;(wrapper.get('button[aria-label="Activity options"]').element as HTMLButtonElement).click()
    await nextTick()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Hide'))!
      .click()
    expect(hidden).toBe(1)
  })
})

// Review of K+R2 (I3): a card that cannot fold has a plain heading — no button that does nothing,
// and its title is a heading screen readers can jump to.
describe('DsCard that does not fold', () => {
  it('names its region with a heading and no collapse button', () => {
    const { wrapper } = mountApp({
      setup: () => () => h(DsCard, { title: 'Indexes', count: 4 }, { default: () => h('p', 'rows') }),
    })
    const heading = wrapper.get('h3')
    expect(heading.text()).toBe('Indexes')
    expect(heading.element.closest('button')).toBeNull()
    expect(wrapper.find('[aria-expanded]').exists()).toBe(false)
    expect(wrapper.text()).toContain('4')
  })

  it('folds from its title when it can', async () => {
    const collapsed = ref(false)
    const { wrapper } = mountApp({
      setup: () => () =>
        h(
          DsCard,
          {
            title: 'Activity',
            collapsed: collapsed.value,
            collapseLabel: 'Collapse',
            expandLabel: 'Expand',
            'onUpdate:collapsed': (v: boolean) => (collapsed.value = v),
          },
          { default: () => h('p', 'jobs') },
        ),
    })
    ;(wrapper.get('button[aria-expanded]').element as HTMLButtonElement).click()
    await nextTick()
    expect(collapsed.value).toBe(true)
  })
})

describe('DsChip', () => {
  it('removes with its button and with Delete or Backspace', async () => {
    const { wrapper } = mountApp(DsChip, {
      props: { label: 'status = "A"', removable: true, removeLabel: 'Remove status = "A"' },
    })
    await wrapper.get('button[aria-label^="Remove"]').trigger('click')
    await wrapper.get('[data-chip]').trigger('keydown', { key: 'Delete' })
    await wrapper.get('[data-chip]').trigger('keydown', { key: 'Backspace' })
    expect(wrapper.emitted('remove')).toHaveLength(3)
  })

  // W1 review (minor 10): a removable chip is named, says its keys and how to remove it.
  it('is a named group that says its Delete key and how to use it', () => {
    const { wrapper } = mountApp(DsChip, {
      props: { label: 'qty < 30', removable: true, hint: 'Press Delete to remove this condition.' },
    })
    const chip = wrapper.get('[data-chip]')
    expect(chip.attributes('role')).toBe('group')
    expect(chip.attributes('aria-label')).toBe('qty < 30')
    expect(chip.attributes('aria-keyshortcuts')).toBe('Delete Backspace')
    expect(document.getElementById(chip.attributes('aria-describedby')!)?.textContent).toBe(
      'Press Delete to remove this condition.',
    )
  })
})

describe('ProductMark', () => {
  it('is decorative unless named, and draws in the accent', () => {
    const plain = mountApp(ProductMark).wrapper.get('svg')
    expect(plain.attributes('aria-hidden')).toBe('true')
    expect(plain.find('rect').classes()).toContain('fill-accent')
    const named = mountApp(ProductMark, { props: { label: 'Mongo Manager' } }).wrapper.get('svg')
    expect(named.attributes('role')).toBe('img')
    expect(named.attributes('aria-label')).toBe('Mongo Manager')
  })
})
