// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsDialog from '../src/ds/DsDialog.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import DsInput from '../src/ds/DsInput.vue'
import { useDialogStore } from '../src/stores/dialogs'
import { useToastStore } from '../src/stores/toasts'
import { mountApp } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('DsDialog (Review Focus 4)', () => {
  it('traps focus, closes on Escape and restores focus', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const open = ref(true)
    const Host = defineComponent(
      () => () =>
        h(
          DsDialog,
          { open: open.value, title: 'Title', onClose: () => (open.value = false) },
          {
            default: () => [h('input', { id: 'first' }), h('button', { id: 'last' }, 'x')],
          },
        ),
    )
    mountApp(Host)
    await nextTick()
    await nextTick()
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Title')
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button, input')]
    focusables.at(-1)!.focus()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(focusables[0])
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    await nextTick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('confirm dialogs', () => {
  it('queues dialogs and resolves each exactly once', async () => {
    mountApp(DialogHost)
    const dialogs = useDialogStore()
    const first = dialogs.confirm({ title: 'One', message: 'm1' })
    const second = dialogs.confirm({ title: 'Two', message: 'm2', danger: true, requireText: 'orders' })
    await nextTick()
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('One')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    expect(await first).toBe(true)
    await nextTick()
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Two')
    const confirmButton = document.querySelector('[data-test="confirm"]') as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
    const input = document.querySelector('[data-test="require-text"] input') as HTMLInputElement
    input.value = 'orders'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(confirmButton.disabled).toBe(false)
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    expect(await second).toBe(false)
  })
})

describe('toasts', () => {
  it('announces politely and auto-dismisses', async () => {
    vi.useFakeTimers()
    mountApp(ToastHost)
    const toasts = useToastStore()
    toasts.push({ kind: 'success', message: 'Saved', timeoutMs: 1000 })
    await nextTick()
    const region = document.querySelector('[aria-live="polite"]')!
    expect(region.textContent).toContain('Saved')
    vi.advanceTimersByTime(1100)
    await nextTick()
    expect(region.textContent).not.toContain('Saved')
  })
})

describe('DsInput', () => {
  it('labels the input and links the error for screen readers', () => {
    const { wrapper } = mountApp(DsInput, { props: { modelValue: '', label: 'Name', error: 'Required' } })
    const input = wrapper.get('input')
    expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toContain('Name')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(wrapper.get(`#${input.attributes('aria-describedby')}`).text()).toBe('Required')
  })
})
