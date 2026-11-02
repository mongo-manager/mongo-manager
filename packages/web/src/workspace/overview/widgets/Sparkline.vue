<script setup lang="ts">
import { computed } from 'vue'

/**
 * A small line of the last values, for a glance (decorative: the value beside it says the number).
 * Gaps (null) break the line.
 */
const props = defineProps<{ points: Array<number | null> }>()
const W = 100
const H = 24
const path = computed(() => {
  const values = props.points.filter((p): p is number => p !== null)
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = W / Math.max(1, props.points.length - 1)
  let d = ''
  let pen = false
  props.points.forEach((p, i) => {
    if (p === null) {
      pen = false
      return
    }
    const x = (i * step).toFixed(1)
    const y = (H - 2 - ((p - min) / span) * (H - 4)).toFixed(1)
    d += `${pen ? 'L' : 'M'}${x},${y} `
    pen = true
  })
  return d.trim()
})
</script>

<template>
  <svg
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    class="h-6 w-full text-accent"
    aria-hidden="true"
  >
    <path
      v-if="path"
      :d="path"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
