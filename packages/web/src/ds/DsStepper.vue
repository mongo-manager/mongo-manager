<script setup lang="ts">
import { AlertTriangle, Check } from 'lucide-vue-next'

export interface StepItem {
  id: string
  label: string
  state: 'done' | 'current' | 'todo' | 'error'
}
defineProps<{ steps: StepItem[]; label: string }>()
const emit = defineEmits<{ select: [id: string] }>()
</script>

<template>
  <ol class="flex gap-1 overflow-x-auto xl:flex-col" :aria-label="label">
    <li v-for="(s, i) in steps" :key="s.id" class="shrink-0">
      <button
        type="button"
        :disabled="s.state === 'todo'"
        :aria-current="s.state === 'current' ? 'step' : undefined"
        class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-ui transition-colors duration-120 enabled:cursor-pointer enabled:hover:bg-subtle disabled:cursor-default"
        :class="
          s.state === 'current'
            ? 'bg-accent-soft font-medium text-accent-fg'
            : s.state === 'error'
              ? 'text-danger'
              : 'text-fg-muted'
        "
        @click="emit('select', s.id)"
      >
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded-full border text-caption font-semibold tabular-nums transition-colors duration-120"
          :class="{
            'border-accent bg-accent text-on-accent': s.state === 'current',
            'border-success/40 bg-success-soft text-success': s.state === 'done',
            'border-danger/40 bg-danger-soft text-danger': s.state === 'error',
            'border-line-strong text-fg-subtle': s.state === 'todo',
          }"
        >
          <Check v-if="s.state === 'done'" class="size-3.5" aria-hidden="true" />
          <AlertTriangle v-else-if="s.state === 'error'" class="size-3.5" aria-hidden="true" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="whitespace-nowrap">{{ s.label }}</span>
      </button>
    </li>
  </ol>
</template>
