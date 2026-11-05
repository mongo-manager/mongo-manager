<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { STAGES } from '@mongo-manager/shared/browser'
import { BookOpen, ChevronDown, PenLine } from 'lucide-vue-next'
import { place } from '@/ds/position'
import { searchStages } from './stageSearch'

/**
 * W2.5 (2026-10-16): a stage's operator as an editable combobox (WAI-ARIA list autocomplete):
 * typing filters the stages by name and by what they do, arrows move, Enter picks, Escape puts the
 * operator back. Beside the list, the active stage's description and an example of its value.
 * Alt+arrows are left to the card (they move the stage).
 */
const props = defineProps<{ operator: string }>()
const emit = defineEmits<{ pick: [operator: string] }>()
const { t, te } = useI18n()
const id = useId()
const open = ref(false)
const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const docsLink = ref<HTMLAnchorElement | null>(null)
const position = ref({ top: 0, left: 0 })

const describe = (operator: string) => {
  const key = `aggregation.stageHelp.${operator.slice(1)}`
  return te(key) ? t(key) : ''
}
const matches = computed(() => searchStages(open.value ? query.value : '', describe))
const BY_OPERATOR = new Map(STAGES.map((s) => [s.operator, s]))
const current = computed(() => {
  const op = matches.value[Math.min(active.value, matches.value.length - 1)]
  return op ? BY_OPERATOR.get(op) : undefined
})
const optionId = (i: number) => `${id}-option-${i}`

async function show(text = ''): Promise<void> {
  query.value = text
  const at = matches.value.indexOf(props.operator)
  active.value = text === '' && at >= 0 ? at : 0
  if (!open.value) {
    open.value = true
    document.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('resize', onResize)
    // W2 review (minor 6): the list stays beside its field when the page (or the stages) scroll.
    window.addEventListener('scroll', reposition, true)
  }
  await nextTick()
  reposition()
  scrollActive()
}
function reposition(): void {
  const anchor = input.value?.getBoundingClientRect()
  const box = panel.value?.getBoundingClientRect()
  if (anchor && box) position.value = place(anchor, box, 'bottom-start', 6)
}
function close(): void {
  if (!open.value) return
  open.value = false
  query.value = ''
  document.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', reposition, true)
}
const onResize = () => close()
function onOutside(event: Event): void {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !input.value?.contains(target)) close()
}
onBeforeUnmount(close)

function pick(operator: string): void {
  close()
  if (operator !== props.operator) emit('pick', operator)
}
function scrollActive(): void {
  void nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView?.({ block: 'nearest' }))
}
watch(active, scrollActive)

function onInput(event: Event): void {
  const text = (event.target as HTMLInputElement).value
  void show(text)
  active.value = 0
}
function onKeydown(event: KeyboardEvent): void {
  // Alt+arrows move the stage (the card's own keys).
  if (event.altKey) return
  const count = matches.value.length
  switch (event.key) {
    case 'ArrowDown':
      if (!open.value) void show()
      else if (count) active.value = (active.value + 1) % count
      break
    case 'ArrowUp':
      if (!open.value) void show()
      else if (count) active.value = (active.value - 1 + count) % count
      break
    case 'Home':
      if (!open.value) return
      active.value = 0
      break
    case 'End':
      if (!open.value) return
      active.value = Math.max(0, count - 1)
      break
    case 'Enter':
      if (!open.value) {
        void show()
        break
      }
      if (count) pick(matches.value[Math.min(active.value, count - 1)]!)
      break
    case 'Escape':
      if (!open.value) return
      close()
      break
    case 'Tab':
      // W2 review (minor 6): Tab goes on to the active stage's manual page, beside the list.
      if (open.value && !event.shiftKey && docsLink.value) {
        docsLink.value.focus()
        break
      }
      close()
      return
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
}
/**
 * From the manual's link, or the panel a press on its text focused (it holds the focus, review of
 * 293c3d6e): Escape, Tab and Shift+Tab close the list and go back to the field. The list is placed at
 * the end of the page; left to the browser, Tab would go on from there (re-review minor 1).
 */
function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' && event.key !== 'Tab') return
  event.preventDefault()
  event.stopPropagation()
  close()
  input.value?.focus()
}
function onFocus(): void {
  input.value?.select()
}
</script>

