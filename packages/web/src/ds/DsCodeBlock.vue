<script setup lang="ts">
import { ref } from 'vue'
import { Check, Copy } from 'lucide-vue-next'

/** UI redesign R1 revision 2 §2: a read-only piece of code with a Copy button. */
const props = withDefaults(
  defineProps<{
    code: string
    label?: string
    copyLabel: string
    /** Its whole height, the page scrolling (no scroll of its own inside a scrolled page). */
    full?: boolean
  }>(),
  { label: undefined, full: false },
)
const copied = ref(false)
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    // clipboard refused: the code stays selectable
  }
}
</script>

<template>
  <div class="group relative min-w-0 rounded-lg border border-line bg-subtle">
    <pre
      class="px-3 py-2 pr-9 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap text-fg"
      :class="full ? 'overflow-x-auto' : 'max-h-48 overflow-auto'"
      :aria-label="label"
      >{{ code }}</pre>
    <button
      type="button"
      class="absolute top-1.5 right-1.5 grid size-6 cursor-pointer place-items-center rounded-md text-fg-subtle opacity-0 transition-opacity duration-120 group-hover:opacity-100 hover:bg-muted hover:text-fg focus-visible:opacity-100"
      :aria-label="copyLabel"
      @click="copy"
    >
      <component :is="copied ? Check : Copy" class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
