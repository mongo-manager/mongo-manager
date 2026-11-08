<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { tipPlacement, type TipContent } from './tip'

/**
 * A chart's tooltip, drawn by the app above the page (user report 2026-10-16): text only, out of the
 * accessibility tree (each chart has a table for screen readers), and kept inside the window.
 */
const props = defineProps<{ content: TipContent | null; pointer: { x: number; y: number } }>()
const el = ref<HTMLElement | null>(null)
const position = ref({ left: -9999, top: -9999 })

watch(
  () => [props.content, props.pointer.x, props.pointer.y] as const,
  async () => {
    if (!props.content) return
    await nextTick()
    const box = el.value?.getBoundingClientRect()
    position.value = tipPlacement(
      props.pointer,
      { width: box?.width ?? 0, height: box?.height ?? 0 },
      { width: window.innerWidth, height: window.innerHeight },
    )
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="content && content.rows.length"
      ref="el"
      data-chart-tip
      aria-hidden="true"
      class="pointer-events-none fixed z-[55] flex max-w-[min(20rem,calc(100vw-1rem))] flex-col gap-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-small text-fg shadow-float"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    >
      <div v-for="(row, i) in content.rows" :key="i" class="flex min-w-0 items-center gap-2">
        <span v-if="row.color" class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: row.color }" />
        <span class="min-w-0 flex-1 truncate text-fg-muted">{{ row.name }}</span>
        <span class="shrink-0 font-medium tabular-nums">{{ row.value }}</span>
      </div>
    </div>
  </Teleport>
</template>
