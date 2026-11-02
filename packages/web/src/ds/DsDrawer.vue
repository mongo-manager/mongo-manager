<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import DsResizeHandle from './DsResizeHandle.vue'

/**
 * UI redesign R1 revision 2 §4.5: a drawer on the right of the workspace — a named region with a
 * header, a body and a footer, resized from its left edge. Escape closes it and focus goes back where it
 * came from. As an overlay (narrow windows) it floats over the content.
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    subtitle?: string
    width: number
    minWidth: number
    maxWidth: number
    resizeLabel: string
    closeLabel: string
    overlay?: boolean
  }>(),
  { subtitle: undefined, overlay: false },
)
const emit = defineEmits<{ close: []; 'update:width': [width: number] }>()
const panel = ref<HTMLElement | null>(null)
let returnTo: HTMLElement | null = null

watch(
  () => props.open,
  async (open) => {
    if (open) {
      const active = document.activeElement as HTMLElement | null
      returnTo = active && active !== document.body ? active : null
      await nextTick()
      if (!panel.value?.contains(document.activeElement)) panel.value?.focus({ preventScroll: true })
    } else {
      returnTo?.focus({ preventScroll: true })
      returnTo = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}
</script>

<template>
  <aside
    v-if="open"
    ref="panel"
    role="complementary"
    :aria-label="title"
    tabindex="-1"
    class="flex min-h-0 shrink-0 flex-col bg-surface text-fg outline-none"
    :class="
      overlay
        ? 'fixed top-2 right-2 bottom-2 z-30 max-w-[calc(100vw-1rem)] animate-rise overflow-hidden rounded-2xl shadow-dialog ring-1 ring-line'
        : 'relative border-l border-line'
    "
    :style="{ width: `${width}px` }"
    @keydown="onKeydown"
  >
    <DsResizeHandle
      v-if="!overlay"
      :value="width"
      :min="minWidth"
      :max="maxWidth"
      edge="left"
      :label="resizeLabel"
      @update:value="emit('update:width', $event)"
    />
    <header class="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-title-s font-semibold text-fg">{{ title }}</h2>
        <p v-if="subtitle" class="truncate font-mono text-small text-fg-subtle">{{ subtitle }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <slot name="actions" />
        <button
          type="button"
          class="grid size-8 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg"
          :aria-label="closeLabel"
          aria-keyshortcuts="Escape"
          @click="emit('close')"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>
    <div class="min-h-0 flex-1 overflow-auto"><slot /></div>
    <footer
      v-if="$slots.footer"
      class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-canvas px-4 py-3 pr-[max(1rem,var(--mm-launcher-clearance,0px))]"
    >
      <slot name="footer" />
    </footer>
  </aside>
</template>
