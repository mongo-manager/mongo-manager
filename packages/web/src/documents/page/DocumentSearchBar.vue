<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-vue-next'
import DsSelect from '@/ds/DsSelect.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { SearchScope } from './search'

/**
 * Document page design §6.7: the search in the open document — its words, where to look (keys,
 * values or both), how many matches there are and which one is shown. Enter and Shift+Enter walk the
 * matches; Escape clears the words first.
 */
const props = defineProps<{ total: number; current: number; capped: boolean }>()
const text = defineModel<string>('text', { required: true })
const scope = defineModel<SearchScope>('scope', { required: true })
const emit = defineEmits<{ next: []; prev: [] }>()
const { t } = useI18n()
const input = ref<HTMLInputElement | null>(null)

const counter = computed(() => {
  if (!text.value) return ''
  if (!props.total) return t('documents.docPage.noMatches')
  const n = props.current + 1
  return props.capped
    ? t('documents.docPage.matchCapped', { n, total: props.total })
    : t('documents.docPage.matchCount', { n, total: props.total })
})

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    if (event.shiftKey) emit('prev')
    else emit('next')
  } else if (event.key === 'Escape' && text.value) {
    // The first Escape clears the search; the next one is the page's (back to the results).
    event.preventDefault()
    event.stopPropagation()
    text.value = ''
  }
}

defineExpose({
  focus(): void {
    input.value?.focus()
    input.value?.select()
  },
})

const iconButton =
  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-35'
const scopes = computed(() => [
  { value: 'both' as const, label: t('documents.docPage.scopeBoth') },
  { value: 'keys' as const, label: t('documents.docPage.scopeKeys') },
  { value: 'values' as const, label: t('documents.docPage.scopeValues') },
])
</script>

<template>
  <div data-document-search class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
    <div
      class="flex h-8 min-w-48 flex-1 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 focus-within:border-focus focus-within:ring-3 focus-within:ring-focus/20"
    >
      <Search class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <input
        ref="input"
        v-model="text"
        type="search"
        class="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
        :aria-label="t('documents.docPage.search')"
        :placeholder="t('documents.docPage.searchPlaceholder')"
        aria-keyshortcuts="Control+F Meta+F"
        spellcheck="false"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <span
        data-match-count
        role="status"
        aria-live="polite"
        class="shrink-0 text-small whitespace-nowrap text-fg-subtle"
      >
        {{ counter }}
      </span>
      <button
        v-if="text"
        type="button"
        :class="iconButton"
        class="size-6"
        :aria-label="t('documents.docPage.clearSearch')"
        @click="((text = ''), input?.focus())"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </div>
    <DsTooltip :text="t('documents.docPage.prevMatch')">
      <button
        type="button"
        :class="iconButton"
        :aria-label="t('documents.docPage.prevMatch')"
        aria-keyshortcuts="Shift+Enter"
        :disabled="!total"
        @click="emit('prev')"
      >
        <ChevronUp class="size-4" aria-hidden="true" />
      </button>
    </DsTooltip>
    <DsTooltip :text="t('documents.docPage.nextMatch')">
      <button
        type="button"
        :class="iconButton"
        :aria-label="t('documents.docPage.nextMatch')"
        aria-keyshortcuts="Enter"
        :disabled="!total"
        @click="emit('next')"
      >
        <ChevronDown class="size-4" aria-hidden="true" />
      </button>
    </DsTooltip>
    <DsSelect v-model="scope" :label="t('documents.docPage.scope')" hide-label size="sm" :options="scopes" />
  </div>
</template>
