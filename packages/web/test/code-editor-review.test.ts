// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsCodeEditor from '../src/ds/DsCodeEditor.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

/**
 * Review 2026-11-07 of the code editor (1.2.1): its size (a resize kept, a long text grows the box),
 * the suggestions at the caret, the caret after an undo, and a field that is only shown. The layout
 * itself is checked in Chrome (e2e 43-document-page, 07-aggregation); here, what the editor asks of it.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

type Exposed = { focus(): void }
const scroller = () => document.querySelector<HTMLElement>('[data-code-scroller]')!
const area = () => document.querySelector('textarea')!
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]')
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const press = (key: string, init: KeyboardEventInit = {}) =>
  area().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))

function mountEditor(initial: string, props: Record<string, unknown> = {}) {
  const value = ref(initial)
  const editor = ref<Exposed | null>(null)
  const extra = ref<Record<string, unknown>>(props)
  const events: string[] = []
  const Host = defineComponent(
    () => () =>
      h(DsCodeEditor, {
        ref: editor,
        label: 'Code',
        modelValue: value.value,
        'onUpdate:modelValue': (v: string) => (value.value = v),
        onUndo: () => events.push('undo'),
        onRedo: () => events.push('redo'),
        onSubmit: () => events.push('submit'),
        ...extra.value,
      }),
  )
  mountApp(Host)
  return { value, editor, extra, events }
}

/** Where the colours draw the caret, and the box around them, as Chrome would measure them. */
function measure(caret: { top: number; left: number }, box = { top: 100, height: 400 }) {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
    top: caret.top,
    bottom: caret.top + 20,
    left: caret.left,
    right: caret.left + 8,
    height: 20,
    width: 8,
  } as DOMRect)
  vi.spyOn(scroller(), 'getBoundingClientRect').mockReturnValue({
    top: box.top,
    bottom: box.top + box.height,
    left: 0,
    right: 600,
    height: box.height,
    width: 600,
  } as DOMRect)
  Object.defineProperty(scroller(), 'clientHeight', { configurable: true, value: box.height })
}

