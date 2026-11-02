<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import { place } from './position'
import { fold as foldText } from './fold'

/**
 * User report 2026-10-30: a text field that offers names as one types (WAI-ARIA list autocomplete) —
 * a connection's databases or a database's collections — and still takes a name that is not in the
 * list (a new target). Arrows move, Enter picks, Escape closes the list (not the dialog around it).
 */
defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    label: string
    suggestions: readonly string[]
    hideLabel?: boolean
    mono?: boolean
    hint?: string
    error?: string
    placeholder?: string
    disabled?: boolean
    size?: 'sm' | 'md'
  }>(),
  { hint: undefined, error: undefined, placeholder: undefined, size: 'md' },
)
// `v-model.trim` as on a native field: the parent takes the trimmed name (Vue trims what is emitted)
// and the field keeps what is typed — it is written only when the name is another (review I1).
const [model, modifiers] = defineModel<string, 'trim'>({ required: true })
const same = (shown: string, value: string) =>
  modifiers.trim ? shown.trim() === value.trim() : shown === value
const { locale } = useI18n()
// As DsInput: class and style lay out the field; the rest (maxlength, data-*) belong to the input.
const attrs = useAttrs()
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }))
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})
const id = useId()
const open = ref(false)
/** What was typed since the list opened: none shows every name. */
const query = ref('')
/** The option the arrows reached; -1 while none is (Enter is then the form's, review I2). */
const active = ref(-1)
const input = ref<HTMLInputElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const position = ref({ top: 0, left: 0, width: 0 })
const optionId = (i: number) => `${id}-option-${i}`
const fold = (s: string) => foldText(s, locale.value)

/** Names that start with what was typed first, then those that contain it. */
const shown = computed(() => {
  const q = fold(query.value.trim())
  if (!q) return [...props.suggestions]
  const starts: string[] = []
  const contains: string[] = []
  for (const name of props.suggestions) {
    const f = fold(name)
    if (f.startsWith(q)) starts.push(name)
    else if (f.includes(q)) contains.push(name)
  }
  return [...starts, ...contains]
})
const expanded = computed(() => open.value && shown.value.length > 0)
// Names that change under an open list leave no option behind that is not shown (review M4).
watch(shown, (names) => {
  if (active.value >= names.length) active.value = -1
})
onMounted(() => {
  if (input.value) input.value.value = model.value
})
watch(model, (value) => {
  const el = input.value
  if (el && !same(el.value, value)) el.value = value
})

async function show(text = ''): Promise<void> {
  if (props.disabled || props.suggestions.length === 0) return
  query.value = text
  // Opened on its own (not by typing): the name chosen, if it is one of them.
  active.value = text === '' ? shown.value.indexOf(model.value) : -1
  if (!open.value) {
    open.value = true
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', reposition, true)
  }
  await nextTick()
  reposition()
  reveal()
}
function reposition(): void {
  const anchor = input.value?.parentElement?.getBoundingClientRect()
  const box = panel.value?.getBoundingClientRect()
  if (anchor && box) position.value = { ...place(anchor, box, 'bottom-start', 4), width: anchor.width }
}
function close(): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', reposition, true)
}
const onResize = () => close()
function onOutside(event: Event): void {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !input.value?.parentElement?.contains(target)) close()
}
onBeforeUnmount(close)
// A list that empties (another connection picked) closes.
watch(
  () => props.suggestions.length,
  (n) => n === 0 && close(),
)

function pick(i: number): void {
  const name = shown.value[i]
  if (name === undefined) return
  model.value = name
  if (input.value) input.value.value = name
  close()
}
function reveal(): void {
  if (active.value < 0) return
  void nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView?.({ block: 'nearest' }))
}
watch(active, () => open.value && reveal())

function onInput(event: Event): void {
  // The model takes the text on the parent's next render: what was typed is read from the field.
  const text = (event.target as HTMLInputElement).value
  model.value = text
  void show(text)
}
function onKeydown(event: KeyboardEvent): void {
  const count = shown.value.length
  switch (event.key) {
    case 'ArrowDown':
      if (!expanded.value) void show()
      else active.value = (active.value + 1) % count
      break
    case 'ArrowUp':
      if (!expanded.value) void show()
      else active.value = active.value <= 0 ? count - 1 : active.value - 1
      break
    case 'Enter':
      // No name reached with the arrows: the form's own Enter (a step's Next) keeps what was typed.
      if (!expanded.value || active.value < 0) return
      pick(active.value)
      break
    case 'Escape':
      // A list with nothing in it is not there: Escape is the dialog's (review I3).
      if (!expanded.value) return
      close()
      break
    case 'Tab':
      close()
      return
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
}
function toggle(): void {
  if (open.value) close()
  else {
    input.value?.focus()
    void show()
  }
}
const describedBy = computed(() => (props.error ? `${id}-error` : props.hint ? `${id}-hint` : undefined))
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5" v-bind="rootAttrs">
    <label :for="id" :class="hideLabel ? 'sr-only' : 'text-small font-medium text-fg-muted'">{{
      label
    }}</label>
    <div
      class="relative flex min-w-0 items-center rounded-md border bg-surface transition-[border-color,box-shadow] duration-120 ease-out-soft focus-within:border-focus focus-within:ring-3 focus-within:ring-focus/20 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:bg-subtle has-[input:disabled]:opacity-70"
      :class="[
        error ? 'border-danger focus-within:border-danger focus-within:ring-danger/20' : 'border-line-strong',
        size === 'sm' ? 'h-7' : 'h-8',
      ]"
    >
      <input
        :id="id"
        ref="input"
        v-bind="inputAttrs"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        aria-autocomplete="list"
        :aria-expanded="expanded"
        :aria-controls="expanded ? `${id}-list` : undefined"
        :aria-activedescendant="expanded && active >= 0 ? optionId(active) : undefined"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy"
        :placeholder="placeholder"
        :disabled="disabled"
        class="h-full min-w-0 flex-1 bg-transparent px-2.5 text-ui text-fg placeholder:text-fg-subtle focus:outline-none disabled:cursor-not-allowed"
        :class="mono ? 'font-mono text-[12.5px]' : ''"
        @click="open ? undefined : show()"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        v-if="suggestions.length > 0 && !disabled"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        class="mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle hover:bg-muted hover:text-fg"
        @mousedown.prevent
        @click="toggle"
      >
        <ChevronDown class="size-3.5" />
      </button>
    </div>
    <p v-if="error" :id="`${id}-error`" class="text-small text-danger">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
    <Teleport to="body">
      <ul
        v-if="expanded"
        :id="`${id}-list`"
        ref="panel"
        role="listbox"
        :aria-label="label"
        data-ds-popup
        class="fixed z-[55] max-h-64 animate-pop overflow-auto rounded-lg bg-raised p-1 text-ui shadow-float ring-1 ring-line"
        :style="{
          top: `${position.top}px`,
          left: `${position.left}px`,
          minWidth: `${Math.max(position.width, 192)}px`,
        }"
      >
        <li
          v-for="(name, i) in shown"
          :id="optionId(i)"
          :key="name"
          role="option"
          :aria-selected="i === active"
          class="flex h-8 cursor-pointer items-center truncate rounded-md px-2"
          :class="[i === active ? 'bg-subtle' : '', mono ? 'font-mono text-[12.5px]' : '']"
          :title="name"
          @mousedown.prevent
          @mousemove="active = i"
          @click="pick(i)"
        >
          {{ name }}
        </li>
      </ul>
    </Teleport>
  </div>
</template>
