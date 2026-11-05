<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronRight, Copy } from 'lucide-vue-next'
import { dottedPath } from './treeModel'

/**
 * Document page design §6.8: where the selected field is (`payments › 2 › amount`). A part goes to
 * that branch; the copy button copies the path as MongoDB writes it (`payments.2.amount`), for the
 * query bar.
 */
const props = defineProps<{ path: readonly string[] }>()
const emit = defineEmits<{ go: [path: readonly string[]] }>()
const { t } = useI18n()
const copied = ref(false)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(dottedPath(props.path))
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    // the clipboard was refused; the path stays readable
  }
}
</script>

<template>
  <nav
    data-path-bar
    :aria-label="t('documents.docPage.pathLabel')"
    class="flex min-w-0 items-center gap-1 border-b border-line px-4 py-1.5 font-mono text-small"
  >
    <ol class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap">
      <li class="shrink-0">
        <button
          type="button"
          class="cursor-pointer rounded px-1 font-sans text-fg-subtle hover:bg-subtle hover:text-fg"
          @click="emit('go', [])"
        >
          {{ t('documents.docPage.root') }}
        </button>
      </li>
      <li v-for="(part, i) in path" :key="i" class="flex shrink-0 items-center gap-0.5">
        <ChevronRight class="size-3 text-fg-subtle" aria-hidden="true" />
        <button
          type="button"
          class="cursor-pointer rounded px-1 text-v-key hover:bg-subtle"
          :aria-current="i === path.length - 1 ? 'location' : undefined"
          @click="emit('go', path.slice(0, i + 1))"
        >
          {{ part }}
        </button>
      </li>
    </ol>
    <button
      v-if="path.length"
      type="button"
      class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-sans text-small text-fg-muted hover:bg-subtle hover:text-fg"
      @click="copy"
    >
      <component :is="copied ? Check : Copy" class="size-3.5" aria-hidden="true" />
      {{ copied ? t('documents.docPage.pathCopied') : t('documents.docPage.copyPath') }}
    </button>
  </nav>
</template>
