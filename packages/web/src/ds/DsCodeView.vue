<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from 'lucide-vue-next'
import { tokenize, type Token } from './code/tokenize'
import { TOKEN_CLASSES } from './code/tokenClasses'
import { byteSize } from './code/size'
import {
  HIGHLIGHT_LIMIT,
  SEARCH_CURRENT,
  SEARCH_MARK,
  chunkPieces,
  splitPieces,
  type PieceChunk,
} from './code/marks'

const props = defineProps<{
  text: string
  /**
   * W5: a string token that stands for a hidden value. It is shown as "***" with a lock and the
   * label (a tooltip and screen-reader text), as the table shows a hidden cell.
   */
  hidden?: { token: string; label: string }
  /** Document page design §6.7: a search's matches, as [from, to) offsets in `text`, in order. */
  marks?: ReadonlyArray<readonly [number, number]>
  /** The match the search is at (an index into `marks`). */
  currentMark?: number
}>()
const { t, locale } = useI18n()
/**
 * User report 2026-11-05: a string longer than this (an image as base64) shows its start and a
 * button that shows it all; its thousands of lines dragged the scrolling.
 */
const FOLD_FROM = 2_000
const FOLD_HEAD = 160
/** A string literal longer than FOLD_FROM, in a text too long to highlight. */
const LONG_STRING = /"(?:[^"\\\n]|\\.){2000,}"|'(?:[^'\\\n]|\\.){2000,}'/g
/**
 * Past the limit the text is shown plain; a hidden value is still cut out of it as its own token, so
 * it shows as *** with its lock, never as the mark that stands for it (review I5), and a long string
 * too, to be folded.
 */
function plain(text: string): Token[] {
  const mark = props.hidden?.token
  const parts = (part: string): Token[] =>
    !mark || !part.includes(mark)
      ? part
        ? [{ type: 'text', text: part }]
        : []
      : part
          .split(mark)
          .flatMap((piece, i): Token[] => [
            ...(i > 0 ? [{ type: 'string' as const, text: mark }] : []),
            ...(piece ? [{ type: 'text' as const, text: piece }] : []),
          ])
  const out: Token[] = []
  let at = 0
  for (const found of text.matchAll(LONG_STRING)) {
    out.push(...parts(text.slice(at, found.index)), { type: 'string', text: found[0] })
    at = found.index + found[0].length
  }
  out.push(...parts(text.slice(at)))
  return out
}
const tokens = computed<Token[]>(() =>
  props.text.length > HIGHLIGHT_LIMIT ? plain(props.text) : tokenize(props.text),
)
/** What a hidden value reads as: the server's mask, quoted as the string it is. */
const SHOWN = JSON.stringify('***')
const isHidden = (token: Token) => token.type === 'string' && token.text === props.hidden?.token

/** The long strings shown whole, by where they start; a new text folds them again. */
const expanded = ref(new Set<number>())
watch(
  () => props.text,
  () => (expanded.value = new Set()),
)
/**
 * The tokens with each long string folded to its start — never one a search match is in — and the
 * matches moved by what the folds took out before them.
 */
const folded = computed(() => {
  const marks = props.marks ?? []
  const out: Array<Token & { fold?: { at: number; size: string } }> = []
  /** Where each fold ends in the text, and how much the folds took out up to there. */
  const cuts: Array<[number, number]> = []
  let offset = 0
  let removed = 0
  let m = 0
  for (const token of tokens.value) {
    const start = offset
    const end = (offset += token.text.length)
    if (
      token.type !== 'string' ||
      token.text.length <= FOLD_FROM ||
      isHidden(token) ||
      expanded.value.has(start)
    ) {
      out.push(token)
      continue
    }
    while (m < marks.length && marks[m]![1] <= start) m++
    if (m < marks.length && marks[m]![0] < end) {
      out.push(token)
      continue
    }
    const head = `${token.text.slice(0, FOLD_HEAD)}…`
    out.push({ type: token.type, text: head, fold: { at: start, size: byteSize(token.text) } })
    removed += token.text.length - head.length
    cuts.push([end, removed])
  }
  if (!cuts.length) return { tokens: out, marks: props.marks }
  let c = -1
  const moved = marks.map(([from, to]): [number, number] => {
    while (c + 1 < cuts.length && cuts[c + 1]![0] <= from) c++
    const by = c >= 0 ? cuts[c]![1] : 0
    return [from - by, to - by]
  })
  return { tokens: out, marks: moved }
})
const pieces = computed(() =>
  splitPieces(folded.value.tokens, {
    marks: folded.value.marks,
    whole: (token) => isHidden(token) || 'fold' in token,
  }),
)
function showLong(at: number): void {
  expanded.value = new Set([...expanded.value, at])
}
/** The pieces in chunks of lines: a new search mark draws again only the chunks it is in (v-memo). */
let drawn: PieceChunk[] = []
const chunks = computed(() => (drawn = chunkPieces(pieces.value, drawn)))
</script>

<template>
  <pre class="m-0 font-mono text-small leading-5 break-words whitespace-pre-wrap"><span
    v-for="chunk in chunks"
    :key="chunk.id"
    v-memo="[chunk, chunk.marked ? currentMark : -1, hidden?.label, locale]"
  ><template
    v-for="(token, i) in chunk.pieces"
    :key="i"
  ><span
    v-if="isHidden(token)"
    data-masked
    class="inline-flex items-center gap-0.5 text-fg-subtle"
    :title="hidden!.label"
  ><Lock class="size-3" aria-hidden="true" /><span aria-hidden="true">{{ SHOWN }}</span><span class="sr-only">{{
    hidden!.label
  }}</span></span><mark
    v-else-if="token.mark >= 0"
    data-search-mark
    :data-current="token.mark === currentMark ? '' : undefined"
    :class="[TOKEN_CLASSES[token.type], token.mark === currentMark ? SEARCH_CURRENT : SEARCH_MARK]"
  >{{ token.text }}</mark><template v-else-if="token.fold"><span :class="TOKEN_CLASSES[token.type]">{{
    token.text
  }}</span><button
    type="button"
    data-show-long
    class="mx-1 cursor-pointer rounded-md bg-subtle px-1.5 font-sans text-caption text-fg-muted ring-1 ring-line hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
    @click="showLong(token.fold.at)"
  >{{ t('code.showLong', { size: token.fold.size }) }}</button></template><span
    v-else
    :class="TOKEN_CLASSES[token.type]"
  >{{ token.text }}</span></template></span></pre>
</template>
