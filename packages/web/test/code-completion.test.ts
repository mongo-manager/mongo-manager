// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import { completionsFor } from '../src/documents/completions'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const VALUES: Record<string, string[]> = {
  status: ['"paid"', '"refunded"', '"pending"'],
  total: ['1200', '99.5'],
  city: ['"İstanbul"', '"Muğla"', '"Ankara"'],
  'address.city': ['"İzmir"'],
}
function mountField(initial = '', fields = ['_id', 'name', 'status', 'total', 'customer.city']) {
  const text = ref(initial)
  const submits = ref(0)
  const Host = defineComponent(
    () => () =>
      h(DsCodeEditor, {
        label: 'Filter',
        modelValue: text.value,
        'onUpdate:modelValue': (v: string) => (text.value = v),
        onSubmit: () => submits.value++,
        completions: completionsFor('query', fields),
        values: (path: string) => VALUES[path] ?? [],
      }),
  )
  mountApp(Host)
  const el = document.querySelector('textarea')!
  return { text, el, submits }
}
/** Types at the end, as a person would (the caret follows). */
async function type(el: HTMLTextAreaElement, value: string) {
  el.focus()
  el.value = value
  el.setSelectionRange(value.length, value.length)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
const options = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (o) => o.querySelector('span')?.textContent?.trim() ?? '',
  )

