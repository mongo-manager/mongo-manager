<script setup lang="ts" generic="V extends string">
import { ref } from 'vue'
import { Check } from 'lucide-vue-next'

/**
 * UI redesign R1 revision 2 §2: the accent picker — a radio group of swatches. Each swatch carries its
 * own `data-accent`, so it is drawn in the color it stands for.
 */
const props = defineProps<{ label: string; options: Array<{ value: V; label: string }> }>()
const model = defineModel<V>({ required: true })
const root = ref<HTMLElement | null>(null)

function choose(index: number): void {
  const n = props.options.length
  const option = props.options[(index + n) % n]
  if (!option) return
  model.value = option.value
  root.value?.querySelectorAll<HTMLElement>('[role="radio"]')[(index + n) % n]?.focus()
}
function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') choose(index + 1)
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') choose(index - 1)
  else return
  event.preventDefault()
}
</script>

<template>
  <div ref="root" role="radiogroup" :aria-label="label" class="flex flex-wrap gap-2">
    <button
      v-for="(option, i) in options"
      :key="option.value"
      type="button"
      role="radio"
      :data-accent="option.value"
      :aria-checked="model === option.value"
      :aria-label="option.label"
      :title="option.label"
      :tabindex="model === option.value ? 0 : -1"
      class="grid size-7 cursor-pointer place-items-center rounded-full bg-accent text-on-accent ring-offset-2 ring-offset-raised transition-transform duration-120 ease-out-soft hover:scale-110"
      :class="model === option.value ? 'ring-2 ring-accent' : ''"
      @click="model = option.value"
      @keydown="onKeydown($event, i)"
    >
      <Check v-if="model === option.value" class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
