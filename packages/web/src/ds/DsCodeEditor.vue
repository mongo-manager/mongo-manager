<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { tokenize, type Token } from './code/tokenize'
import { TOKEN_CLASSES } from './code/tokenClasses'
import {
  HIGHLIGHT_LIMIT,
  SEARCH_CURRENT,
  SEARCH_MARK,
  chunkPieces,
  splitPieces,
  type PieceChunk,
} from './code/marks'
import { matchBracket } from './code/brackets'
import type { Completion } from './code/completion'
import { contextAt, shapeCompletion } from './code/shape'

const props = defineProps<{
  label: string
  hideLabel?: boolean
  /** UI redesign R1: no frame of its own (the query composer draws it). */
  bare?: boolean
  multiline?: boolean
  rows?: number
  placeholder?: string
  error?: string
  hint?: string
  completions?: readonly Completion[]
  /**
   * UI redesign R1 review: values seen for a field (as shell literals, most common first), offered
   * where that field's value is written.
   */
  values?: (path: string) => readonly string[]
  /** Shown, not typed in: while what it holds is being saved. */
  readonly?: boolean
  /** W5: the keys that act on the field (aria-keyshortcuts), such as / for the query bar. */
  keyshortcuts?: string
  /** Document page design §6.7: a search's matches, as [from, to) offsets in the text, in order. */
  marks?: ReadonlyArray<readonly [number, number]>
  /** The match the search is at (an index into `marks`). */
  currentMark?: number
  /** Document page design §6.6: Ctrl+Z and Ctrl+Shift+Z (Ctrl+Y) go to the owner's history instead. */
  historyKeys?: boolean
  /** Fills the height it is given (the document page's edit view) instead of a number of rows. */
  fill?: boolean
}>()
const emit = defineEmits<{ submit: []; undo: []; redo: [] }>()
const model = defineModel<string>({ required: true })
const { t } = useI18n()
const id = useId()
const listId = `${id}-completions`
const textarea = ref<HTMLTextAreaElement | null>(null)
const mirror = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)

// Long texts re-highlight once per frame; past HIGHLIGHT_LIMIT they are shown plain.
const THROTTLE_FROM = 5_000
const highlighted = ref(model.value)
let frame: number | undefined
watch(model, (value) => {
  if (value.length < THROTTLE_FROM) {
    highlighted.value = value
    return
  }
  if (frame !== undefined) return
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16)
  frame = schedule(() => {
    frame = undefined
    highlighted.value = model.value
  }) as number
})
onBeforeUnmount(() => {
  if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
})
const tokens = computed<Token[]>(() =>
  highlighted.value.length > HIGHLIGHT_LIMIT
    ? [{ type: 'text', text: highlighted.value }]
    : tokenize(highlighted.value),
)

/** The caret, for the bracket highlight (a textarea's selection is not reactive). */
const caret = ref(0)
function trackCaret(): void {
  caret.value = textarea.value?.selectionStart ?? 0
}
/** Phase 3a-2: in a multi-line editor, the bracket at the caret and its partner are highlighted. */
const bracketPair = computed(() =>
  props.multiline && highlighted.value === model.value && model.value.length <= HIGHLIGHT_LIMIT
    ? matchBracket(model.value, caret.value)
    : null,
)
/** The tokens, split so each highlighted bracket and each search match is a piece of its own. */
const pieces = computed(() =>
  splitPieces(tokens.value, {
    brackets: bracketPair.value,
    // Matches are of the text as typed: while a long text waits to be highlighted again they are not shown.
    marks: highlighted.value === model.value ? props.marks : undefined,
  }),
)
/** The pieces in chunks of lines: a keystroke draws again only the chunk it changed (v-memo). */
let drawn: PieceChunk[] = []
const chunks = computed(() => (drawn = chunkPieces(pieces.value, drawn)))