<template>
  <div class="relative">
    <input
      ref="input"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      :aria-label="t('aggregation.operator')"
      :aria-expanded="open"
      :aria-controls="`${id}-list`"
      :aria-activedescendant="open && matches.length ? optionId(active) : undefined"
      :value="open ? query : operator"
      :placeholder="open ? operator : undefined"
      :title="t('aggregation.operatorHint')"
      class="h-7 w-40 cursor-pointer rounded-md border border-transparent bg-accent-soft py-0 pr-7 pl-2 font-mono text-ui font-medium text-accent-fg placeholder:text-accent-fg/50 hover:border-accent/30 focus:cursor-text focus:border-focus focus:ring-3 focus:ring-focus/20 focus-visible:outline-none"
      @focus="onFocus"
      @click="open ? undefined : show()"
      @input="onInput"
      @keydown="onKeydown"
    />
    <ChevronDown
      class="pointer-events-none absolute top-1.5 right-1.5 size-4 text-accent-fg"
      aria-hidden="true"
    />
    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        data-stage-combobox
        data-ds-popup
        tabindex="-1"
        class="fixed z-[55] flex w-[38rem] max-w-[calc(100vw-1rem)] animate-pop flex-col overflow-hidden rounded-lg bg-raised text-ui shadow-float ring-1 ring-line outline-none sm:flex-row"
        :style="{ top: `${position.top}px`, left: `${position.left}px` }"
        @keydown="onPanelKeydown"
      >
        <ul
          :id="`${id}-list`"
          role="listbox"
          :aria-label="t('aggregation.operator')"
          class="max-h-80 min-w-0 overflow-auto p-1 sm:w-1/2"
        >
          <li
            v-for="(op, i) in matches"
            :id="optionId(i)"
            :key="op"
            role="option"
            :aria-selected="i === active"
            :data-operator="op"
            class="cursor-pointer rounded-md px-2 py-1.5"
            :class="i === active ? 'bg-accent-soft text-accent-fg' : 'hover:bg-subtle'"
            @mousedown.prevent
            @mousemove="active = i"
            @click="pick(op)"
          >
            <span class="font-mono text-ui">{{ op }}</span>
            <span class="block truncate text-small text-fg-subtle">{{ describe(op) }}</span>
          </li>
          <li v-if="matches.length === 0" class="px-2 py-3 text-center text-fg-subtle">
            {{ t('aggregation.noStage') }}
          </li>
        </ul>
        <div
          v-if="current"
          data-stage-detail
          class="flex min-w-0 flex-col gap-2 border-t border-line bg-surface p-3 sm:w-1/2 sm:border-t-0 sm:border-l"
        >
          <p class="font-mono text-ui font-semibold text-fg">{{ current.operator }}</p>
          <p class="text-small text-fg-muted">{{ describe(current.operator) }}</p>
          <p class="flex items-center gap-1 text-caption font-medium tracking-wide text-fg-subtle uppercase">
            <PenLine class="size-3" aria-hidden="true" />{{ t('aggregation.example') }}
          </p>
          <pre
            class="max-h-40 overflow-auto rounded-md bg-canvas p-2 font-mono text-small break-words whitespace-pre-wrap text-fg"
            >{{ `{ ${current.operator}: ${current.template} }` }}</pre>
          <p v-if="current.write" class="text-small text-warning">{{ t('aggregation.writesNote') }}</p>
          <a
            ref="docsLink"
            :href="current.docsUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-auto inline-flex items-center gap-1 rounded-sm text-small text-accent-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            @mousedown.prevent
          >
            <BookOpen class="size-3.5" aria-hidden="true" />{{ t('aggregation.docs') }}
          </a>
        </div>
      </div>
    </Teleport>
  </div>
</template>
