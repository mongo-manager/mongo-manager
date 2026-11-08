<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-vue-next'
import { useToastStore } from '@/stores/toasts'

/** UI redesign R1 spec §2: toasts at the bottom right; errors are alerts, the rest polite. */
const store = useToastStore()
// Sixth review of the floating window (I-2): where their room is bounded and scrolls, the newest
// (last) is kept in view.
const host = ref<HTMLElement | null>(null)
// Seventh review (I-1): by the newest's id — the stack full, one in and the oldest out keeps its length.
watch(
  () => store.toasts.at(-1)?.id,
  (id, was) => {
    if (id !== undefined && id !== was)
      void nextTick(() => host.value?.scrollTo?.({ top: host.value.scrollHeight }))
  },
)
const ICONS = {
  success: { is: CircleCheck, class: 'text-accent-fg' },
  error: { is: CircleAlert, class: 'text-danger' },
  info: { is: Info, class: 'text-info' },
} as const
</script>

<template>
  <div
    ref="host"
    aria-live="polite"
    class="pointer-events-none fixed top-[var(--mm-toast-top,auto)] right-[var(--mm-toast-right,1rem)] bottom-[var(--mm-toast-bottom,max(1rem,var(--mm-launcher-clearance,0px)))] z-[60] -m-1 flex w-[368px] max-w-[calc(100vw-1.5rem)] flex-col gap-2 [overflow-y:var(--mm-toast-overflow,visible)] p-1"
  >
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      data-toast
      class="pointer-events-auto flex animate-rise items-start gap-2.5 rounded-lg bg-raised px-3 py-2.5 text-ui text-fg shadow-float first:mt-[var(--mm-toast-push,0px)]"
      :role="toast.kind === 'error' ? 'alert' : undefined"
      @mouseenter="store.hold(toast.id, 'hover')"
      @mouseleave="store.release(toast.id, 'hover')"
      @focusin="store.hold(toast.id, 'focus')"
      @focusout="store.release(toast.id, 'focus')"
    >
      <component
        :is="ICONS[toast.kind].is"
        class="mt-0.5 size-4 shrink-0"
        :class="ICONS[toast.kind].class"
        aria-hidden="true"
      />
      <!-- UI review of wave B: the actions under the words, so a long name keeps the toast's width. -->
      <div class="min-w-0 flex-1">
        <p class="break-words">{{ toast.message }}</p>
        <div v-if="toast.actions?.length" class="mt-1 -ml-2 flex flex-wrap gap-x-1">
          <button
            v-for="(action, i) in toast.actions"
            :key="i"
            type="button"
            class="cursor-pointer rounded-md px-2 py-0.5 text-ui font-medium text-accent-fg hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            @click="store.runAction(toast.id, i)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="-mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
        :aria-label="$t('common.close')"
        @click="store.dismiss(toast.id)"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
