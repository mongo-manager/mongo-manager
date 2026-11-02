import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import StagePicker from '../src/aggregation/StagePicker.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

/** Seventh review of the floating window (M-2): Escape in the stage list gives focus back to its button. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})

describe('the stage picker’s Escape', () => {
  it('closes the list, keeps the key, and gives focus back to its button', async () => {
    mountApp(StagePicker)
    const button = document.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    button.click()
    await flushPromises()
    const field = document.querySelector<HTMLInputElement>('input[type="search"]')!
    field.focus()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let reachedPage = false
    document.addEventListener('keydown', () => (reachedPage = true), { once: true })
    field.dispatchEvent(escape)
    await flushPromises()
    expect(document.querySelector('input[type="search"]')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(reachedPage).toBe(false)
  })
})
