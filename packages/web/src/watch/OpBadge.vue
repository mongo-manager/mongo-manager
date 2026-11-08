<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  ArrowRightLeft,
  Ban,
  Database,
  FilePlus2,
  FileX2,
  ListTree,
  PencilLine,
  Replace,
  Wrench,
} from 'lucide-vue-next'
import DsBadge from '@/ds/DsBadge.vue'
import { useWatchWords } from './words'

const props = defineProps<{ op: string }>()
const { op: label } = useWatchWords()

type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'
/** Colour and icon together, never colour alone (spec §4.2); the tones are the kit's (UI redesign R2 §3). */
const LOOK: Record<string, { icon: Component; tone: Tone }> = {
  insert: { icon: FilePlus2, tone: 'success' },
  update: { icon: PencilLine, tone: 'info' },
  replace: { icon: Replace, tone: 'warning' },
  delete: { icon: FileX2, tone: 'danger' },
  invalidate: { icon: Ban, tone: 'neutral' },
  rename: { icon: ArrowRightLeft, tone: 'neutral' },
  dropDatabase: { icon: Database, tone: 'danger' },
  createIndexes: { icon: ListTree, tone: 'neutral' },
  dropIndexes: { icon: ListTree, tone: 'neutral' },
}
const look = computed(() => LOOK[props.op] ?? { icon: Wrench, tone: 'neutral' as const })
</script>

<template>
  <DsBadge :data-op="op" :tone="look.tone">
    <component :is="look.icon" class="size-3.5" aria-hidden="true" />
    {{ label(op) }}
  </DsBadge>
</template>
