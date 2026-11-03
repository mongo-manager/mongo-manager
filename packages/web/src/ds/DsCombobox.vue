<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Search } from 'lucide-vue-next'
import type { DsOption } from './menu'
import { place } from './position'
import { fold as foldText } from './fold'

/**
 * UI redesign R1 spec §2: a searchable picker under a button (the breadcrumb switchers). The list
 * filters as one types; arrows, Enter and Escape work from the field.
 */
const props = defineProps<{
  label: string
  items: DsOption[]
  placeholder?: string
  emptyText?: string
  current?: string
  triggerClass?: string
  /**
   * Audit action labels (2026-10-28): the trigger's own name (the field and the list keep `label`), its
   * id (a visible `<label for>` opens it), the panel's width, and whether the hints are searched too
   * (an action's code, a model's id; not a field's type, which would match nearly everything).
   */
  triggerLabel?: string
  triggerId?: string
  panelClass?: string
  searchHints?: boolean
  /** An entry for what was typed, when no item matches it (an action's code with no words). */
  freeOption?: (query: string) => DsOption | null
}>()
const emit = defineEmits<{ select: [value: string]; open: [] }>()
const { locale } = useI18n()
const open = ref(false)
const query = ref('')
const index = ref(0)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const position = ref({ top: 0, left: 0 })
const listId = useId()
const optionId = (i: number) => `${listId}-${i}`
const fold = (s: string) => foldText(s, locale.value)
const shown = computed(() => {
  const q = fold(query.value.trim())
  if (!q) return props.items
  const found = props.items.filter(
    (o) => fold(o.label).includes(q) || (props.searchHints === true && !!o.hint && fold(o.hint).includes(q)),
  )
  const free = props.freeOption?.(query.value.trim())
  return found.length === 0 && free ? [free] : found
})
/** Final review: the entry the keys move to stays in sight in a long list. */
function reveal(): void {
  void nextTick(() => document.getElementById(optionId(index.value))?.scrollIntoView?.({ block: 'nearest' }))
}
watch(index, () => {
  if (open.value) reveal()
})

function onOutside(event: Event): void {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !trigger.value?.contains(target)) close(false)
}
const onResize = () => close(false)
function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  document[method]('pointerdown', onOutside, true)
  window[method]('resize', onResize)
}
async function show(): Promise<void> {
  query.value = ''
  index.value = Math.max(
    0,
    props.items.findIndex((o) => o.value === props.current),
  )
  open.value = true
  emit('open')
  listen(true)
  await nextTick()
  const rect = trigger.value?.getBoundingClientRect()
  const box = panel.value?.getBoundingClientRect()
  if (rect && box) position.value = place(rect, box, 'bottom-start', 6)
  input.value?.focus()
  reveal()
}
function close(restore = true): void {
  if (!open.value) return
  open.value = false
  listen(false)
  if (restore) trigger.value?.focus()
}
function pick(i: number): void {
  const option = shown.value[i]
  if (!option) return
  close()
  emit('select', option.value)
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') index.value = Math.min(index.value + 1, shown.value.length - 1)
  else if (event.key === 'ArrowUp') index.value = Math.max(index.value - 1, 0)
  else if (event.key === 'Enter') pick(index.value)
  else if (event.key === 'Escape') close()
  else if (event.key === 'Tab') return close(false)
  else return
  event.preventDefault()
  event.stopPropagation()
}
function onInput(): void {
  index.value = 0
}
onBeforeUnmount(() => close(false))
/** A press on the list picks; it does not move the focus out of the search field (the field takes it). */
function keepFocus(event: MouseEvent): void {
  if (event.target !== input.value) event.preventDefault()
}
</script>

<template>
  <button
    :id="triggerId"
    ref="trigger"
    type="button"
    :aria-label="triggerLabel ?? label"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :class="triggerClass"
    @click="open ? close() : show()"
  >
    <slot name="trigger" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="fixed z-[55] flex animate-pop flex-col overflow-hidden rounded-lg bg-raised text-ui shadow-float"
      :class="panelClass ?? 'w-80'"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      data-ds-popup
      @mousedown="keepFocus"
    >
      <div class="flex items-center gap-2 border-b border-line px-3">
        <Search class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          :aria-label="label"
          :aria-controls="listId"
          :aria-activedescendant="shown.length ? optionId(index) : undefined"
          :placeholder="placeholder"
          class="h-9 min-w-0 flex-1 bg-transparent text-ui text-fg placeholder:text-fg-subtle focus:outline-none"
          @input="onInput"
          @keydown="onKeydown"
        />
      </div>
      <ul :id="listId" role="listbox" :aria-label="label" class="max-h-72 overflow-auto p-1">
        <li
          v-for="(option, i) in shown"
          :id="optionId(i)"
          :key="option.value"
          role="option"
          :aria-selected="i === index"
          class="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2"
          :class="i === index ? 'bg-subtle' : ''"
          @mousemove="index = i"
          @click="pick(i)"
        >
          <component
            :is="option.icon"
            v-if="option.icon"
            class="size-4 shrink-0 text-fg-subtle"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate" :title="option.label">{{ option.label }}</span>
          <!-- Final review: a long hint gives way, never the name before it. -->
          <span v-if="option.hint" class="max-w-[45%] shrink-0 truncate text-small text-fg-subtle">{{
            option.hint
          }}</span>
          <Check
            v-if="option.value === current"
            class="size-3.5 shrink-0 text-accent-fg"
            aria-hidden="true"
          />
        </li>
        <li v-if="shown.length === 0" class="px-2 py-3 text-center text-fg-subtle">{{ emptyText }}</li>
      </ul>
    </div>
  </Teleport>
</template>