/** A height of so many rows of 1.25rem (leading-5), and the text's padding (py-2). */
const rowsHigh = (rows: number) => `calc(${rows} * 1.25rem + 1rem)`
/** One-line fields grow with their content (up to six rows) so a long filter stays visible. */
const MAX_AUTO_ROWS = 6
/** A multi-line field grows with its text up to this many rows (or most of the window), then scrolls. */
const MAX_GROW_ROWS = 24
const leastRows = computed(() => props.rows ?? (props.multiline ? 4 : 1))
/**
 * Set once the user drags the box's handle: the height is then theirs. The browser writes it into the
 * box's style, which the editor's own style never names, so no render takes it back (review
 * 2026-11-07: the height was written on every keystroke, and a resized box snapped back).
 */
const resized = ref(false)
/**
 * The scrolling box is as tall as its text, from its rows up to a limit: the rows the browser wraps
 * a long line into count too (review 2026-11-07: a projection that wrapped hid its second row, and a
 * stage of 17 lines scrolled in four).
 */
const boxStyle = computed(() => {
  if (props.fill) return undefined
  const least = rowsHigh(leastRows.value)
  if (!props.multiline)
    return { minHeight: least, maxHeight: rowsHigh(Math.max(MAX_AUTO_ROWS, leastRows.value)) }
  return {
    minHeight: least,
    maxHeight: resized.value ? undefined : `max(${least}, min(${rowsHigh(MAX_GROW_ROWS)}, 60vh))`,
  }
})

const open = ref(false)
const matches = ref<Completion[]>([])
const active = ref(0)
let escapeArmed = false
/** A list closed with Escape: Tab then leaves the field instead of completing. */
let dismissed = false

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'" }
const CLOSERS = new Set(['}', ']', ')', '"', "'"])

function wordBeforeCaret(): { word: string; start: number } {
  const el = textarea.value!
  const word = /[$\w.]*$/.exec(el.value.slice(0, el.selectionStart))![0]
  return { word, start: el.selectionStart - word.length }
}

/** Where an accepted item starts replacing: the word before the caret when the list was made. */
const replaceFrom = ref<number | null>(null)
/**
 * Where the caret was when the list was made: moved since without the input seeing it (a script, an
 * input method), the list no longer fits and nothing is replaced (found 2026-10-12: Tab wrote the
 * item where the caret had gone).
 */
let listCaret = -1

function closeCompletions(): void {
  open.value = false
  matches.value = []
  replaceFrom.value = null
  valueFrom.value = null
}
/** Where an accepted value suggestion starts replacing (it replaces the value typed so far). */
const valueFrom = ref<number | null>(null)
/** The value typed so far where a value goes: a started string, a number, nothing yet. */
const VALUE_PREFIX = /("[^"]*|'[^']*|-?[\d.]*)$/
const FORCED_MAX_ITEMS = 50

/** True when the caret sits inside a string literal (no suggestions there). */
function insideString(): boolean {
  const el = textarea.value!
  const last = tokenize(el.value.slice(0, el.selectionStart)).at(-1)
  if (!last || (last.type !== 'string' && last.type !== 'key')) return false
  const text = last.text.trimEnd()
  const quote = text[0]
  if (quote !== '"' && quote !== "'") return false
  return text.length === 1 || !text.endsWith(quote) || /\\$/.test(text.slice(0, -1))
}

/**
 * Reviewer B Minor 8: values match as typed whatever their capitals and marks — "ist" finds
 * "İstanbul", "mugl" finds "Muğla".
 */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i')

function updateCompletions(force = false): void {
  trackCaret()
  // A field only shown offers nothing to write (review 2026-11-07).
  if (props.readonly) return closeCompletions()
  const el = textarea.value!
  listCaret = el.selectionStart
  const before = el.value.slice(0, el.selectionStart)
  // A value for a known field: the values seen for it (a started string or number, its colon just
  // typed, or on Ctrl+Space).
  if (offerValues(before, force || /:\s?$/.test(before))) return
  valueFrom.value = null
  const list = props.completions ?? []
  const { word, start } = wordBeforeCaret()
  if (list.length === 0 || (word === '' && !force) || insideString()) return closeCompletions()
  replaceFrom.value = start
  const prefix = fold(word)
  // Ctrl+Space with nothing typed: what fits here first (field names where a key goes).
  const ctx = contextAt(before.slice(0, before.length - word.length))
  const after = el.value.slice(el.selectionStart)
  const fieldsFirst = ctx.position !== 'value'
  const rank = (c: Completion) => (c.kind === 'field' ? (fieldsFirst ? 0 : 2) : c.kind === 'operator' ? 1 : 3)
  // User report 2026-11-07: a field typed in full ("code") stays on offer while choosing it still
  // writes more ({ code: | }), so Enter does not run the bare name; the name typed comes first.
  const writesMore = (c: Completion) =>
    ['field', 'operator', 'constructor'].includes(c.kind) && shapeCompletion(c, ctx, after).text !== word
  matches.value = list
    .filter((c) => fold(c.label).startsWith(prefix) && (c.label !== word || writesMore(c)))
    .sort((a, b) => (word === '' ? rank(a) - rank(b) : Number(b.label === word) - Number(a.label === word)))
    .slice(0, word === '' ? FORCED_MAX_ITEMS : 12)
  active.value = 0
  open.value = matches.value.length > 0
}

