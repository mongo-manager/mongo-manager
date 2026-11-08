<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { SEARCH_CURRENT, SEARCH_MARK } from '@/ds/code/marks'

/** Document page design §6.7: a key or value of the tree with its search match marked. */
const props = defineProps<{ text: string; mark?: { start: number; end: number; current: boolean } | null }>()
/**
 * User report 2026-11-05: a long value (an image as base64) is shown by the text around its match —
 * its line shows no more of it, and the whole of it slowed the tree.
 */
const AROUND = 60
const AFTER = 200
const ELLIPSIS = '…'
const parts = computed(() => {
  const m = props.mark
  if (!m) return null
  const text = props.text
  const from = text.length > AROUND + AFTER * 2 ? Math.max(0, m.start - AROUND) : 0
  const to = text.length > AROUND + AFTER * 2 ? Math.min(text.length, m.end + AFTER) : text.length
  return [
    (from > 0 ? ELLIPSIS : '') + text.slice(from, m.start),
    text.slice(m.start, m.end),
    text.slice(m.end, to) + (to < text.length ? ELLIPSIS : ''),
  ] as const
})
</script>

<template>
  <template v-if="parts"
    >{{ parts[0]
    }}<mark
      data-search-mark
      :data-current="mark!.current ? '' : undefined"
      :class="mark!.current ? SEARCH_CURRENT : SEARCH_MARK"
      class="text-inherit"
      >{{ parts[1] }}</mark
    >{{ parts[2] }}</template
  >
  <template v-else>{{ text }}</template>
</template>
