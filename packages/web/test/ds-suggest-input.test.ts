import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import DsSuggestInput from '../src/ds/DsSuggestInput.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'
import { settled } from './support/dom'

/**
 * User report 2026-10-30: a database or collection is picked from the connection's own names, and a
 * new one can still be typed (a copy's target). The field offers the names as one types.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

function mounted(start = '', suggestions = ['shop', 'shipping', 'analytics'], trim = false) {
  const value = ref(start)
  const keys: string[] = []
  const Host = defineComponent(
    () => () =>
      h('div', { onKeydown: (e: KeyboardEvent) => keys.push(e.key) }, [
        h(DsSuggestInput, {
          label: 'Database',
          suggestions,
          modelValue: value.value,
          ...(trim ? { modelModifiers: { trim: true } } : {}),
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
      ]),
  )
  mountApp(Host)
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!
  return { value, keys, input }
}
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim())
// A key pressed in the millisecond the host's listener was attached is not handled (support/dom.ts).
const press = async (el: HTMLElement, key: string) => {
  await settled()
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await flushPromises()
}
async function type(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe('a field that offers names', () => {
  it('lists every name when it opens, and narrows them as one types', async () => {
    const { input } = mounted()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    await press(input, 'ArrowDown')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(options()).toEqual(['shop', 'shipping', 'analytics'])
    await type(input, 'SH')
    expect(options()).toEqual(['shop', 'shipping'])
  })

  it('takes the name picked with the keys or the pointer', async () => {
    const { input, value } = mounted()
    // Opened, no name is chosen yet; the arrows then reach the first, then the second.
    await press(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(
      document.querySelectorAll('[role="option"]')[1]!.id,
    )
    await press(input, 'Enter')
    expect(value.value).toBe('shipping')
    expect(input.getAttribute('aria-expanded')).toBe('false')

    input.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((o) => o.textContent?.trim() === 'analytics')!
      .click()
    await flushPromises()
    expect(value.value).toBe('analytics')
  })

  it('keeps a new name typed that is not in the list', async () => {
    const { input, value } = mounted()
    await type(input, 'reports')
    expect(value.value).toBe('reports')
    expect(options()).toEqual([])
    // Enter with nothing to pick leaves the name (and the form's own Enter) alone.
    await press(input, 'Enter')
    expect(value.value).toBe('reports')
  })

  it('closes its list on Escape without closing the dialog it is in', async () => {
    const { input, keys } = mounted()
    await press(input, 'ArrowDown')
    await press(input, 'Escape')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(keys).not.toContain('Escape')
    // Closed, Escape is the dialog's again.
    await press(input, 'Escape')
    expect(keys).toContain('Escape')
  })

  it('shows the field without a list when there are no names', async () => {
    const { input } = mounted('', [])
    await press(input, 'ArrowDown')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  // Review of the branch (I1): with v-model.trim a name with a space is typed as it is written.
  it('keeps a space being typed while the model takes the trimmed name', async () => {
    const { input, value } = mounted('', ['shop'], true)
    for (const text of ['a', 'a ', 'a b']) await type(input, text)
    expect(input.value).toBe('a b')
    expect(value.value).toBe('a b')
    await type(input, 'a b ')
    expect(input.value).toBe('a b ')
    expect(value.value).toBe('a b')
  })

  // Review of the branch (I2): a new name typed is not swapped for the first name that contains it.
  it('leaves Enter to the form until a name is chosen with the arrows', async () => {
    const { input, value, keys } = mounted('', ['shop_old', 'shipping'])
    await type(input, 'shop')
    expect(options()).toEqual(['shop_old'])
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    await press(input, 'Enter')
    expect(value.value).toBe('shop')
    expect(keys).toContain('Enter')
    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    await press(input, 'Enter')
    expect(value.value).toBe('shop_old')
  })

  // Review of the branch (I3): a list with nothing in it takes no Escape (one closes the dialog).
  it('leaves Escape to the dialog when nothing is listed', async () => {
    const { input, keys } = mounted()
    await type(input, 'reports')
    await press(input, 'Escape')
    expect(keys).toContain('Escape')
  })

  // Review of the branch (M4): names that change under an open list leave no active option behind.
  it('names no missing option when the names change under it', async () => {
    const names = ref(['shop', 'shipping', 'analytics'])
    const value = ref('')
    const Host = defineComponent(
      () => () =>
        h(DsSuggestInput, {
          label: 'Database',
          suggestions: names.value,
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
        }),
    )
    mountApp(Host)
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!
    await press(input, 'ArrowUp')
    await press(input, 'ArrowUp')
    names.value = ['crm']
    await flushPromises()
    const active = input.getAttribute('aria-activedescendant')
    expect(active === null || document.getElementById(active) !== null).toBe(true)
  })
})
