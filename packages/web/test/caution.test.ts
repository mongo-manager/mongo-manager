// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { cautionText, touches } from '../src/documents/caution'
import { i18n } from '../src/i18n'
import DocumentTable from '../src/documents/DocumentTable.vue'
import { toRows } from '../src/documents/rows'
import { mountApp } from './support/app'

/** Data review 2026-10-13 round 2 (Minor 9–11): one wording of a caution, wherever it is said. */
const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params ?? {})

describe('a caution, worded', () => {
  it('says what can still change before a save, and how many more such fields there are', () => {
    i18n.global.locale.value = 'en'
    const edit = cautionText(t, { kind: 'ejson_like', field: 'price', others: 2 }, 'edit')
    expect(edit).toContain('"price"')
    expect(edit).toContain('other fields can be changed')
    expect(edit).toContain('More such fields in this document: 2.')
    expect(cautionText(t, { kind: 'undefined', field: 'u' }, 'edit')).toContain('cannot be changed from here')
  })

  it('never names an empty field, and reads a kind it does not know as a misread name', () => {
    i18n.global.locale.value = 'en'
    expect(cautionText(t, { kind: 'ejson_like', field: '' }, 'refused')).not.toContain('""')
    expect(cautionText(t, { kind: 'unmatched', field: '' }, 'refused')).toContain('cannot match exactly')
    expect(cautionText(t, { kind: 'whatever' as never, field: 'a' }, 'refused')).toBe(
      cautionText(t, { kind: 'ejson_like', field: 'a' }, 'refused'),
    )
  })

  it('has every wording in Turkish too', () => {
    i18n.global.locale.value = 'tr'
    for (const kind of ['ejson_like', 'undefined', 'too_deep', 'unmatched', 'bad_date'] as const)
      for (const when of ['refused', 'edit', 'clone'] as const)
        expect(cautionText(t, { kind, field: 'a', others: 1 }, when)).not.toMatch(/documents\./)
    i18n.global.locale.value = 'en'
  })

  it('touches the field itself, what holds it and what it holds; any field of a locked document', () => {
    const c = { kind: 'ejson_like' as const, field: 'a.b' }
    expect([
      touches(c, 'a'),
      touches(c, 'a.b'),
      touches(c, 'a.b.c'),
      touches(c, 'ab'),
      touches(c, 'x'),
    ]).toEqual([true, true, true, false, false])
    expect(touches({ kind: 'undefined', field: 'u' }, 'x')).toBe(true)
  })
})

describe('the documents table', () => {
  it('does not offer to change in place a cell the app would not write back as stored', () => {
    setActivePinia(createPinia())
    const rows = toRows(
      [
        {
          document: { _id: { $numberInt: '1' }, price: { $numberInt: '5' }, name: 'x' },
          hash: 'e'.repeat(64),
          caution: { kind: 'ejson_like', field: 'price' },
        },
      ],
      0,
    )
    mountApp(DocumentTable, {
      props: { rows, columns: ['_id', 'price', 'name'], canWrite: true, inlineEdit: true, rowHeight: 36 },
    })
    expect(document.querySelector('td[data-field="price"]')!.hasAttribute('tabindex')).toBe(false)
    expect(document.querySelector('td[data-field="name"]')!.getAttribute('tabindex')).toBe('0')
    document.body.innerHTML = ''
  })
})
