<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-vue-next'

/** UI redesign R1 spec §2: a message inside content; errors are announced (role alert). */
const props = withDefaults(
  defineProps<{ tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string }>(),
  {
    tone: 'info',
    title: undefined,
  },
)
const TONES = {
  info: { box: 'border-info/25 bg-info-soft', icon: 'text-info', is: Info },
  success: { box: 'border-accent/25 bg-accent-soft', icon: 'text-accent-fg', is: CircleCheck },
  warning: { box: 'border-warning/25 bg-warning-soft', icon: 'text-warning', is: TriangleAlert },
  danger: { box: 'border-danger/25 bg-danger-soft', icon: 'text-danger', is: CircleAlert },
} as const
const tone = computed(() => TONES[props.tone])
</script>

<template>
  <div
    :role="tone === TONES.danger ? 'alert' : undefined"
    class="flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-ui text-fg"
    :class="tone.box"
  >
    <component :is="tone.is" class="mt-0.5 size-4 shrink-0" :class="tone.icon" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p v-if="title" class="font-medium">{{ title }}</p>
      <div :class="title ? 'mt-0.5 text-fg-muted' : ''"><slot /></div>
    </div>
    <slot name="action" />
  </div>
</template>
