<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts" generic="V extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

/**
 * UI redesign R1 revision 2 §2: underline tabs with optional counts. One tab is in the Tab order (the
 * selected one); arrows, Home and End move and choose.
 */
const props = defineProps<{
  label: string
  tabs: Array<{ value: V; label: string; count?: number }>
  idPrefix?: string
  /** The tabpanel the tabs control. */
  panelId?: string
}>()
const model = defineModel<V>({ required: true })
const root = ref<HTMLElement | null>(null)
const tabId = (v: V) => `${props.idPrefix ?? 'tab'}-${v}`

function choose(index: number): void {
  const n = props.tabs.length
  const i = (index + n) % n
  const tab = props.tabs[i]
  if (!tab) return
  model.value = tab.value
  root.value?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus({ preventScroll: true })
}
function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'ArrowRight') choose(index + 1)
  else if (event.key === 'ArrowLeft') choose(index - 1)
  else if (event.key === 'Home') choose(0)
  else if (event.key === 'End') choose(props.tabs.length - 1)
  else return
  event.preventDefault()
}
/** Puts focus on the selected tab (after the content that held it went away). */
function focusSelected(): void {
  root.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
}
defineExpose({ tabId, focusSelected })

// Review of the connection tabs (2026-10-23): at a phone's width the sections ran off the bar, and
// nothing said more were there (its scrollbar is hidden). The bar fades on a side with more and
// shows an arrow there; the chosen tab is kept in full view, clear of the fade.
const FADE = 40
/** The arrow's width (w-7): nothing of a tab shows under it, else half a name reads as one with it. */
const ARROW = 28
const canBack = ref(false)
const canForward = ref(false)
function measure(): void {
  const bar = root.value
  if (!bar) return
  canBack.value = bar.scrollLeft > 1
  canForward.value = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1
}
const fade = computed(() => {
  if (!canBack.value && !canForward.value) return undefined
  const from = canBack.value ? `transparent 0, transparent ${ARROW}px, #000 ${FADE}px` : '#000 0'
  const to = canForward.value
    ? `#000 calc(100% - ${FADE}px), transparent calc(100% - ${ARROW}px), transparent 100%`
    : '#000 100%'
  const mask = `linear-gradient(to right, ${from}, ${to})`
  return { maskImage: mask, WebkitMaskImage: mask }
})
type Behavior = 'auto' | 'smooth'
const smooth = (): Behavior =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
function step(direction: -1 | 1): void {
  const bar = root.value
  if (bar) bar.scrollBy({ left: direction * Math.round(bar.clientWidth * 0.75), behavior: smooth() })
}
/** Scrolls the bar so a tab (the chosen one by default) is in full view, clear of the fade. */
function reveal(
  behavior: Behavior = smooth(),
  tab = root.value?.querySelector<HTMLElement>('[aria-selected="true"]'),
): void {
  const bar = root.value
  if (!bar || !tab || bar.scrollWidth <= bar.clientWidth) return
  const start = tab.offsetLeft - FADE
  const end = tab.offsetLeft + tab.offsetWidth + FADE
  let left = bar.scrollLeft
  if (start < left) left = Math.max(0, start)
  else if (end > left + bar.clientWidth) left = end - bar.clientWidth
  if (left !== bar.scrollLeft) bar.scrollTo({ left, behavior })
}
/** After the bar or its tabs changed size (a narrower window, a tab added, the font loaded). */
function settle(): void {
  reveal('auto')
  measure()
}
/**
 * The Tab key reaches the chosen tab: the browser only scrolls it to the edge, under the fade. Not
 * for a mouse press: scrolled under the pointer before the button comes up, the click would miss it
 * (the choice brings it into view after).
 */
let pressing = false
/** The press ends wherever the button comes up, in the bar or not. */
function onPointerDown(): void {
  pressing = true
  const done = () => {
    pressing = false
    window.removeEventListener('pointerup', done, true)
    window.removeEventListener('pointercancel', done, true)
  }
  window.addEventListener('pointerup', done, true)
  window.addEventListener('pointercancel', done, true)
}
function onFocusIn(event: FocusEvent): void {
  const tab = event.target as HTMLElement
  if (!pressing && tab.getAttribute('role') === 'tab') reveal(smooth(), tab)
}
watch(model, () => nextTick(() => reveal()))
// Tabs added or taken away move the chosen one; a count or a label only changes the room they take
// (the bar stays where the user scrolled it).
watch(
  () => props.tabs.map((tab) => tab.value).join('|'),
  () => nextTick(settle),
)
watch(
  () => props.tabs.map((tab) => `${tab.label}${tab.count ?? ''}`).join('|'),
  () => nextTick(measure),
)
let resize: ResizeObserver | null = null
onMounted(() => {
  settle()
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    resize = new ResizeObserver(settle)
    resize.observe(root.value)
  }
  void document.fonts?.ready.then(settle)
})
onBeforeUnmount(() => resize?.disconnect())
</script>

<template>
  <div class="relative flex min-w-0">
    <div
      ref="root"
      role="tablist"
      :aria-label="label"
      class="relative flex min-w-0 flex-1 items-end gap-1 overflow-x-auto [scrollbar-width:none]"
      :style="fade"
      data-tabs-scroller
      @scroll.passive="measure"
      @focusin="onFocusIn"
      @pointerdown="onPointerDown"
    >
      <button
        v-for="(tab, i) in tabs"
        :id="tabId(tab.value)"
        :key="tab.value"
        type="button"
        role="tab"
        :aria-selected="model === tab.value"
        :aria-controls="panelId"
        :tabindex="model === tab.value ? 0 : -1"
        class="relative flex h-10 shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-ui whitespace-nowrap transition-colors duration-120 ease-out-soft focus-visible:-outline-offset-2"
        :class="model === tab.value ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg'"
        @click="model = tab.value"
        @keydown="onKeydown($event, i)"
      >
        {{ tab.label }}
        <span
          v-if="tab.count !== undefined"
          class="rounded-full bg-muted px-1.5 text-caption leading-[18px] font-medium text-fg-muted tabular-nums"
          >{{ tab.count }}</span
        >
        <span
          class="absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-colors duration-160"
          :class="model === tab.value ? 'bg-accent' : 'bg-transparent'"
          aria-hidden="true"
        />
      </button>
    </div>
    <!-- For the eye and the mouse only: the arrow keys (and screen readers) already move along the tabs and
    bring each into view; a focused arrow would drop the focus to the page once it goes. -->
    <button
      v-if="canBack"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      :aria-label="$t('tabs.scrollBack')"
      :title="$t('tabs.scrollBack')"
      class="absolute inset-y-0 left-0 grid w-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg"
      data-tabs-more="back"
      @mousedown.prevent
      @click="step(-1)"
    >
      <ChevronLeft class="size-4" aria-hidden="true" />
    </button>
    <button
      v-if="canForward"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      :aria-label="$t('tabs.scrollForward')"
      :title="$t('tabs.scrollForward')"
      class="absolute inset-y-0 right-0 grid w-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg"
      data-tabs-more="forward"
      @mousedown.prevent
      @click="step(1)"
    >
      <ChevronRight class="size-4" aria-hidden="true" />
    </button>
  </div>
</template>
