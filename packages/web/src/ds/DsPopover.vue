<script lang="ts">
/** One popover at a time: opening another closes this one. */
let closeCurrent: (() => void) | null = null
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { place, type Placement } from './position'

/**
 * UI redesign R1 spec §2: a non-modal panel under a button. Escape, a click or focus outside,
 * scrolling or resizing close it; Escape gives focus back to the button. The first control inside gets
 * focus when it opens.
 */
const props = withDefaults(
  defineProps<{
    label: string
    /** The panel's own name, when the button's (which may carry a value) is not one for it. */
    dialogLabel?: string
    triggerClass?: string
    panelClass?: string
    placement?: Placement
  }>(),
  { dialogLabel: undefined, triggerClass: undefined, panelClass: undefined, placement: 'bottom-start' },
)
const emit = defineEmits<{ open: []; close: [] }>()
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const panelId = useId()
const position = ref({ top: 0, left: 0 })

function onOutside(event: Event): void {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !trigger.value?.contains(target)) close(false)
}
/**
 * A scroll that moved its button closes it (the page, or a box holding the button); one beside it —
 * a terminal's viewport, a list — leaves it open (user report 2026-10-12: the shell's theme popover
 * closed as soon as it opened, the terminal scrolling its own viewport).
 */
function onScroll(event: Event): void {
  const target = event.target
  // The window itself (some libraries dispatch on it): the page moved (review M11).
  if (!(target instanceof Node)) return close(false)
  if (panel.value?.contains(target)) return
  if (target === document || target === document.documentElement || target.contains(trigger.value))
    close(false)
}
const onResize = () => close(false)
/**
 * A press inside the panel (on no control): the focus it takes away is no leaving. A key pressed in
 * the panel (Tab, say) ends it: the focus then left by the keyboard.
 */
let pressedInside = false
const onPressInside = () => (pressedInside = true)
const onKeyInside = () => (pressedInside = false)
function onFocusOut(event: FocusEvent): void {
  const to = event.relatedTarget as Node | null
  if (to) {
    if (!panel.value?.contains(to) && !trigger.value?.contains(to)) close(false)
    return
  }
  // The focus left for nowhere (Tab past the last control, the panel being the page's last element):
  // closed, unless a press inside took it (review 2026-10-12, M9).
  setTimeout(() => {
    if (pressedInside || !open.value) return
    const now = document.activeElement
    if (!now || (!panel.value?.contains(now) && !trigger.value?.contains(now))) close(false)
  }, 0)
}
function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  document[method]('pointerdown', onOutside, true)
  window[method]('scroll', onScroll, true)
  window[method]('resize', onResize)
}

async function show(): Promise<void> {
  closeCurrent?.()
  const rect = trigger.value?.getBoundingClientRect()
  pressedInside = false
  open.value = true
  emit('open')
  closeCurrent = () => close(false)
  listen(true)
  await nextTick()
  const box = panel.value?.getBoundingClientRect()
  if (rect && box) position.value = place(rect, box, props.placement, 6)
  // A group's checked radio first (review 2026-10-12, I1), else the first control.
  ;(
    panel.value?.querySelector<HTMLElement>('[autofocus], [aria-checked="true"]') ??
    panel.value?.querySelector<HTMLElement>('input, button, [tabindex]')
  )?.focus()
}

function close(returnFocus = true): void {
  if (!open.value) return
  open.value = false
  closeCurrent = null
  listen(false)
  emit('close')
  if (returnFocus) trigger.value?.focus()
}

onBeforeUnmount(() => {
  listen(false)
  if (open.value) closeCurrent = null
})
defineExpose({ close, show })
</script>

<template>
  <button
    ref="trigger"
    type="button"
    :aria-label="label"
    :aria-expanded="open"
    :aria-controls="open ? panelId : undefined"
    :class="triggerClass"
    @click="open ? close() : show()"
  >
    <slot name="trigger" :open="open" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="panelId"
      ref="panel"
      role="dialog"
      :aria-label="dialogLabel ?? label"
      tabindex="-1"
      data-ds-popup
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      :class="[
        // A press on its text gives the panel the focus (not the page): Escape still closes it.
        'fixed z-[55] max-h-[70vh] max-w-[90vw] animate-pop overflow-auto rounded-lg bg-raised p-1.5 text-ui text-fg shadow-float outline-none',
        panelClass,
      ]"
      @keydown.escape.stop.prevent="close()"
      @focusout="onFocusOut"
      @pointerdown.capture="onPressInside"
      @keydown.capture="onKeyInside"
    >
      <slot :close="close" />
    </div>
  </Teleport>
</template>