describe('the code editor’s size', () => {
  // Finding 1 (1.2.0): the box's height was written again on every keystroke, so a box made taller
  // by its handle snapped back as soon as a key was pressed.
  it('keeps the height the user dragged the box to when a key is pressed', async () => {
    const { value } = mountEditor('{ a: 1 }', { multiline: true, rows: 4 })
    await nextTick()
    scroller().style.height = '249px'
    await nextTick()
    value.value = '{ a: 12 }'
    await nextTick()
    await nextTick()
    expect(scroller().style.height).toBe('249px')
    // Dragged, it is the user's size: no longer held to the most it grows to by itself.
    expect(scroller().style.maxHeight).toBe('')
  })

  // Finding 7: a stage of 17 lines scrolled in a box of 4 rows.
  it('grows a multi-line box with its text from its rows up to a limit, then scrolls', () => {
    mountEditor('x', { multiline: true, rows: 4 })
    expect(scroller().style.height).toBe('')
    expect(scroller().style.minHeight).toBe('calc(4 * 1.25rem + 1rem)')
    expect(scroller().style.maxHeight).toMatch(/^max\(calc\(4 \* 1\.25rem \+ 1rem\), min\(/)
    expect(scroller().className).toContain('resize-y')
  })

  // Finding 6 (1.1.0): only line breaks counted, so a long projection that wraps showed one row of two.
  it('grows a one-line field with its wrapped rows, up to six', () => {
    mountEditor('{ name: 1, email: 1, createdAt: 1 }')
    expect(scroller().style.height).toBe('')
    expect(scroller().style.minHeight).toBe('calc(1 * 1.25rem + 1rem)')
    expect(scroller().style.maxHeight).toBe('calc(6 * 1.25rem + 1rem)')
    expect(scroller().className).not.toContain('resize-y')
  })
})

describe('the suggestions', () => {
  const fields = [
    { label: 'status', kind: 'field' as const },
    { label: 'stock', kind: 'field' as const },
  ]

  // Finding 2: the list sat under the whole box, cut off by a card's or a page's edge.
  it('open at the caret, over the page and out of every box that clips', async () => {
    mountEditor('{ s', { multiline: true, rows: 4, completions: fields })
    vi.stubGlobal('innerHeight', 900)
    vi.stubGlobal('innerWidth', 1200)
    measure({ top: 300, left: 140 })
    area().focus()
    area().setSelectionRange(3, 3)
    area().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await nextTick()
    const list = listbox()!
    expect(list.parentElement).toBe(document.body)
    expect(list.className).toMatch(/(?:^|\s)fixed(?:\s|$)/)
    // Under the caret's line (300 + 20), a few pixels apart.
    expect(parseFloat(list.style.top)).toBeGreaterThanOrEqual(320)
    expect(parseFloat(list.style.top)).toBeLessThan(330)
    expect(parseFloat(list.style.left)).toBeLessThanOrEqual(140)
    expect(parseFloat(list.style.left)).toBeGreaterThan(100)
    expect(area().getAttribute('aria-controls')).toBe(list.id)
    expect(area().getAttribute('aria-activedescendant')).toBe(`${list.id}-0`)
  })

  it('open above the caret when there is no room below, never taller than the room there is', async () => {
    mountEditor('{ s', { multiline: true, rows: 4, completions: fields })
    vi.stubGlobal('innerHeight', 900)
    vi.stubGlobal('innerWidth', 1200)
    measure({ top: 820, left: 140 }, { top: 500, height: 380 })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200)
    area().focus()
    area().setSelectionRange(3, 3)
    area().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await nextTick()
    const list = listbox()!
    const top = parseFloat(list.style.top)
    // Its bottom just over the caret's line (820).
    expect(top + 200).toBeLessThanOrEqual(820)
    expect(top + 200).toBeGreaterThan(810)
    expect(parseFloat(list.style.maxHeight)).toBeLessThanOrEqual(820)
  })

  it('moves the active suggestion into sight in the list alone, not the page', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `s${i}`, kind: 'field' as const }))
    mountEditor('{ s', { multiline: true, rows: 4, completions: many })
    measure({ top: 300, left: 140 })
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    area().focus()
    area().setSelectionRange(3, 3)
    area().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    press('ArrowDown')
    await nextTick()
    await nextTick()
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('follows the caret when the box scrolls, and closes when the caret leaves the box', async () => {
    mountEditor('{ s', { multiline: true, rows: 4, completions: fields })
    vi.stubGlobal('innerHeight', 900)
    measure({ top: 300, left: 140 })
    area().focus()
    area().setSelectionRange(3, 3)
    area().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await nextTick()
    measure({ top: 250, left: 140 })
    scroller().dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(parseFloat(listbox()!.style.top)).toBeLessThan(280)
    measure({ top: 40, left: 140 })
    scroller().dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(listbox()).toBeNull()
  })
})

