<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref, useId } from 'vue'
import { X } from 'lucide-vue-next'
import { useModalFocus } from '@/ds/modalFocus'
import DsIconButton from './DsIconButton.vue'

/** UI redesign R1 spec §2: a modal dialog — focus kept inside, Escape closes (unless persistent). */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    size?: 'sm' | 'md' | 'lg' | 'xl'
    /** `top`: anchored near the top, so the dialog grows downward only (its content changes). */
    align?: 'center' | 'top'
    /** Closes only through its own buttons: no Escape, backdrop or close icon (one-time secrets). */
    persistent?: boolean
  }>(),
  { description: undefined, size: 'md', align: 'center' },
)
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const descriptionId = useId()
const { trapTab } = useModalFocus(panel, () => props.open)
const WIDTHS = { sm: 'max-w-[400px]', md: 'max-w-[520px]', lg: 'max-w-[720px]', xl: 'max-w-[960px]' } as const

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    if (!props.persistent) emit('close')
    return
  }
  trapTab(event)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex justify-center p-4"
      :class="align === 'top' ? 'items-start pt-[8vh]' : 'items-center'"
    >
      <div
        class="absolute inset-0 animate-fade bg-[var(--ds-backdrop)]"
        aria-hidden="true"
        @click="persistent || emit('close')"
      />
      <div
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
        class="relative flex max-h-[85vh] w-full animate-pop flex-col overflow-hidden rounded-xl bg-raised text-fg shadow-dialog outline-none"
        :class="WIDTHS[size]"
        @keydown="onKeydown"
      >
        <header class="flex items-start gap-3 px-5 pt-4 pb-3">
          <div class="min-w-0 flex-1">
            <h2 :id="titleId" class="text-title-s font-semibold">{{ title }}</h2>
            <p v-if="description" :id="descriptionId" class="mt-0.5 text-ui text-fg-muted">
              {{ description }}
            </p>
          </div>
          <DsIconButton
            v-if="!persistent"
            :icon="X"
            size="sm"
            :label="$t('common.close')"
            :shortcut="['Escape']"
            @click="emit('close')"
          />
        </header>
        <div class="min-h-0 flex-1 overflow-auto px-5 pb-5"><slot /></div>
        <footer
          v-if="$slots.footer"
          class="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas px-5 py-3"
        >
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
