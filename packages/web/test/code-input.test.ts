// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import { tokenize } from '../src/ds/code/tokenize'
import { completionsFor } from '../src/documents/completions'
import { mountApp } from './support/app'
import { byLabel } from './support/dom'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
})

describe('tokenize', () => {
  it('is lossless and classifies shell syntax', () => {
    const src = `{ _id: ObjectId('65a1'), "n": { $gt: 5.5 }, s: "a\\"b", ok: true } // c`
    const tokens = tokenize(src)
    expect(tokens.map((t) => t.text).join('')).toBe(src)
    const typeOf = (text: string) => tokens.find((t) => t.text.trim() === text)?.type
    expect(typeOf('_id')).toBe('key')
    expect(typeOf('ObjectId')).toBe('constructor')
    expect(typeOf('"n"')).toBe('key')
    expect(typeOf('$gt')).toBe('operator')
    expect(typeOf('5.5')).toBe('number')
    expect(typeOf('true')).toBe('keyword')
    expect(typeOf('// c')).toBe('comment')
    expect(typeOf(`'65a1'`)).toBe('string')
  })

  it('never loses text, whatever the input', () => {
    for (const src of ['"unterminated', '/* open', '$', '{{[', 'é ü 🙂 \t\n', '0x1F 1e10 -3', '', '\\']) {
      expect(
        tokenize(src)
          .map((t) => t.text)
          .join(''),
      ).toBe(src)
    }
  })
})

function mountInput(props: Record<string, unknown> = {}) {
  const value = ref('')
  const submits: number[] = []
  const Host = defineComponent(
    () => () =>
      h(DsCodeEditor, {
        label: 'Filter',
        modelValue: value.value,
        'onUpdate:modelValue': (v: string) => (value.value = v),
        onSubmit: () => submits.push(1),
        ...props,
      }),
  )
  mountApp(Host)
  return { value, submits, area: () => byLabel<HTMLTextAreaElement>('Filter') }
}

const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

async function typeText(el: HTMLTextAreaElement, text: string) {
  el.value = text
  el.setSelectionRange(text.length, text.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('DsCodeEditor', () => {
  it('pairs brackets and quotes, skips closers and removes empty pairs (Review Focus 5)', async () => {
    const { value, area } = mountInput()
    area().focus()
    press(area(), '{')
    await nextTick()
    expect(value.value).toBe('{}')
    expect(area().selectionStart).toBe(1)
    press(area(), '"')
    await nextTick()
    expect(value.value).toBe('{""}')
    press(area(), 'Backspace')
    await nextTick()
    expect(value.value).toBe('{}')
    press(area(), '}')
    await nextTick()
    expect(value.value).toBe('{}')
    expect(area().selectionStart).toBe(2)
  })

  it('submits with Enter on one line and with Ctrl+Enter on several', async () => {
    const single = mountInput()
    expect(press(single.area(), 'Enter').defaultPrevented).toBe(true)
    expect(single.submits).toHaveLength(1)
    document.body.innerHTML = ''
    const multi = mountInput({ multiline: true, rows: 6 })
    expect(press(multi.area(), 'Enter').defaultPrevented).toBe(true)
    expect(multi.submits).toHaveLength(0)
    press(multi.area(), 'Enter', { ctrlKey: true })
    expect(multi.submits).toHaveLength(1)
  })

  it('suggests operators and fields and accepts with the keyboard', async () => {
    const { value, area } = mountInput({ completions: completionsFor('query', ['name', 'address.city']) })
    await typeText(area(), '{ a: { $gt')
    // First span: the label (the second holds the kind).
    const options = () =>
      [...document.querySelectorAll('[role="option"]')].map((o) => o.querySelector('span')?.textContent)
    expect(area().getAttribute('aria-expanded')).toBe('true')
    expect(options().map((o) => o?.split(/\s/)[0])).toEqual(['$gte'])
    press(area(), 'Enter')
    await nextTick()
    expect(value.value).toBe('{ a: { $gte: ')
    expect(area().getAttribute('aria-expanded')).toBe('false')
    await typeText(area(), '{ add')
    expect(options().some((o) => o?.startsWith('address.city'))).toBe(true)
    press(area(), 'Escape')
    await nextTick()
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(value.value).toBe('{ add')
  })

  it('indents with Tab on several lines unless Escape was pressed first', async () => {
    const { value, area } = mountInput({ multiline: true })
    area().focus()
    expect(press(area(), 'Tab').defaultPrevented).toBe(true)
    await nextTick()
    expect(value.value).toBe('  ')
    press(area(), 'Escape')
    expect(press(area(), 'Tab').defaultPrevented).toBe(false)
  })

  it('shows the error and marks the field invalid', () => {
    mountInput({ error: 'Line 1, column 3: Unexpected token' })
    const area = byLabel<HTMLTextAreaElement>('Filter')
    expect(area.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(area.getAttribute('aria-describedby')!)!.textContent).toContain('column 3')
  })
})

// User report 2026-11-05: in the document page's editor a new line started at the left edge, so the
// document lost its shape while one typed.
describe('a new line keeps the shape of the text', () => {
  async function enterAt(text: string, caret: number) {
    const input = mountInput({ multiline: true })
    await typeText(input.area(), text)
    input.area().focus()
    input.area().setSelectionRange(caret, caret)
    const event = press(input.area(), 'Enter')
    await nextTick()
    return { ...input, event }
  }

  it('starts at the indentation of the line it leaves', async () => {
    const text = '{\n    a: 1,'
    const { value, area, event, submits } = await enterAt(text, text.length)
    expect(event.defaultPrevented).toBe(true)
    expect(value.value).toBe('{\n    a: 1,\n    ')
    expect(area().selectionStart).toBe(value.value.length)
    expect(submits).toHaveLength(0)
  })

  it('goes one level in after an opening bracket', async () => {
    const { value } = await enterAt('{\n  payments: [', '{\n  payments: ['.length)
    expect(value.value).toBe('{\n  payments: [\n    ')
  })

  it('puts the closing bracket on a line of its own between a pair', async () => {
    const text = '{\n  a: {}\n}'
    const { value, area } = await enterAt(text, text.indexOf('{}') + 1)
    expect(value.value).toBe('{\n  a: {\n    \n  }\n}')
    expect(area().selectionStart).toBe('{\n  a: {\n    '.length)
  })

  it('replaces a selection, and the spaces before the caret go', async () => {
    const input = mountInput({ multiline: true })
    await typeText(input.area(), '  a: 1,   b: 2')
    input.area().focus()
    input.area().setSelectionRange(10, 11)
    press(input.area(), 'Enter')
    await nextTick()
    expect(input.value.value).toBe('  a: 1,\n  : 2')
  })
})