/** Lists the values seen for the field a value is being written for; false when there are none. */
function offerValues(before: string, force: boolean): boolean {
  if (!props.values) return false
  const prefix = VALUE_PREFIX.exec(before)![0]
  const ctx = contextAt(before.slice(0, before.length - prefix.length))
  if (ctx.position !== 'value' || !ctx.key || (prefix === '' && !force)) return false
  const typed = fold(prefix.replace(/^'/, '"'))
  const found = props
    .values(ctx.key)
    .filter((v) => fold(v).startsWith(typed) && v !== prefix)
    .slice(0, force ? FORCED_MAX_ITEMS : 12)
  if (found.length === 0) return false
  matches.value = found.map((label): Completion => ({ label, kind: 'value' }))
  valueFrom.value = before.length - prefix.length
  active.value = 0
  open.value = true
  return true
}

/**
 * Programmatic edits go through the browser's editing command so Ctrl+Z undoes them like typing;
 * setRangeText is the fallback where that command is unavailable (it bypasses the undo stack). A
 * read-only field takes none: the command fails there, but the fallback wrote in it all the same
 * (review 2026-11-07: Enter, Tab or a bracket changed a new document while it was being saved).
 */
function replaceRange(start: number, end: number, text: string, caret = start + text.length): void {
  if (props.readonly) return
  const el = textarea.value!
  el.focus({ preventScroll: true })
  el.setSelectionRange(start, end)
  let done: boolean
  try {
    done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
  } catch {
    done = false
  }
  if (!done || el.value.slice(start, start + text.length) !== text) el.setRangeText(text, start, end, 'end')
  el.setSelectionRange(caret, caret)
  model.value = el.value
}

function accept(index = active.value): void {
  const choice = matches.value[index]
  if (!choice) return
  const el = textarea.value!
  const start = valueFrom.value ?? replaceFrom.value ?? wordBeforeCaret().start
  // The caret moved since the list was made, or text is selected: the range no longer fits the
  // suggestion, so nothing is replaced (final review M5).
  if (el.selectionStart !== listCaret || el.selectionStart < start || el.selectionStart !== el.selectionEnd)
    return closeCompletions()
  if (choice.kind === 'value') {
    // A value replaces what was typed of it, and the closing quote typed for it.
    const caret = el.selectionStart
    const end = choice.label.endsWith('"') && el.value[caret] === '"' ? caret + 1 : caret
    replaceRange(start, end, choice.label)
  } else if (['field', 'operator', 'constructor'].includes(choice.kind)) {
    // UI redesign R1 review: written the way it has to be where the caret is ({ name: | }, $in: [|]).
    const shaped = shapeCompletion(
      choice,
      contextAt(el.value.slice(0, start)),
      el.value.slice(el.selectionStart),
    )
    replaceRange(start, el.selectionStart, shaped.text, start + shaped.caret)
  } else {
    replaceRange(start, el.selectionStart, choice.insert ?? choice.label)
  }
  closeCompletions()
  trackCaret()
  // A field chosen goes on to its value: the values seen for it, when there are any.
  if (choice.kind === 'field' && !props.readonly) {
    listCaret = el.selectionStart
    offerValues(el.value.slice(0, el.selectionStart), true)
  }
}

defineExpose({
  /** Insert text at the selection, as typing would (undoable). */
  insert: (text: string): void => {
    const el = textarea.value
    if (!el) return
    replaceRange(el.selectionStart, el.selectionEnd, text)
    trackCaret()
  },
  /**
   * The box is not scrolled to the caret by the focus (review 2026-11-07: Format sent a document's
   * box to its end): what changed the text shows its place itself.
   */
  focus: (): void => textarea.value?.focus({ preventScroll: true }),
  /**
   * Selects [from, to) and scrolls it into the middle of the field (a search's current match); with
   * focus false the focus stays where it is (the search box).
   */
  select: (from: number, to: number, focus = true): void => {
    const el = textarea.value
    if (!el) return
    if (focus) el.focus({ preventScroll: true })
    el.setSelectionRange(from, to)
    reveal(from)
    trackCaret()
  },
})

const NEWLINE = String.fromCharCode(10)

/**
 * Scrolls the field so the text at an offset is in its middle. It goes by where the colours draw
 * that offset (the same text, laid out as the field lays it out), not by lines: a value that wraps
 * over a hundred rows put every match after it out of sight (user report 2026-11-05).
 */
function reveal(at: number): void {
  const box = scroller.value
  const drawn = box && drawnAt(at)
  if (!box || !drawn) return
  const top = drawn.top - box.getBoundingClientRect().top + box.scrollTop
  box.scrollTop = Math.max(0, top - box.clientHeight / 2)
}

/** Where the colours draw the character at an offset (the last one drawn is the closing newline). */
function drawnAt(at: number): DOMRect | null {
  if (!mirror.value) return null
  const walker = document.createTreeWalker(mirror.value, NodeFilter.SHOW_TEXT)
  let left = at
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (left < node.length) {
      const range = document.createRange()
      range.setStart(node, left)
      range.setEnd(node, left + 1)
      return range.getBoundingClientRect()
    }
    left -= node.length
  }
  return null
}

// The field never scrolls by itself (the box does), so the browser no longer keeps its caret in
// sight: after a key or an input has done its work, and the colours show the text it left, the box
// moves the least that shows the caret. A key that moved nothing (a copy) leaves the box where the
// user scrolled it.
const TEXT_PADDING = 8
let following: number | undefined
/** `changed`: from an input, which has changed the text already (an input method's keys go there). */
function followCaret(changed = false): void {
  const el = textarea.value
  if (!el || following !== undefined) return
  const state = (area: HTMLTextAreaElement) => [area.value, area.selectionStart, area.selectionEnd].join('|')
  const before = changed ? null : state(el)
  const nextFrame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number
  const settle = (): void => {
    following = nextFrame(() => {
      // A long text's colours are drawn a frame later (THROTTLE_FROM): wait for them.
      if (highlighted.value !== model.value) return settle()
      void nextTick(() => {
        following = undefined
        const now = textarea.value
        if (!now || state(now) === before) return
        keepInSight(caretAt(now))
        // The colours of a long text came a frame after the list was placed.
        placeList()
      })
    }) as number
  }
  settle()
}
onBeforeUnmount(() => {
  if (following !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(following)
})
function keepInSight(at: number): void {
  const box = scroller.value
  const drawn = box && drawnAt(at)
  if (!box || !drawn) return
  const top = box.getBoundingClientRect().top
  if (drawn.top < top) box.scrollTop -= top - drawn.top + TEXT_PADDING
  else if (drawn.bottom > top + box.clientHeight)
    box.scrollTop += drawn.bottom - (top + box.clientHeight) + TEXT_PADDING
}
const caretAt = (el: HTMLTextAreaElement) =>
  el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd

/**
 * Review 2026-11-07: a text replaced from outside (the owner's undo and redo, Format) put the
 * browser's caret at its end, and the box followed it there. A multi-line field's caret goes to where
 * the text changed instead — after the change when it is on one line (a word typed back), at its start
 * when it spans lines (a document written again in shape) — and the box shows that place. One-line
 * fields keep the browser's caret at the end, where one goes on typing.
 */
function caretForChange(before: string, after: string): number {
  let from = 0
  const most = Math.min(before.length, after.length)
  while (from < most && before[from] === after[from]) from++
  let same = 0
  while (same < most - from && before[before.length - 1 - same] === after[after.length - 1 - same]) same++
  const to = after.length - same
  return after.slice(from, to).includes(NEWLINE) ? from : to
}
watch(model, (now) => {
  const el = textarea.value
  // What the field holds yet is the text before (the render writes the new one): typed text is in it.
  if (!el || !props.multiline || el.value === now) return
  const before = el.value
  void nextTick(() => {
    const area = textarea.value
    if (!area) return
    const at = caretForChange(before, area.value)
    area.setSelectionRange(at, at)
    trackCaret()
    followCaret(true)
  })
})

/**
 * The box changed size (an error shown under it, the window, the user's handle): the caret being
 * typed at stays in sight (review 2026-11-07: the first key that made a document invalid hid it).
 * The box's style tells when the user dragged its handle (see `resized`).
 */
let sizeWatch: ResizeObserver | undefined
let styleWatch: MutationObserver | undefined
onMounted(() => {
  const el = textarea.value
  const box = scroller.value
  // A new multi-line field starts at the beginning of its text: Tab into it showed its end.
  if (el && props.multiline && document.activeElement !== el) el.setSelectionRange(0, 0)
  if (!box) return
  if (typeof ResizeObserver === 'function') {
    sizeWatch = new ResizeObserver(() => {
      const now = textarea.value
      if (now && document.activeElement === now) keepInSight(caretAt(now))
    })
    sizeWatch.observe(box)
  }
  if (props.multiline && !props.fill && typeof MutationObserver === 'function') {
    styleWatch = new MutationObserver(() => {
      if (scroller.value?.style.height) resized.value = true
    })
    styleWatch.observe(box, { attributes: true, attributeFilter: ['style'] })
  }
})
onBeforeUnmount(() => {
  sizeWatch?.disconnect()
  styleWatch?.disconnect()
})

/**
 * Review 2026-11-07: the suggestions open at the caret — under its line, or over it when the window
 * has no room below — on the page's top layer, so no card, dialog or page that clips its content cuts
 * them off. They follow the caret as its box or the page scrolls, and close once it is out of sight.
 */
const list = ref<HTMLElement | null>(null)
const LIST_MOST = 240
const LIST_GAP = 4
const WINDOW_EDGE = 8
/** The list's padding and an item's, so its text starts under the word being completed. */
const ITEM_INSET = 16
const listPlace = ref({ top: 0, left: 0, maxHeight: LIST_MOST })
/** Where the caret is drawn: after the character before it, or before the one at it on a new line. */
function caretBox(at: number): { top: number; bottom: number; left: number } | null {
  const text = textarea.value?.value ?? ''
  if (at > 0 && text[at - 1] !== NEWLINE) {
    const drawn = drawnAt(at - 1)
    return drawn && { top: drawn.top, bottom: drawn.bottom, left: drawn.right }
  }
  const drawn = drawnAt(at)
  return drawn && { top: drawn.top, bottom: drawn.bottom, left: drawn.left }
}
function placeList(closeOutOfSight = false): void {
  const el = textarea.value
  const box = scroller.value
  const panel = list.value
  if (!open.value || !el || !box || !panel) return
  const caret = caretBox(caretAt(el))
  if (!caret) return
  const frame = box.getBoundingClientRect()
  const outOfSight =
    caret.bottom <= frame.top ||
    caret.top >= frame.bottom ||
    caret.bottom <= 0 ||
    caret.top >= window.innerHeight
  if (closeOutOfSight && outOfSight) return closeCompletions()
  const wanted = Math.min(LIST_MOST, panel.scrollHeight)
  const below = window.innerHeight - caret.bottom - LIST_GAP - WINDOW_EDGE
  const above = caret.top - LIST_GAP - WINDOW_EDGE
  const down = below >= wanted || below >= above
  const maxHeight = Math.max(0, Math.min(LIST_MOST, down ? below : above))
  const top = down ? caret.bottom + LIST_GAP : caret.top - LIST_GAP - Math.min(wanted, maxHeight)
  const right = window.innerWidth - panel.offsetWidth - WINDOW_EDGE
  const left = Math.max(WINDOW_EDGE, Math.min(caret.left - ITEM_INSET, right))
  listPlace.value = { top, left, maxHeight }
}
function onScrollAround(event: Event): void {
  // The list's own scrolling moves no caret.
  if (event.target instanceof Node && list.value?.contains(event.target)) return
  placeList(true)
}
const onWindowResize = () => placeList(true)
function listenAround(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  window[method]('scroll', onScrollAround, true)
  window[method]('resize', onWindowResize)
}
watch(open, listenAround)
onBeforeUnmount(() => listenAround(false))
// Placed after the render that showed it or changed its items, before the page is painted.
watch([open, matches], () => placeList(), { flush: 'post' })
// Turned read-only (a save started) with the list open: nothing more is offered.
watch(
  () => props.readonly,
  (readonly) => readonly && closeCompletions(),
)

function onInput(event: Event): void {
  model.value = (event.target as HTMLTextAreaElement).value
  dismissed = false
  updateCompletions()
  followCaret(true)
}

function onKeydown(event: KeyboardEvent): void {
  followCaret()
  const el = textarea.value!
  // Keys pressed while an input method composes text belong to the IME.
  if (event.isComposing || event.keyCode === 229) return
  // Shown, not typed in (a save in flight): no key changes the text, the owner's undo neither, and
  // nothing is offered or sent; the caret still moves, and Tab leaves as from any field (review
  // 2026-11-07).
  if (props.readonly) {
    if ((event.ctrlKey || event.metaKey) && ['z', 'y', ' '].includes(event.key.toLowerCase()))
      event.preventDefault()
    return
  }
  if (props.historyKeys && (event.ctrlKey || event.metaKey) && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'z' || key === 'y') {
      event.preventDefault()
      if (key === 'y' || event.shiftKey) emit('redo')
      else emit('undo')
      return
    }
  }
  // Ctrl+Space lists what can be written here, even before anything is typed.
  if (event.key === ' ' && (event.ctrlKey || event.metaKey) && !event.altKey) {
    event.preventDefault()
    updateCompletions(true)
    return
  }
  if (open.value) {
    const count = matches.value.length
    if (event.key === 'ArrowDown') active.value = (active.value + 1) % count
    else if (event.key === 'ArrowUp') active.value = (active.value - 1 + count) % count
    else if (event.key === 'Enter' || event.key === 'Tab') accept()
    else if (event.key === 'Escape') {
      closeCompletions()
      dismissed = true
      event.stopPropagation()
    } else return void updateAfterKey()
    event.preventDefault()
    return
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || !props.multiline)) {
    event.preventDefault()
    emit('submit')
    return
  }
  if (event.key === 'Enter' && props.multiline && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    escapeArmed = false
    newLine()
    return
  }
  if (event.key === 'Escape') {
    // Escape then Tab leaves a multi-line field (Tab alone indents). The first Escape stays here so a
    // dialog does not close; a second one is passed on.
    if (props.multiline && !escapeArmed) {
      escapeArmed = true
      event.stopPropagation()
    }
    return
  }
  if (event.key === 'Tab') {
    // User request 2026-11-07: Tab completes the word before the caret even while no list shows (the
    // caret put there by a click or the arrow keys); after Escape, or where nothing fits, it does
    // what it did.
    if (!event.shiftKey && !escapeArmed && !dismissed && el.selectionStart === el.selectionEnd) {
      updateCompletions()
      if (open.value && valueFrom.value === null) {
        event.preventDefault()
        accept(0)
        return
      }
      closeCompletions()
    }
    dismissed = false
    if (props.multiline && !event.shiftKey && !escapeArmed) {
      event.preventDefault()
      replaceRange(el.selectionStart, el.selectionEnd, '  ')
    }
    escapeArmed = false
    return
  }
  escapeArmed = false
  dismissed = false
  // AltGr (Ctrl+Alt on Windows) types { [ ] } on many layouts, e.g. Turkish Q.
  const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')
  if ((event.ctrlKey || event.metaKey || event.altKey) && !altGraph) return
  const { selectionStart: start, selectionEnd: end, value } = el
  if (CLOSERS.has(event.key) && start === end && value[start] === event.key) {
    event.preventDefault()
    el.setSelectionRange(start + 1, start + 1)
    updateCompletions()
    return
  }
  const close = PAIRS[event.key]
  if (close) {
    const quote = event.key === '"' || event.key === "'"
    if (!quote || start !== end || /^[\s,:}\])]?$/.test(value[start] ?? '')) {
      event.preventDefault()
      replaceRange(start, end, event.key + value.slice(start, end) + close, end + 1)
    }
    return
  }
  if (event.key === 'Backspace' && start === end && start > 0 && PAIRS[value[start - 1]!] === value[start]) {
    event.preventDefault()
    replaceRange(start - 1, start + 1, '')
  }
}

