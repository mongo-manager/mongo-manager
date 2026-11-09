<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
/**
 * UI redesign R1 spec §2: a vertical separator that resizes a side panel by pointer and keyboard.
 * `edge` is the panel's side the handle sits on: 'right' for a left panel (dragging right widens it),
 * 'left' for a right panel.
 */
const props = withDefaults(
  defineProps<{
    value: number
    min: number
    max: number
    label: string
    edge: 'left' | 'right'
    step?: number
    /** What the value means, when its pixels say little (W6.1: the split's share, "50%"). */
    valueText?: string
  }>(),
  { step: 16, valueText: undefined },
)
/** `commit`: a change is done — the pointer let go, or a key pressed (W6.1 review: save then). */
const emit = defineEmits<{ 'update:value': [value: number]; commit: [] }>()
const clamp = (n: number) => Math.round(Math.min(props.max, Math.max(props.min, n)))
const grow = (by: number) => emit('update:value', clamp(props.value + by))

function onKeydown(e: KeyboardEvent): void {
  const step = e.shiftKey ? props.step * 4 : props.step
  const wider = props.edge === 'right' ? 'ArrowRight' : 'ArrowLeft'
  const narrower = props.edge === 'right' ? 'ArrowLeft' : 'ArrowRight'
  if (e.key === wider) grow(step)
  else if (e.key === narrower) grow(-step)
  else if (e.key === 'Home') emit('update:value', props.min)
  else if (e.key === 'End') emit('update:value', props.max)
  else return
  e.preventDefault()
  emit('commit')
}
function onPointerDown(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture?.(e.pointerId)
  const startX = e.clientX
  const start = props.value
  const move = (ev: PointerEvent) => {
    const delta = ev.clientX - startX
    emit('update:value', clamp(start + (props.edge === 'right' ? delta : -delta)))
  }
  // W6 re-review minor 6: let go, cancelled by the browser, or its capture lost — the drag ends once.
  const ENDS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const
  const up = () => {
    el.removeEventListener('pointermove', move)
    for (const type of ENDS) el.removeEventListener(type, up)
    emit('commit')
  }
  el.addEventListener('pointermove', move)
  for (const type of ENDS) el.addEventListener(type, up)
}
</script>

<template>
  <div
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="value"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuetext="valueText"
    class="absolute inset-y-0 z-20 w-1.5 cursor-col-resize rounded-full transition-colors duration-160 hover:bg-accent/30 focus-visible:bg-accent/50 focus-visible:outline-none"
    :class="edge === 'right' ? '-right-[3px]' : '-left-[3px]'"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
  />
</template>
