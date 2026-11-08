<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, provide, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Code, FilePlus2, ListPlus, TextCursorInput, Trash2 } from 'lucide-vue-next'
import { documentDiff } from '@mongo-manager/shared/browser'
import type { DsMenuItem } from '@/ds/menu'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { editableDate, editableType, lineBreaks, parseScalar } from '../scalarEdit'
import type { DocMatch } from './search'
import {
  TREE_FOCUS,
  closedState,
  dottedPath,
  flattenTree,
  openAll as openEverything,
  pathKey,
  revealPaths,
  showMore as showMoreOf,
  type FieldLine,
  type TreeState,
} from './treeModel'
import { addField, addItem, removeAt, renameAt, setAt, type OpResult } from './draftOps'
import type { EditorInput, EditorKind } from './TreeValueEditor.vue'
import DocumentTreeLine from './DocumentTreeLine.vue'

/**
 * Document page design §6.4, §6.5, §6.9 (user request 2026-11-04): the document as a tree the width
 * of the page — walked by keyboard (a WAI-ARIA tree), a search's matches marked and the rest dimmed,
 * and, where the user may write, edited in place: a value, a key's name, a field or an item added or
 * taken out. Each edit is an operation on the draft (draftOps); _id and hidden values are never
 * offered, and the server checks everything again when the draft is saved.
 */
const props = defineProps<{
  doc: Record<string, unknown>
  /** The version opened: lines that differ from it are marked as changed. */
  base: Record<string, unknown>
  editable: boolean
  matches: readonly DocMatch[]
  /** The match the search is at (an index into `matches`), or -1. */
  current: number
  isMasked: (path: readonly string[]) => boolean
}>()
const emit = defineEmits<{
  change: [doc: Record<string, unknown>]
  editText: [path: readonly string[]]
  select: [path: readonly string[]]
}>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()

const state = shallowRef<TreeState>(closedState())
const lines = computed(() => flattenTree(props.doc, state.value))
const fieldLines = computed(() => lines.value.filter((l): l is FieldLine => !('more' in l)))
const focusKey = ref<string | null>(null)
// Final review minor: a line closed away (Close all, a parent folded) hands the focus to the first,
// so the tree stays one Tab stop.
const focused = computed(() => {
  const key = focusKey.value
  return key && fieldLines.value.some((l) => l.key === key) ? key : (fieldLines.value[0]?.key ?? null)
})
// Review 2026-11-07 (performance): each line reads the focus itself; the tree is not rendered again
// for a move of it.
provide(TREE_FOCUS, focused)
const root = ref<HTMLElement | null>(null)

// ---- the search: marks, dimming, and the way to the current match
const marksOf = computed(() => {
  const byLine = new Map<
    string,
    { key?: DocMatch & { current: boolean }; value?: DocMatch & { current: boolean } }
  >()
  props.matches.forEach((m, i) => {
    const k = pathKey(m.path)
    const entry = byLine.get(k) ?? {}
    entry[m.part] = { ...m, current: i === props.current }
    byLine.set(k, entry)
  })
  return byLine
})
/** Every line on the way to a match: these are not dimmed. */
const lit = computed(() => {
  const keys = new Set<string>()
  for (const m of props.matches)
    for (let i = 1; i <= m.path.length; i++) keys.add(pathKey(m.path.slice(0, i)))
  return keys
})
// Final review minor: only a move to another match reveals it — an edit elsewhere (new matches, the
// same current one) leaves the view where it is.
const currentMatch = computed(() => {
  const match = props.matches[props.current]
  return match ? `${pathKey(match.path)}:${match.part}` : null
})
watch(
  currentMatch,
  () => {
    const match = props.matches[props.current]
    if (!match) return
    state.value = revealPaths(props.doc, state.value, [match.path])
    void nextTick(() => lineEl(pathKey(match.path))?.scrollIntoView?.({ block: 'center' }))
  },
  { immediate: true },
)

// ---- what the draft changed, against the version opened
const changed = computed(() => {
  if (props.doc === props.base) return { exact: new Set<string>(), whole: [] as string[] }
  const diff = documentDiff(props.base, props.doc)
  if (diff.kind === 'none') return { exact: new Set<string>(), whole: [] as string[] }
  const exact = new Set<string>()
  for (const change of diff.changes) {
    const parts = change.path.split('.')
    for (let i = 1; i <= parts.length; i++) exact.add(parts.slice(0, i).join('.'))
  }
  return { exact, whole: diff.changes.map((c) => c.path) }
})
const isChanged = (line: FieldLine): boolean => {
  const dotted = dottedPath(line.path)
  return changed.value.exact.has(dotted) || changed.value.whole.some((p) => dotted.startsWith(`${p}.`))
}

// ---- what may be done with a line
const isId = (line: FieldLine) => line.path[0] === '_id'
const hidden = (line: FieldLine) => props.isMasked(line.path)
const locked = (line: FieldLine) => !props.editable || isId(line) || hidden(line)
const inArray = (line: FieldLine) => line.parentType === 'array'
/**
 * A value the tree edits in place. Review 2026-11-07: a string mixing kinds of line break would lose
 * them in a text box; the text shows each one.
 */