/**
 * User report 2026-11-05: Enter in a multi-line field starts the new line at the indentation of the
 * one it leaves, one level in after an opening bracket, and between a pair puts the closer on a line
 * of its own; the spaces before the caret go.
 */
function newLine(): void {
  const el = textarea.value!
  const { selectionStart: start, selectionEnd: end, value } = el
  let from = start
  while (from > 0 && (value[from - 1] === ' ' || value[from - 1] === '\t')) from--
  const lineStart = value.lastIndexOf(NEWLINE, from - 1) + 1
  const indent = /^[ \t]*/.exec(value.slice(lineStart, start))![0]
  const opener = value[from - 1] ?? ''
  const opens = opener === '{' || opener === '[' || opener === '('
  const inner = opens ? `${indent}  ` : indent
  const closes = opens && value[end] === PAIRS[opener]
  const text = NEWLINE + inner + (closes ? NEWLINE + indent : '')
  replaceRange(from, end, text, from + 1 + inner.length)
  trackCaret()
}

// Keep the active suggestion visible in the scrolling list. Only the list scrolls: the item's
// scrollIntoView moved every box around it too, the document page with it (review 2026-11-07).
watch(active, async (index) => {
  await nextTick()
  const panel = list.value
  const item = document.getElementById(`${listId}-${index}`)
  if (!panel || !item) return
  if (item.offsetTop < panel.scrollTop) panel.scrollTop = item.offsetTop
  else if (item.offsetTop + item.offsetHeight > panel.scrollTop + panel.clientHeight)
    panel.scrollTop = item.offsetTop + item.offsetHeight - panel.clientHeight
})