describe('completion in the filter (UI redesign R1 review)', () => {
  it('writes a field chosen in an empty filter as a document, with the caret on its value', async () => {
    const { text, el } = mountField()
    await type(el, 'na')
    expect(options()[0]).toContain('name')
    key(el, 'Enter')
    await nextTick()
    expect(text.value).toBe('{ name:  }')
    expect(el.selectionStart).toBe('{ name: '.length)
  })

  it('quotes a dotted path chosen as a key', async () => {
    const { text, el } = mountField()
    await type(el, '{ customer.c')
    key(el, 'Enter')
    await nextTick()
    expect(text.value).toBe('{ "customer.city": ')
  })

  it('suggests the values seen for the field, and fills one in whole', async () => {
    const { text, el } = mountField()
    await type(el, '{ status: "r')
    expect(options()).toEqual(['"refunded"'])
    key(el, 'Enter')
    await nextTick()
    expect(text.value).toBe('{ status: "refunded"')
    await type(el, '{ total: ')
    key(el, ' ', { ctrlKey: true })
    await nextTick()
    expect(options()).toEqual(expect.arrayContaining(['1200', '99.5']))
  })

  it('offers a field typed in full, so Enter writes it as a document instead of running the bare name (user report 2026-11-07)', async () => {
    const { text, el, submits } = mountField('', ['_id', 'code', 'codeName'])
    await type(el, 'code')
    expect(options()[0]).toBe('code')
    key(el, 'Enter')
    await nextTick()
    expect(submits.value).toBe(0)
    expect(text.value).toBe('{ code:  }')
    expect(el.selectionStart).toBe('{ code: '.length)
  })

  it('puts the field typed in full before the longer ones that start with it', async () => {
    const { el } = mountField('', ['codeName', 'code'])
    await type(el, '{ code')
    expect(options()).toEqual(['code', 'codeName'])
  })

  it('offers nothing for a name already written as it has to be, and Enter runs the filter', async () => {
    const { el, submits } = mountField('', ['code'])
    el.focus()
    el.value = '{ code: 1 }'
    el.setSelectionRange('{ code'.length, '{ code'.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(options()).toEqual([])
    key(el, 'Enter')
    expect(submits.value).toBe(1)
  })

  it('lists the values seen for a field as soon as the field is chosen', async () => {
    const { text, el } = mountField()
    await type(el, 'stat')
    key(el, 'Enter')
    await nextTick()
    expect(text.value).toBe('{ status:  }')
    expect(options()).toEqual(['"paid"', '"refunded"', '"pending"'])
    key(el, 'ArrowDown')
    key(el, 'Enter')
    await nextTick()
    expect(text.value).toBe('{ status: "refunded" }')
  })

  it('lists the values seen for a field once its colon is typed', async () => {
    const { el } = mountField()
    await type(el, '{ status:')
    expect(options()).toEqual(['"paid"', '"refunded"', '"pending"'])
    await type(el, '{ status: ')
    expect(options()).toEqual(['"paid"', '"refunded"', '"pending"'])
    await type(el, '{ name: ')
    expect(options()).toEqual([])
    await type(el, '{ status: "paid", ')
    expect(options()).toEqual([])
  })

  it('completes with Tab as with Enter (user request 2026-11-07)', async () => {
    const { text, el } = mountField('', ['code', 'weight'])
    await type(el, 'cod')
    expect(key(el, 'Tab')).toBe(false)
    await nextTick()
    expect(text.value).toBe('{ code:  }')
  })

  it('completes the word before the caret with Tab while no list shows', async () => {
    const { text, el } = mountField('', ['code', 'weight'])
    el.focus()
    // The caret put after a word (a click, the arrow keys): no list is open.
    el.value = '{ code: 1, wei }'
    el.setSelectionRange('{ code: 1, wei'.length, '{ code: 1, wei'.length)
    expect(options()).toEqual([])
    expect(key(el, 'Tab')).toBe(false)
    await nextTick()
    expect(text.value).toBe('{ code: 1, weight:  }')
  })

  it('leaves the field with Tab after Escape, or where nothing fits', async () => {
    const { text, el } = mountField('', ['code'])
    await type(el, '{ cod')
    key(el, 'Escape')
    expect(key(el, 'Tab')).toBe(true)
    await type(el, '{ zzz')
    expect(key(el, 'Tab')).toBe(true)
    expect(text.value).toBe('{ zzz')
  })

  it('opens no list after a field no value is known for', async () => {
    const { el } = mountField()
    await type(el, 'na')
    key(el, 'Enter')
    await nextTick()
    expect(options()).toEqual([])
  })

  it('lists the fields on Ctrl+Space where a field name goes', async () => {
    const { el } = mountField()
    await type(el, '{ ')
    key(el, ' ', { ctrlKey: true })
    await nextTick()
    expect(options().slice(0, 5).join(' ')).toMatch(/_id.*name.*status.*total.*customer\.city/)
  })
})

describe('the values a field is seen with', () => {
  it('lists them as shell literals, most common first, through arrays and nested documents', async () => {
    const { fieldValues, toRows } = await import('../src/documents/rows')
    const rows = toRows(
      [
        {
          document: {
            _id: { $numberInt: '1' },
            status: 'paid',
            tags: ['a', 'b'],
            customer: { city: 'Berlin' },
          },
          hash: 'x',
        },
        {
          document: { _id: { $numberInt: '2' }, status: 'paid', tags: ['b'], customer: { city: 'İzmir' } },
          hash: 'y',
        },
        {
          document: { _id: { $numberInt: '3' }, status: 'refunded', total: { $numberInt: '1200' } },
          hash: 'z',
        },
      ],
      0,
    )
    expect(fieldValues(rows, 'status')).toEqual(['"paid"', '"refunded"'])
    expect(fieldValues(rows, 'tags')).toEqual(['"b"', '"a"'])
    expect(fieldValues(rows, 'customer.city')).toEqual(['"Berlin"', '"İzmir"'])
    expect(fieldValues(rows, 'total')).toEqual(['1200'])
    expect(fieldValues(rows, 'missing')).toEqual([])
  })
})

describe('a double-click selects the word only (UI redesign R1 review)', () => {
  it('drops the space Windows adds after a double-clicked word, so a quote wraps just the word', async () => {
    const { text, el } = mountField()
    await type(el, '{ status: shipped }')
    // What Windows selects on a double-click: the word and the space after it.
    el.setSelectionRange(10, 18)
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect([el.selectionStart, el.selectionEnd]).toEqual([10, 17])
    key(el, '"')
    await nextTick()
    expect(text.value).toBe('{ status: "shipped" }')
  })
})

describe('a document without an _id (an aggregation result)', () => {
  it('is named by its place in the results, not "undefined"', async () => {
    const { toRows } = await import('../src/documents/rows')
    const { rowId } = await import('../src/documents/rowMenu')
    const rows = toRows(
      [
        { document: { n: 1 }, hash: 'a' },
        { document: { n: 2 }, hash: 'b' },
      ],
      20,
    )
    expect(rows.map(rowId)).toEqual(['#21', '#22'])
  })
})

describe('value suggestions, final review', () => {
  it('match Turkish capitals and letters with marks as typed (reviewer B Minor 8)', async () => {
    const { el } = mountField()
    await type(el, '{ city: "ist')
    expect(options()).toEqual(['"İstanbul"'])
    await type(el, '{ city: "mugl')
    expect(options()).toEqual(['"Muğla"'])
  })

  it('come from the field the caret is in, inside a document (reviewer B Minor 9)', async () => {
    const { el } = mountField()
    await type(el, '{ address: { city: "')
    expect(options()).toEqual(['"İzmir"'])
  })
})
