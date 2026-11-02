<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { keyLabel } from '@/workspace/shortcuts'
import { place, type Placement } from './position'

/**
 * UI redesign R1 spec §2: a short label on hover (after 400 ms) and on keyboard focus. It repeats the
 * control's accessible name, so it is hidden from screen readers.
 */
const props = withDefaults(
  defineProps<{
    text: string
    shortcut?: string[]
    placement?: Placement
    disabled?: boolean
    /** Classes of the wrapper around the control (a cell's value that may be cut short). */
    anchorClass?: string
    /**
     * The ancestor whose hover and focus show the tip (a table cell, a tree row): a larger target
     * than the value, and one a keyboard reaches (review 2026-10-13 of the hint tooltips, I1).
     */
    host?: string
    /** Room for a whole value on one line (an ObjectId, a date). */
    wide?: boolean
  }>(),
  {
    shortcut: undefined,
    placement: 'bottom',
    disabled: false,
    anchorClass: undefined,
    host: undefined,
    wide: false,
  },
)
const open = ref(false)
const anchor = ref<HTMLElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const position = ref({ top: 0, left: 0 })
let timer: ReturnType<typeof setTimeout> | undefined

function show(delay: number): void {
  if (props.disabled || !props.text) return
  clearTimeout(timer)
  timer = setTimeout(async () => {
    open.value = true
    await nextTick()
    const target = (anchor.value?.firstElementChild as HTMLElement | null) ?? anchor.value
    const a = target?.getBoundingClientRect()
    const b = tip.value?.getBoundingClientRect()
    if (a && b) position.value = place(a, b, props.placement, 6)
  }, delay)
}
function hide(): void {
  clearTimeout(timer)
  open.value = false
}
/**
 * A click focuses its control: that focus is the pointer's, and shows nothing — hovering does
 * (review 2026-10-13: the tooltip came up over a button just clicked, and stayed).
 */
let pressed = false
function press(): void {
  pressed = true
  hide()
}
function focused(): void {
  if (pressed) pressed = false
  else show(150)
}
const handlers: Record<string, () => void> = {
  mouseenter: () => show(400),
  mouseleave: hide,
  focusin: focused,
  focusout: hide,
  pointerdown: press,
  pointerup: () => (pressed = false),
}
/** WCAG 1.4.13: an open tip is dismissed with Escape wherever the focus is. */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') hide()
}
watch(open, (now) => {
  if (now) document.addEventListener('keydown', onKey, true)
  else document.removeEventListener('keydown', onKey, true)
})
watch(
  () => props.disabled,
  (now) => now && hide(),
)

let hostEl: HTMLElement | null = null
onMounted(() => {
  hostEl = props.host ? (anchor.value?.parentElement?.closest<HTMLElement>(props.host) ?? null) : null
  if (hostEl) for (const [name, fn] of Object.entries(handlers)) hostEl.addEventListener(name, fn)
})
onBeforeUnmount(() => {
  if (hostEl) for (const [name, fn] of Object.entries(handlers)) hostEl.removeEventListener(name, fn)
  document.removeEventListener('keydown', onKey, true)
  hide()
})
</script>

<template>
  <span ref="anchor" class="inline-flex" :class="anchorClass" v-on="host ? {} : handlers" @keydown.esc="hide">
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="open"
      ref="tip"
      role="tooltip"
      aria-hidden="true"
      class="pointer-events-none fixed z-[55] flex animate-fade items-center gap-2 overflow-hidden rounded-md bg-tooltip px-2 py-1 text-small text-on-tooltip shadow-float"
      :class="wide ? 'max-h-60 max-w-[min(28rem,90vw)]' : 'max-w-64'"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <span class="whitespace-pre-line [overflow-wrap:anywhere]"
        ><slot name="content">{{ text }}</slot></span
      >
      <span v-if="shortcut?.length" class="flex gap-0.5 opacity-75">
        <span v-for="key in shortcut" :key="key" class="font-medium">{{ keyLabel(key) }}</span>
      </span>
    </div>
  </Teleport>
</template>