/** Arrow keys and similar move the caret: refresh the suggestions after the browser applied them. */
function updateAfterKey(): void {
  queueMicrotask(updateCompletions)
}

/**
 * UI redesign R1 review: Windows selects the space after a double-clicked word too; in code that space
 * is never meant (a quote typed next would wrap it), so the selection ends with the word.
 */
function onDoubleClick(): void {
  const el = textarea.value
  if (!el) return
  const { selectionStart: start, value } = el
  let end = el.selectionEnd
  while (end > start && /\s/.test(value[end - 1]!)) end--
  if (end !== el.selectionEnd) el.setSelectionRange(start, end)
  trackCaret()
}

/** A click moves the caret away from the word being completed: the suggestions close (final review M5). */
function onClick(): void {
  trackCaret()
  if (open.value) closeCompletions()
}
</script>

<template>
  <div class="flex flex-col gap-1.5" :class="fill ? 'h-full min-h-0' : ''">
    <label :for="id" class="text-small font-medium text-fg" :class="hideLabel ? 'sr-only' : ''">
      {{ label }}
    </label>
    <div
      class="relative font-mono text-[12.5px] leading-5"
      :class="[
        fill ? 'min-h-0 flex-1' : '',
        bare
          ? ''
          : [
              'rounded-lg border bg-surface shadow-xs transition-[border-color,box-shadow] duration-120 ease-out-soft focus-within:ring-3',
              error
                ? 'border-danger focus-within:ring-danger/20'
                : 'border-line-strong focus-within:border-focus focus-within:ring-focus/20',
            ],
      ]"
    >
      <!-- User report 2026-11-05 (scrolling froze): the field and its colours in one scrolling box,
           which the browser moves as one. The field is as tall as its text (the grid's one cell, as
           tall as the colours, which draw the same text) and never scrolls by itself. The cell is at
           least as tall as the text and grows to fill the box: with the box's height as its least
           (minmax(100%, auto)) it stayed that height, and the end of a long text could be scrolled
           to but not clicked (user report 2026-11-07). The box is as tall as the cell, between its
           rows and a limit (boxStyle), or as the user drags it. -->
      <div
        ref="scroller"
        data-code-scroller
        class="grid grid-cols-1 grid-rows-[minmax(max-content,100%)] overflow-y-auto [scrollbar-gutter:stable]"
        :class="fill ? 'h-full' : multiline ? 'resize-y' : ''"
        :style="boxStyle"
      >
        <pre
          ref="mirror"
          aria-hidden="true"
          class="pointer-events-none col-start-1 row-start-1 m-0 min-w-0 px-3 py-2 break-words whitespace-pre-wrap"
        ><span
        v-for="chunk in chunks"
        :key="chunk.id"
        v-memo="[chunk, chunk.marked ? currentMark : -1]"
      ><template v-for="(piece, i) in chunk.pieces" :key="i"><mark
        v-if="piece.mark >= 0"
        data-search-mark
        :data-current="piece.mark === currentMark ? '' : undefined"
        :class="[TOKEN_CLASSES[piece.type], piece.mark === currentMark ? SEARCH_CURRENT : SEARCH_MARK]"
        :data-bracket="piece.bracket ? '' : undefined"
      >{{ piece.text }}</mark><span
        v-else
        :class="[TOKEN_CLASSES[piece.type], piece.bracket ? 'rounded-sm bg-accent-soft' : '']"
        :data-bracket="piece.bracket ? '' : undefined"
      >{{ piece.text }}</span></template></span>{{ '\n' }}</pre>
        <textarea
          :id="id"
          ref="textarea"
          :value="model"
          :rows="leastRows"
          :placeholder="placeholder"
          :readonly="readonly"
          :aria-readonly="readonly ? 'true' : undefined"
          :aria-keyshortcuts="keyshortcuts"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          aria-autocomplete="list"
          :aria-expanded="open"
          :aria-controls="open ? listId : undefined"
          :aria-activedescendant="open ? `${listId}-${active}` : undefined"
          :aria-invalid="error ? 'true' : undefined"
          :aria-describedby="error ? `${id}-error` : hint ? `${id}-hint` : undefined"
          class="col-start-1 row-start-1 block h-full min-w-0 resize-none overflow-hidden bg-transparent px-3 py-2 break-words whitespace-pre-wrap text-transparent caret-fg placeholder:text-fg-subtle focus:outline-none focus-visible:outline-none"
          @input="onInput"
          @keydown="onKeydown"
          @keyup="trackCaret"
          @click="onClick"
          @dblclick="onDoubleClick"
          @select="trackCaret"
          @blur="closeCompletions"
        />
      </div>
      <!-- A press on the list (its scrollbar too) leaves the focus in the field. -->
      <Teleport to="body">
        <ul
          v-if="open"
          :id="listId"
          ref="list"
          role="listbox"
          :aria-label="t('code.completions')"
          data-ds-popup
          class="fixed z-[55] w-72 max-w-[calc(100vw-1rem)] overflow-auto rounded-xl bg-raised p-1 font-sans shadow-float"
          :style="{
            top: `${listPlace.top}px`,
            left: `${listPlace.left}px`,
            maxHeight: `${listPlace.maxHeight}px`,
          }"
          @mousedown.prevent
        >
          <li
            v-for="(item, i) in matches"
            :id="`${listId}-${i}`"
            :key="`${item.kind}:${item.label}`"
            role="option"
            :aria-selected="i === active"
            class="flex cursor-pointer items-center justify-between gap-3 px-3 py-1 font-mono text-small"
            :class="i === active ? 'rounded-md bg-accent-soft text-accent-fg' : 'text-fg'"
            @mousedown.prevent="accept(i)"
          >
            <span class="truncate">{{ item.label }}</span>
            <span class="shrink-0 font-sans text-fg-subtle">{{ t(`code.kinds.${item.kind}`) }}</span>
          </li>
        </ul>
      </Teleport>
    </div>
    <p v-if="error" :id="`${id}-error`" class="text-small text-danger">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
  </div>
</template>
