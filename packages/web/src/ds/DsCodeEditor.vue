<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
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

/** One-line fields grow with their content (up to six lines) so a long filter stays visible. */
const MAX_AUTO_ROWS = 6
const visibleRows = computed(() =>
  props.multiline
    ? (props.rows ?? 4)
    : Math.min(MAX_AUTO_ROWS, Math.max(props.rows ?? 1, model.value.split('\n').length)),
)
/** The scrolling box's height: its rows of 1.25rem (leading-5) and the text's padding (py-2). */
const boxHeight = computed(() => (props.fill ? undefined : `calc(${visibleRows.value} * 1.25rem + 1rem)`))

const open = ref(false)
const matches = ref<Completion[]>([])
const active = ref(0)
let escapeArmed = false

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
  const el = textarea.value!
  listCaret = el.selectionStart
  const before = el.value.slice(0, el.selectionStart)
  // A value for a known field: the values seen for it (a started string or number, or on Ctrl+Space).
  if (props.values) {
    const prefix = VALUE_PREFIX.exec(before)![0]
    const ctx = contextAt(before.slice(0, before.length - prefix.length))
    if (ctx.position === 'value' && ctx.key && (prefix !== '' || force)) {
      const typed = fold(prefix.replace(/^'/, '"'))
      const found = props
        .values(ctx.key)
        .filter((v) => fold(v).startsWith(typed) && v !== prefix)
        .slice(0, force ? FORCED_MAX_ITEMS : 12)
      if (found.length > 0) {
        matches.value = found.map((label): Completion => ({ label, kind: 'value' }))
        valueFrom.value = before.length - prefix.length
        active.value = 0
        open.value = true
        return
      }
    }
  }
  valueFrom.value = null
  const list = props.completions ?? []
  const { word, start } = wordBeforeCaret()
  if (list.length === 0 || (word === '' && !force) || insideString()) return closeCompletions()
  replaceFrom.value = start
  const prefix = fold(word)
  // Ctrl+Space with nothing typed: what fits here first (field names where a key goes).
  const ctx = contextAt(before.slice(0, before.length - word.length))
  const fieldsFirst = ctx.position !== 'value'
  const rank = (c: Completion) => (c.kind === 'field' ? (fieldsFirst ? 0 : 2) : c.kind === 'operator' ? 1 : 3)
  matches.value = list
    .filter((c) => fold(c.label).startsWith(prefix) && c.label !== word)
    .sort((a, b) => (word === '' ? rank(a) - rank(b) : 0))
    .slice(0, word === '' ? FORCED_MAX_ITEMS : 12)
  active.value = 0
  open.value = matches.value.length > 0
}

/**
 * Programmatic edits go through the browser's editing command so Ctrl+Z undoes them like typing;
 * setRangeText is the fallback where that command is unavailable (it bypasses the undo stack).
 */
function replaceRange(start: number, end: number, text: string, caret = start + text.length): void {
  const el = textarea.value!
  el.focus()
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
}

defineExpose({
  /** Insert text at the selection, as typing would (undoable). */
  insert: (text: string): void => {
    const el = textarea.value
    if (!el) return
    replaceRange(el.selectionStart, el.selectionEnd, text)
    trackCaret()
  },
  focus: (): void => textarea.value?.focus(),
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
        keepInSight(now.selectionDirection === 'backward' ? now.selectionStart : now.selectionEnd)
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

function onInput(event: Event): void {
  model.value = (event.target as HTMLTextAreaElement).value
  updateCompletions()
  followCaret(true)
}

function onKeydown(event: KeyboardEvent): void {
  followCaret()
  const el = textarea.value!
  // Keys pressed while an input method composes text belong to the IME.
  if (event.isComposing || event.keyCode === 229) return
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
    if (props.multiline && !event.shiftKey && !escapeArmed) {
      event.preventDefault()
      replaceRange(el.selectionStart, el.selectionEnd, '  ')
    }
    escapeArmed = false
    return
  }
  escapeArmed = false
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

// Keep the active suggestion visible in the scrolling list.
watch(active, async (index) => {
  await nextTick()
  document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' })
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
           tall as the colours, which draw the same text) and never scrolls by itself. -->
      <div
        ref="scroller"
        data-code-scroller
        class="grid grid-cols-1 grid-rows-[minmax(100%,auto)] overflow-y-auto [scrollbar-gutter:stable]"
        :class="fill ? 'h-full' : multiline ? 'resize-y' : ''"
        :style="boxHeight ? { height: boxHeight } : undefined"
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
          :rows="visibleRows"
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
      <ul
        v-if="open"
        :id="listId"
        role="listbox"
        :aria-label="t('code.completions')"
        class="absolute top-full left-0 z-30 mt-1 max-h-60 w-72 overflow-auto rounded-xl bg-raised p-1 font-sans shadow-float"
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
    </div>
    <p v-if="error" :id="`${id}-error`" class="text-small text-danger">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
  </div>
</template>