const inPlace = (line: FieldLine) =>
  editableType(line.type) && !(line.type === 'string' && lineBreaks(line.value as string) === 'mixed')
const canEditValue = (line: FieldLine) => !locked(line) && !line.container && inPlace(line) && readable(line)
/** Review 2026-11-07: a date JavaScript cannot hold has lost its time; it is changed in the shell. */
const readable = (line: FieldLine) => editableDate(line.value)
const menuFor = (line: FieldLine): DsMenuItem[] => {
  if (locked(line)) return []
  return [
    ...(line.type === 'object'
      ? [{ id: 'addField', label: t('documents.docPage.addField'), icon: FilePlus2 }]
      : []),
    ...(line.type === 'array'
      ? [{ id: 'addItem', label: t('documents.docPage.addItem'), icon: ListPlus }]
      : []),
    ...(!inArray(line)
      ? [{ id: 'rename', label: t('documents.docPage.rename'), icon: TextCursorInput }]
      : []),
    ...(!line.container && !inPlace(line) && readable(line)
      ? [{ id: 'editInText', label: t('documents.docPage.editInText'), icon: Code }]
      : []),
    { id: 'remove', label: t('documents.docPage.removeField'), icon: Trash2, danger: true, separator: true },
  ]
}
// Final review I7: each line's menu once per change of the lines, not once per render.
const menus = computed(() => new Map(fieldLines.value.map((l) => [l.key, menuFor(l)])))
const NO_ITEMS: DsMenuItem[] = []
const lineMenus = new Map<string, { openMenu: () => Promise<unknown> }>()

// ---- editing in place
const editing = ref<{ key: string; kind: EditorKind; error: string } | null>(null)
const lineOf = (key: string) => fieldLines.value.find((l) => l.key === key)

function startEdit(line: FieldLine, kind: EditorKind): void {
  if (locked(line)) return
  if (kind === 'value' && !canEditValue(line)) {
    if (!readable(line))
      toasts.push({
        kind: 'error',
        message: t('documents.notRoundTrip.bad_date', { field: dottedPath(line.path) }),
      })
    else if (!line.container) emit('editText', line.path)
    return
  }
  if (kind === 'rename' && inArray(line)) return
  if (kind === 'field' || kind === 'item')
    state.value = { ...state.value, open: new Set([...state.value.open, line.key]) }
  editing.value = { key: line.key, kind, error: '' }
}

function valueOf(input: EditorInput): { ok: true; value: unknown } | { ok: false; error: string } {
  if (input.type === 'object') return { ok: true, value: {} }
  if (input.type === 'array') return { ok: true, value: [] }
  const parsed = parseScalar(input.type, input.text)
  return parsed.ok ? parsed : { ok: false, error: t(`documents.inline.invalid.${parsed.error}`) }
}

function finish(result: OpResult, key: string): void {
  if (!result.ok) {
    if (editing.value)
      editing.value = { ...editing.value, error: t(`documents.docPage.keyErrors.${result.error}`) }
    return
  }
  editing.value = null
  emit('change', result.doc)
  focusLine(key)
}

function apply(input: EditorInput): void {
  const edit = editing.value
  const line = edit && lineOf(edit.key)
  if (!edit || !line) return
  if (edit.kind === 'rename') {
    const renamed = [...line.path.slice(0, -1), input.key]
    return finish(renameAt(props.doc, line.path, input.key, props.isMasked), pathKey(renamed))
  }
  const value = valueOf(input)
  if (!value.ok) {
    editing.value = { ...edit, error: value.error }
    return
  }
  if (edit.kind === 'value') return finish(setAt(props.doc, line.path, value.value, props.isMasked), line.key)
  if (edit.kind === 'field')
    return finish(addField(props.doc, line.path, input.key, value.value, props.isMasked), line.key)
  finish(addItem(props.doc, line.path, value.value, props.isMasked), line.key)
}

async function remove(line: FieldLine): Promise<void> {
  if (locked(line)) return
  const ok = await dialogs.confirm({
    title: t('documents.docPage.removeTitle', { name: line.name }),
    message: t('documents.docPage.removeMessage'),
    confirmLabel: t('documents.docPage.removeField'),
    danger: true,
  })
  if (!ok) return
  const result = removeAt(props.doc, line.path, props.isMasked)
  if (!result.ok) {
    toasts.push({ kind: 'error', message: t(`documents.docPage.keyErrors.${result.error}`) })
    return
  }
  emit('change', result.doc)
  focusLine(pathKey(placeAfterRemoval(result.doc, line)))
}

/**
 * Review 2026-11-07: where the focus goes once a line is taken out — the entry that took its place
 * among its siblings (in an array, the next item now has its index), else the one before it, else
 * what held it. Found in the new document: the lines listed before it held entries now gone.
 */