describe('the caret when the text is replaced from outside', () => {
  const text = Array.from({ length: 50 }, (_, i) => `  field${i}: ${i},`).join('\n')

  // Finding 3: a new field's caret was at the end, so Tab into it showed the end of the document.
  it('starts at the beginning of the text', () => {
    mountEditor(text, { multiline: true, fill: true })
    expect([area().selectionStart, area().selectionEnd]).toEqual([0, 0])
  })

  // Finding 3: Ctrl+Z, Ctrl+Y and Format went to the page's history, which replaced the text: the
  // browser put the caret at the end and the box followed it there.
  it('goes to where an undo changed the text, and the box shows that place', async () => {
    const { value } = mountEditor(text, { multiline: true, fill: true, historyKeys: true })
    await nextTick()
    area().focus()
    const at = text.indexOf('field5:') + 7
    area().setSelectionRange(at, at)
    measure({ top: 1_000, left: 40 })
    scroller().scrollTop = 0
    // The owner's history puts back the text without the X typed after field5.
    value.value = text.slice(0, at) + 'X' + text.slice(at)
    await nextTick()
    value.value = text
    await nextTick()
    await nextTick()
    expect([area().selectionStart, area().selectionEnd]).toEqual([at, at])
    await frame()
    await frame()
    // Measured at 1000–1020 in a box 100–500: moved the least that shows it.
    expect(scroller().scrollTop).toBe(1_020 - 500 + 8)
  })

  it('goes after what a redo put back on its line', async () => {
    const { value } = mountEditor(text, { multiline: true, fill: true, historyKeys: true })
    await nextTick()
    const at = text.indexOf('field5:') + 7
    value.value = text.slice(0, at) + 'XY' + text.slice(at)
    await nextTick()
    await nextTick()
    expect(area().selectionStart).toBe(at + 2)
  })

  it('focuses without scrolling the box by itself', () => {
    const { editor } = mountEditor(text, { multiline: true, fill: true })
    const focus = vi.spyOn(area(), 'focus')
    editor.value!.focus()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})

describe('the caret when the box changes size', () => {
  // Finding 4: the first key that made the text invalid showed the error under the box a moment
  // later, which shrank it over the caret.
  it('keeps the caret in sight when the box shrinks while it is typed in', async () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly fire: () => void) {
          observers.push(() => this.fire())
        }
        observe() {}
        disconnect() {}
      },
    )
    mountEditor('a\nb\nc', { multiline: true, fill: true })
    await nextTick()
    area().focus()
    area().setSelectionRange(5, 5)
    scroller().scrollTop = 0
    measure({ top: 480, left: 40 }, { top: 100, height: 360 })
    for (const fire of observers) fire()
    await frame()
    expect(scroller().scrollTop).toBe(500 - 460 + 8)
  })

  it('leaves the box alone when it changes size while nobody types in it', async () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly fire: () => void) {
          observers.push(() => this.fire())
        }
        observe() {}
        disconnect() {}
      },
    )
    mountEditor('a\nb\nc', { multiline: true, fill: true })
    await nextTick()
    scroller().scrollTop = 0
    measure({ top: 480, left: 40 }, { top: 100, height: 360 })
    for (const fire of observers) fire()
    await frame()
    expect(scroller().scrollTop).toBe(0)
  })
})

describe('a field that is only shown', () => {
  // Finding 5: while a new document was being saved, Enter, Tab, a bracket, Backspace between a
  // pair or a suggestion still changed its text (the browser's own edit failed, the fallback did not).
  it('takes no change from any key while it is read-only', async () => {
    const { value, events } = mountEditor('{}', {
      multiline: true,
      readonly: true,
      historyKeys: true,
      completions: [{ label: 'status', kind: 'field' as const }],
    })
    await nextTick()
    area().focus()
    area().setSelectionRange(1, 1)
    for (const key of ['Enter', 'Tab', '{', '"', 'Backspace']) press(key)
    press(' ', { ctrlKey: true })
    await nextTick()
    expect(listbox()).toBeNull()
    press('Enter')
    press('z', { ctrlKey: true })
    press('y', { ctrlKey: true })
    await nextTick()
    expect(value.value).toBe('{}')
    expect(area().value).toBe('{}')
    expect(events).toEqual([])
  })

  it('closes its suggestions when it turns read-only', async () => {
    const { extra } = mountEditor('{ s', {
      multiline: true,
      completions: [{ label: 'status', kind: 'field' as const }],
    })
    area().focus()
    area().setSelectionRange(3, 3)
    area().dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(listbox()).not.toBeNull()
    extra.value = { ...extra.value, readonly: true }
    await nextTick()
    expect(listbox()).toBeNull()
  })
})
