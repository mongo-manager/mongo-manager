<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import { X } from 'lucide-vue-next'
import DsButton from './DsButton.vue'
import { useModalFocus } from './modalFocus'

/**
 * Phase 3d-3a U14: a full-height work sheet — a stepper on the left, the work in the middle, a live
 * summary on the right (stacked below xl). A dirty sheet asks before it closes (U12).
 */
const props = defineProps<{
  open: boolean
  title: string
  subtitle?: string
  dirty?: boolean
  /** Phase 4a-1 final review minor 8: the question and its discard words, when not a form's. */
  dirtyText?: string
  discardText?: string
}>()
const emit = defineEmits<{ close: []; keydown: [event: KeyboardEvent] }>()
const panel = ref<HTMLElement | null>(null)
const ask = ref<HTMLElement | null>(null)
const titleId = useId()
const asking = ref(false)
const { trapTab } = useModalFocus(panel, () => props.open)
watch(
  () => props.open,
  (open) => {
    if (!open) asking.value = false
  },
)

async function requestClose(): Promise<void> {
  if (props.dirty && !asking.value) {
    asking.value = true
    // The question takes the focus, so a keyboard user answers it next.
    await nextTick()
    ask.value?.querySelector<HTMLElement>('button')?.focus()
    return
  }
  emit('close')
}

/** Final review minor 12: the owner's own Cancel asks the same question as Escape. */
defineExpose({ requestClose })

function keepEditing(): void {
  asking.value = false
  panel.value?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    if (asking.value) keepEditing()
    else void requestClose()
    return
  }
  trapTab(event)
  // Phase 3d-3b final review: Alt/Option+←/→ inside a text field is the platform's word navigation
  // (macOS); the step shortcut never takes it from the field.
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && editable(event.target))
    return
  // U12: the sheet's owner handles Enter and Alt+arrows (a Teleport root takes no fallthrough listener).
  if (!event.defaultPrevented) emit('keydown', event)
}
const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type)) ||
  (target instanceof HTMLElement && target.isContentEditable)
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-50 flex p-2 sm:p-4">
        <div
          class="absolute inset-0 bg-[var(--ds-backdrop)] backdrop-blur-[2px]"
          aria-hidden="true"
          @click="requestClose"
        />
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          class="relative m-auto flex h-full max-h-[56rem] w-full max-w-[80rem] flex-col overflow-hidden rounded-2xl bg-raised text-fg shadow-dialog outline-none"
          @keydown="onKeydown"
        >
          <header class="flex items-start gap-4 border-b border-line px-6 py-4">
            <div class="min-w-0 flex-1">
              <h2 :id="titleId" class="truncate text-title-m font-semibold text-fg">
                {{ title }}
              </h2>
              <p v-if="subtitle" class="mt-0.5 truncate text-ui text-fg-muted">
                {{ subtitle }}
              </p>
            </div>
            <button
              type="button"
              class="grid size-8 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg"
              :aria-label="$t('common.close')"
              aria-keyshortcuts="Escape"
              @click="requestClose"
            >
              <X class="size-5" aria-hidden="true" />
            </button>
          </header>
          <Transition
            enter-active-class="transition-all duration-150 motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
          >
            <div
              v-if="asking"
              ref="ask"
              role="alertdialog"
              :aria-label="dirtyText ?? $t('common.sheet.dirty')"
              class="flex flex-wrap items-center gap-3 border-b border-warning/25 bg-warning-soft px-6 py-2.5 text-ui text-warning"
            >
              <span class="flex-1">{{ dirtyText ?? $t('common.sheet.dirty') }}</span>
              <DsButton size="sm" variant="ghost" @click="keepEditing">{{
                $t('common.sheet.keep')
              }}</DsButton>
              <DsButton size="sm" variant="danger" @click="emit('close')">{{
                discardText ?? $t('common.sheet.discard')
              }}</DsButton>
            </div>
          </Transition>
          <div
            class="grid min-h-0 flex-1 grid-cols-1 content-start overflow-y-auto xl:grid-cols-[13.5rem_minmax(0,1fr)_21rem] xl:content-stretch xl:overflow-hidden"
          >
            <nav
              v-if="$slots.stepper"
              class="border-b border-line px-4 py-3 xl:border-r xl:border-b-0 xl:py-5"
            >
              <slot name="stepper" />
            </nav>
            <section
              class="px-6 py-5 xl:min-h-0 xl:overflow-y-auto"
              :class="
                !$slots.summary && !$slots.stepper
                  ? 'xl:col-span-3'
                  : !$slots.summary || !$slots.stepper
                    ? 'xl:col-span-2'
                    : ''
              "
            >
              <slot />
            </section>
            <aside
              v-if="$slots.summary"
              class="border-t border-line bg-canvas px-5 py-5 xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-l"
            >
              <slot name="summary" />
            </aside>
          </div>
          <footer
            v-if="$slots.footer"
            class="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas px-6 py-3.5"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
