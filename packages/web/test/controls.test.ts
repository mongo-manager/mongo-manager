// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsSelect from '../src/ds/DsSelect.vue'
import DsInput from '../src/ds/DsInput.vue'
import DsCheckbox from '../src/ds/DsCheckbox.vue'
import DsTextarea from '../src/ds/DsTextarea.vue'
import DsMenu from '../src/ds/DsMenu.vue'
import { mountApp } from './support/app'
import { byLabel, check, choose, typeInto } from './support/dom'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
})

describe('form controls', () => {
  it('bind select, checkbox and textarea values through labelled controls', async () => {
    const kind = ref<'a' | 'b'>('a')
    const on = ref(false)
    const text = ref('')
    const Host = defineComponent(() => () => [
      // Generic SFCs do not fit h()'s overloads; the runtime props are what matter here.
      h(DsSelect as unknown as Component, {
        label: 'Kind',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        modelValue: kind.value,
        'onUpdate:modelValue': (v: 'a' | 'b') => (kind.value = v),
      }),
      h(DsCheckbox, {
        label: 'Enabled',
        hint: 'Turns it on',
        modelValue: on.value,
        'onUpdate:modelValue': (v: boolean) => (on.value = v),
      }),
      h(DsTextarea, {
        label: 'Body',
        mono: true,
        error: 'Bad',
        modelValue: text.value,
        'onUpdate:modelValue': (v: string) => (text.value = v),
      }),
    ])
    mountApp(Host)
    await choose(byLabel<HTMLSelectElement>('Kind'), 'b')
    await check(byLabel('Enabled'))
    await typeInto(byLabel<HTMLTextAreaElement>('Body'), '[1]')
    expect([kind.value, on.value, text.value]).toEqual(['b', true, '[1]'])
    expect(byLabel('Enabled').getAttribute('aria-describedby')).toBeTruthy()
    expect(byLabel<HTMLTextAreaElement>('Body').getAttribute('aria-invalid')).toBe('true')
  })

  // Review of K+R2 (I2): a field's class lays out the field (UiTextField put it on its root); the
  // input's own attributes go to the input.
  it('puts a field’s class on the field and its input attributes on the input', () => {
    mountApp(
      defineComponent(
        () => () =>
          h(DsInput, { label: 'Host', class: 'w-28', style: 'order: 2', maxlength: 5, modelValue: '' }),
      ),
    )
    const input = byLabel<HTMLInputElement>('Host')
    expect(input.classList.contains('w-28')).toBe(false)
    expect(input.getAttribute('maxlength')).toBe('5')
    const root = input.closest('.w-28') as HTMLElement
    expect(root).not.toBeNull()
    expect(root.contains(document.querySelector('label'))).toBe(true)
    expect(root.style.order).toBe('2')
  })

  // UI redesign part K: DsInput and DsSelect took over UiTextField's and UiSelect's jobs.
  it('select a masked secret on focus, and name a select’s error', async () => {
    const secret = ref('••••••')
    const Host = defineComponent(() => () => [
      h(DsInput, {
        label: 'Password',
        selectOnFocus: true,
        modelValue: secret.value,
        'onUpdate:modelValue': (v: string) => (secret.value = v),
      }),
      h(DsSelect as unknown as Component, {
        label: 'Mode',
        options: [{ value: 'a', label: 'A' }],
        error: 'Pick one',
        modelValue: 'a',
      }),
    ])
    mountApp(Host)
    const input = byLabel<HTMLInputElement>('Password')
    input.dispatchEvent(new FocusEvent('focus'))
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
    const select = byLabel<HTMLSelectElement>('Mode')
    expect(select.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toBe('Pick one')
  })
})

describe('modal focus', () => {
  it('starts on the first form field rather than the close button', async () => {
    const DsDialog = (await import('../src/ds/DsDialog.vue')).default
    const Host = defineComponent(
      () => () =>
        h(
          DsDialog,
          { open: true, title: 'T' },
          { default: () => [h('p', 'x'), h('input', { id: 'field' })] },
        ),
    )
    mountApp(Host)
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('field')
  })
})

describe('DsMenu', () => {
  it('opens from its trigger, moves with arrows, selects with Enter and restores focus on Escape', async () => {
    const picked: string[] = []
    const { wrapper } = mountApp(DsMenu, {
      props: {
        label: 'Actions for Prod',
        items: [
          { id: 'open', label: 'Open' },
          { id: 'edit', label: 'Edit' },
          { id: 'delete', label: 'Delete', danger: true },
        ],
        onSelect: (id: string) => picked.push(id),
      },
    })
    const trigger = wrapper.get('button[aria-label="Actions for Prod"]')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    await trigger.trigger('click')
    await nextTick()
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Open', 'Edit', 'Delete'])
    expect(document.activeElement).toBe(items[0])
    const menu = document.querySelector('[role="menu"]') as HTMLElement
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[1])
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(items[2])
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(picked).toEqual(['delete'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('click')
    await nextTick()
    ;(document.querySelector('[role="menu"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })

  it('opens programmatically (context menu key) and closes on an outside click', async () => {
    const { wrapper } = mountApp(DsMenu, { props: { label: 'Menu', items: [{ id: 'a', label: 'A' }] } })
    ;(wrapper.vm as unknown as { openMenu(): void }).openMenu()
    await nextTick()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
