<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronRight,
  Code,
  FilePlus2,
  ListPlus,
  Lock,
  Pencil,
  TextCursorInput,
  Trash2,
} from 'lucide-vue-next'
import { documentDiff } from '@mongo-manager/shared/browser'
import DsMenu from '@/ds/DsMenu.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { DsMenuItem } from '@/ds/menu'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import PluginCellText from '@/plugins/PluginCellText.vue'
import ValueCell from '../ValueCell.vue'
import { valueTone } from '../valueTone'
import { editableType, parseScalar } from '../scalarEdit'
import { shownText, type DocMatch } from './search'
import {
  closedState,
  dottedPath,
  flattenTree,
  openAll as openEverything,
  pathKey,
  revealPaths,
  type TreeLine,
  type TreeState,
} from './treeModel'
import { addField, addItem, removeAt, renameAt, setAt, type OpResult } from './draftOps'
import MarkedText from './MarkedText.vue'
import TreeValueEditor, { type EditorInput, type EditorKind } from './TreeValueEditor.vue'

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

type FieldLine = Extract<TreeLine, { name: string }>
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
const canEditValue = (line: FieldLine) => !locked(line) && !line.container && editableType(line.type)
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
    ...(!line.container && !editableType(line.type)
      ? [{ id: 'editInText', label: t('documents.docPage.editInText'), icon: Code }]
      : []),
    { id: 'remove', label: t('documents.docPage.removeField'), icon: Trash2, danger: true, separator: true },
  ]
}
// Final review I7: each line's menu once per change of the lines, not once per render.
const menus = computed(() => new Map(fieldLines.value.map((l) => [l.key, menuFor(l)])))
const lineMenus = new Map<string, { openMenu: () => Promise<void> }>()

// ---- editing in place
const editing = ref<{ key: string; kind: EditorKind; error: string } | null>(null)
const lineOf = (key: string) => fieldLines.value.find((l) => l.key === key)

