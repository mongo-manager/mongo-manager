// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeView from '../src/ds/DsCodeView.vue'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import { HIDDEN_TOKEN } from '../src/masking/useMaskedPaths'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

// Document page design §6.7: a search's matches are marked in the JSON and edit views too.
const marks = () => [...document.querySelectorAll<HTMLElement>('mark[data-search-mark]')]

describe('search marks in code', () => {
  it('marks the matched text in a code view, the current one apart', () => {
    mountApp(DsCodeView, { props: { text: '{ a: "card" }', marks: [[6, 10]], currentMark: 0 } })
    expect(marks().map((m) => m.textContent)).toEqual(['card'])
    expect(marks()[0]!.hasAttribute('data-current')).toBe(true)
  })

  it('marks across token edges, each piece in its own colour', () => {
    mountApp(DsCodeView, { props: { text: '{ a: "card" }', marks: [[2, 7]] } })
    expect(
      marks()
        .map((m) => m.textContent)
        .join(''),
    ).toBe('a: "c')
    expect(marks().length).toBeGreaterThan(1)
  })

  it('never shows the mark that stands for a hidden value', () => {
    const text = `{ card: ${HIDDEN_TOKEN} }`
    const at = text.indexOf(HIDDEN_TOKEN)
    mountApp(DsCodeView, {
      props: {
        text,
        hidden: { token: HIDDEN_TOKEN, label: 'Hidden' },
        marks: [[at, at + HIDDEN_TOKEN.length]],
      },
    })
    expect(document.body.textContent).not.toContain(HIDDEN_TOKEN)
    expect(document.querySelector('[data-masked]')).not.toBeNull()
  })

  it('marks matches in the editor and selects one when asked', async () => {
    const { wrapper } = mountApp(DsCodeEditor, {
      props: { modelValue: '{ a: "card" }', label: 'Document', multiline: true, marks: [[6, 10]] },
    })
    expect(marks().map((m) => m.textContent)).toEqual(['card'])
    ;(wrapper.vm as unknown as { select: (from: number, to: number) => void }).select(6, 10)
    const area = document.querySelector('textarea')!
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 10])
  })

  it('hands undo and redo to its owner when asked to', async () => {
    const { wrapper } = mountApp(DsCodeEditor, {
      props: { modelValue: 'abc', label: 'Document', multiline: true, historyKeys: true },
    })
    const area = document.querySelector('textarea')!
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    area.dispatchEvent(undo)
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }),
    )
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))
    await nextTick()
    expect(undo.defaultPrevented).toBe(true)
    expect(wrapper.emitted('undo')).toHaveLength(1)
    expect(wrapper.emitted('redo')).toHaveLength(2)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('leaves undo to the text field otherwise', () => {
    mountApp(DsCodeEditor, { props: { modelValue: 'abc', label: 'Document', multiline: true } })
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    document.querySelector('textarea')!.dispatchEvent(undo)
    expect(undo.defaultPrevented).toBe(false)
  })
})