function placeAfterRemoval(doc: Record<string, unknown>, line: FieldLine): readonly string[] {
  const parent = line.path.slice(0, -1)
  let holder: unknown = doc
  for (const name of parent) holder = (holder as Record<string, unknown>)[name]
  const names = Array.isArray(holder) ? holder.map((_, i) => String(i)) : Object.keys(holder as object)
  const name = names[line.index - 1] ?? names[line.index - 2]
  return name === undefined ? parent : [...parent, name]
}

function onMenu(line: FieldLine, id: string): void {
  if (id === 'addField') startEdit(line, 'field')
  else if (id === 'addItem') startEdit(line, 'item')
  else if (id === 'rename') startEdit(line, 'rename')
  else if (id === 'editInText') emit('editText', line.path)
  else if (id === 'remove') void remove(line)
}

// ---- opening, focus and the keyboard
function toggle(line: FieldLine, open = !line.open): void {
  const next = new Set(state.value.open)
  if (open) next.add(line.key)
  else next.delete(line.key)
  state.value = { ...state.value, open: next }
}
function showMore(path: readonly string[], place: 'gap' | 'end'): void {
  state.value = showMoreOf(state.value, path, place)
}
// A key is a JSON array (quotes, brackets): compared, not put in a selector.
const lineEl = (key: string) =>
  [...(root.value?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(
    (el) => el.dataset.key === key,
  ) ?? null
function focusLine(key: string): void {
  focusKey.value = key
  void nextTick(() => lineEl(key)?.focus())
}
watch(focused, (key) => {
  const line = key ? lineOf(key) : undefined
  if (line) emit('select', line.path)
})

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  const el = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
  const line = el && lineOf(el.dataset.key!)
  if (!line || (event.target as HTMLElement).closest('[data-tree-editor], [data-tree-actions]')) return
  const all = fieldLines.value
  const at = all.indexOf(line)
  const go = (target: FieldLine | undefined) => {
    if (target) focusLine(target.key)
  }
  switch (event.key) {
    case 'ArrowDown':
      go(all[at + 1])
      break
    case 'ArrowUp':
      go(all[at - 1])
      break
    case 'Home':
      go(all[0])
      break
    case 'End':
      go(all.at(-1))
      break
    case 'ArrowRight':
      if (line.container && !line.open) toggle(line, true)
      else if (line.container && line.size) go(all[at + 1])
      break
    case 'ArrowLeft':
      if (line.container && line.open) toggle(line, false)
      else if (line.depth > 0) go(lineOf(pathKey(line.path.slice(0, -1))))
      break
    case 'Enter':
      if (line.container) toggle(line)
      else startEdit(line, 'value')
      break
    case 'F2':
      startEdit(line, 'rename')
      break
    case 'F10':
    case 'ContextMenu':
      // Final review I6: the line is the Tab stop; its menu opens from it (Shift+F10, the Menu key).
      if (event.key === 'F10' && !event.shiftKey) return
      void lineMenus.get(line.key)?.openMenu()
      break
    case 'Delete':
      void remove(line)
      break
    default:
      return
  }
  event.preventDefault()
}

defineExpose({
  openAll(): void {
    state.value = { ...state.value, open: openEverything(props.doc) }
  },
  closeAll(): void {
    state.value = closedState()
  },
  reveal(path: readonly string[]): void {
    state.value = revealPaths(props.doc, state.value, [path])
    focusLine(pathKey(path))
  },
  focusTree(): void {
    if (focused.value) focusLine(focused.value)
  },
})
</script>

<template>
  <ul
    ref="root"
    role="tree"
    :aria-label="t('documents.docPage.tree')"
    class="min-w-0 py-1"
    @keydown="onKeydown"
  >
    <template v-for="line in lines" :key="line.key">
      <li v-if="'more' in line" role="none" :style="{ paddingLeft: `${line.depth * 16 + 28}px` }">
        <button
          type="button"
          :data-show-more="line.place"
          class="cursor-pointer py-0.5 text-small text-accent-fg hover:underline"
          @click="showMore(line.path, line.place)"
        >
          {{ t('documents.showMore', { count: line.remaining }) }}
        </button>
      </li>
      <DocumentTreeLine
        v-else
        :ref="(el) => (el ? lineMenus.set(line.key, el as never) : lineMenus.delete(line.key))"
        :line="line"
        :marks="marksOf.get(line.key)"
        :dimmed="!!matches.length && !lit.has(line.key)"
        :changed="isChanged(line)"
        :hidden="hidden(line)"
        :locked="locked(line)"
        :can-edit="canEditValue(line)"
        :menu="menus.get(line.key) ?? NO_ITEMS"
        :editing="editing && editing.key === line.key ? editing : null"
        @focus="focusKey = line.key"
        @toggle="toggle(line)"
        @edit="startEdit(line, $event)"
        @menu="onMenu(line, $event)"
        @apply="apply"
        @cancel="((editing = null), focusLine(line.key))"
      />
    </template>
  </ul>
</template>