function startEdit(line: FieldLine, kind: EditorKind): void {
  if (locked(line)) return
  if (kind === 'value' && !canEditValue(line)) {
    if (!line.container) emit('editText', line.path)
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
  const at = fieldLines.value.indexOf(line)
  emit('change', result.doc)
  const next = fieldLines.value[at + 1] ?? fieldLines.value[at - 1]
  if (next) focusLine(next.key)
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
function showMore(path: readonly string[]): void {
  const shown = new Map(state.value.shown)
  const key = pathKey(path)
  shown.set(key, (shown.get(key) ?? 100) + 100)
  state.value = { ...state.value, shown }
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

/** A string is shown in quotes, as the shell writes it. */
const QUOTE = '"'
const quote = (line: FieldLine): string => (line.type === 'string' ? QUOTE : '')
const iconButton =
  'grid size-6 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-muted hover:text-fg'
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
          class="cursor-pointer py-0.5 text-small text-accent-fg hover:underline"
          @click="showMore(line.path)"
        >
          {{ t('documents.showMore', { count: line.remaining }) }}
        </button>
      </li>
      <li
        v-else
        role="treeitem"
        :data-key="line.key"
        :data-path="dottedPath(line.path)"
        :aria-level="line.depth + 1"
        :aria-posinset="line.index"
        :aria-setsize="line.setSize"
        :aria-expanded="line.container ? line.open : undefined"
        :aria-selected="line.key === focused"
        :tabindex="line.key === focused ? 0 : -1"
        :data-dimmed="matches.length && !lit.has(line.key) ? '' : undefined"
        :data-changed="isChanged(line) ? '' : undefined"
        class="group/line relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
        :class="[
          matches.length && !lit.has(line.key) ? 'opacity-45' : '',
          line.key === focused ? 'bg-subtle/70' : 'hover:bg-subtle/50',
        ]"
        @click="focusKey = line.key"
        @dblclick="canEditValue(line) && startEdit(line, 'value')"
      >
        <div
          data-tree-row
          class="flex min-w-0 items-center gap-2 border-l-2 py-[3px] pr-2 font-mono text-[12.5px] leading-5"
          :class="isChanged(line) ? 'border-accent' : 'border-transparent'"
          :style="{ paddingLeft: `${line.depth * 16 + 4}px` }"
        >
          <button
            v-if="line.container"
            type="button"
            tabindex="-1"
            class="grid size-4 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle hover:text-fg"
            :aria-label="
              line.open
                ? t('documents.collapse', { name: line.name })
                : t('documents.expand', { name: line.name })
            "
            @click.stop="toggle(line)"
          >
            <ChevronRight
              class="size-3.5 transition-transform duration-150"
              :class="line.open ? 'rotate-90' : ''"
              aria-hidden="true"
            />
          </button>
          <span v-else class="w-4 shrink-0" aria-hidden="true" />
          <span class="min-w-[7rem] shrink-0 text-v-key"
            ><MarkedText :text="line.name" :mark="marksOf.get(line.key)?.key"
          /></span>
          <TreeValueEditor
            v-if="
              editing && editing.key === line.key && (editing.kind === 'value' || editing.kind === 'rename')
            "
            :kind="editing.kind"
            :name="line.name"
            :value="line.value"
            :error="editing.error"
            @apply="apply"
            @cancel="((editing = null), focusLine(line.key))"
          />
          <template v-else>
            <span v-if="hidden(line)" data-masked class="inline-flex items-center gap-1 text-fg-subtle">
              <Lock class="size-3" aria-hidden="true" />
              <MarkedText
                :text="t('masking.hidden')"
                :mark="
                  marksOf.get(line.key)?.value
                    ? {
                        start: 0,
                        end: t('masking.hidden').length,
                        current: marksOf.get(line.key)!.value!.current,
                      }
                    : null
                "
              />
            </span>
            <span
              v-else-if="marksOf.get(line.key)?.value && !line.container"
              class="min-w-0 truncate"
              :class="valueTone(line.type)"
              >{{ quote(line)
              }}<MarkedText :text="shownText(line.value)" :mark="marksOf.get(line.key)!.value" />{{
                quote(line)
              }}</span
            >
            <PluginCellText v-else :value="line.value" :path="line.path" host="[data-tree-row]" show-value>
              <span class="min-w-0 truncate"
                ><ValueCell :value="line.value" present quoted :path="line.path"
              /></span>
            </PluginCellText>
          </template>
          <span v-if="isChanged(line)" class="sr-only">{{ t('documents.docPage.changed') }}</span>
          <span class="ml-auto shrink-0 pl-3 font-sans text-caption text-fg-subtle">{{ line.type }}</span>
          <span
            v-if="!locked(line) && !(editing && editing.key === line.key)"
            data-tree-actions
            class="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/line:opacity-100 group-hover/line:opacity-100 pointer-coarse:opacity-100"
          >
            <DsTooltip
              v-if="canEditValue(line)"
              :text="t('documents.docPage.editValue', { name: line.name })"
            >
              <button
                type="button"
                tabindex="-1"
                :class="iconButton"
                :aria-label="t('documents.docPage.editValue', { name: line.name })"
                @click.stop="startEdit(line, 'value')"
              >
                <Pencil class="size-3.5" aria-hidden="true" />
              </button>
            </DsTooltip>
            <DsMenu
              :ref="(el) => (el ? lineMenus.set(line.key, el as never) : lineMenus.delete(line.key))"
              :label="t('documents.docPage.fieldActions', { name: line.name })"
              :items="menus.get(line.key) ?? []"
              @select="onMenu(line, $event)"
            />
          </span>
        </div>
        <div
          v-if="editing && editing.key === line.key && (editing.kind === 'field' || editing.kind === 'item')"
          class="py-1 pr-2"
          :style="{ paddingLeft: `${(line.depth + 1) * 16 + 24}px` }"
        >
          <TreeValueEditor
            :kind="editing.kind"
            :name="line.name"
            :error="editing.error"
            @apply="apply"
            @cancel="((editing = null), focusLine(line.key))"
          />
        </div>
      </li>
    </template>
  </ul>
</template>
