import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import { mountApp } from './support/app'
import { byLabel } from './support/dom'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

type Exposed = { insert(text: string): void; focus(): void }

function mountInput(props: Record<string, unknown>) {
  const value = ref('')
  const input = ref<Exposed | null>(null)
  const Host = defineComponent(
    () => () =>
      h(DsCodeEditor, {
        ref: input,
        label: 'Code',
        modelValue: value.value,
        'onUpdate:modelValue': (v: string) => (value.value = v),
        ...props,
      }),
  )
  mountApp(Host)
  return { value, input, area: () => byLabel<HTMLTextAreaElement>('Code') }
}

async function typeText(el: HTMLTextAreaElement, text: string) {
  el.value = text
  el.setSelectionRange(text.length, text.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
const options = () => [...document.querySelectorAll('[role="option"]')]
const press = (el: HTMLElement, key: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

/**
 * The completion list's guards, and the exposed API. (Its async provider served only the shell's
 * script editor, removed 2026-10-12 with it.)
 */
const orders = [{ label: 'orders', kind: 'collection' as const }]

describe('DsCodeEditor completions: what is accepted, and how it is shown', () => {
  it('closes the suggestions when a click moves the caret, so Enter cannot replace a wrong range (final review M5)', async () => {
    const { value, area } = mountInput({ completions: orders, multiline: true })
    await typeText(area(), 'x = 1;\nor')
    await nextTick()
    expect(options()).toHaveLength(1)
    area().setSelectionRange(2, 2)
    area().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(options()).toHaveLength(0)
    press(area(), 'Enter')
    await nextTick()
    expect(value.value).toBe('x = 1;\nor')
  })

  it('never replaces when the caret has moved before where the item starts (final review M5)', async () => {
    const { value, area } = mountInput({ completions: orders, multiline: true })
    await typeText(area(), 'x = 1;\nor')
    await nextTick()
    // The caret moves without a click or key the input sees (a script, an IME).
    area().setSelectionRange(2, 2)
    press(area(), 'Tab')
    await nextTick()
    expect(value.value).not.toContain('orders')
  })

  // Found 2026-10-12: the caret moved into the word without the input seeing it, Tab wrote the item
  // there ("ordersr").
  it('never replaces when the caret has moved since the list was made, even within the word', async () => {
    const { value, area } = mountInput({ completions: orders, multiline: true })
    await typeText(area(), 'x = 1;\nor')
    await nextTick()
    expect(options()).toHaveLength(1)
    area().setSelectionRange(8, 8)
    press(area(), 'Tab')
    await nextTick()
    expect(value.value).toBe('x = 1;\nor')
  })

  it('renders item labels as text, never HTML (A4)', async () => {
    const label = 'a<img src=x onerror=alert(1)>'
    const { area } = mountInput({ completions: [{ label, kind: 'field' }] })
    await typeText(area(), 'a')
    await nextTick()
    expect(document.querySelector('[role="listbox"] img')).toBeNull()
    expect(options()[0]?.textContent ?? '').toContain(label)
  })
})

describe('DsCodeEditor exposed API and bracket highlight', () => {
  it('inserts text at the selection', async () => {
    const { value, input, area } = mountInput({ multiline: true })
    await typeText(area(), 'db.a.find()')
    area().setSelectionRange(3, 4)
    input.value!.insert('orders')
    await nextTick()
    expect(value.value).toBe('db.orders.find()')
  })

  it('highlights the bracket at the caret and its partner in a multi-line editor', async () => {
    const { area } = mountInput({ multiline: true })
    await typeText(area(), 'f(x)')
    await nextTick()
    expect(document.querySelectorAll('[data-bracket]')).toHaveLength(2)
  })
})
