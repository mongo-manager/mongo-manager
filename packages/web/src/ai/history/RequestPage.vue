<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { ArrowLeft, SearchX } from 'lucide-vue-next'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import type { AiHistoryItem } from '@mongo-manager/shared/browser'
import ChainDetails from './ChainDetails.vue'
import HistoryDetails from './HistoryDetails.vue'
import { useHistoryWords } from './historyWords'

/**
 * User review 2026-10-09 ("yandan drawer olarak açma, iç sayfa olarak aç"): a request, or a chain of
 * them, as a page in the AI history's tab — back to the list with its button or Escape.
 */
/** The request shown; null while it is read, or when it cannot be (missing). */
const props = defineProps<{ item: AiHistoryItem | null; missing?: boolean; shownId?: string | null }>()
const emit = defineEmits<{
  back: []
  choose: [id: string]
  remove: [item: AiHistoryItem]
  removeStep: [step: AiHistoryItem]
  removeChain: [item: AiHistoryItem]
}>()
const w = useHistoryWords()
const root = ref<HTMLElement | null>(null)
// Its heading takes the focus once it is read, so a screen reader hears where it is — once per
// request or chain shown (choosing another step of a chain leaves the focus where it was).
let focusedOn: string | null = null
watch(
  () => [props.item?.thread ?? props.item?.id, props.missing],
  () =>
    void nextTick(() => {
      const key = props.missing ? 'missing' : (props.item?.thread ?? props.item?.id ?? null)
      const target = root.value?.querySelector<HTMLElement>('h2, [data-request-missing]')
      if (!key || key === focusedOn || !target) return
      target.focus()
      focusedOn = key
    }),
  { immediate: true },
)
</script>

<template>
  <div
    ref="root"
    data-request-page
    class="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-5"
    @keydown.esc.prevent="emit('back')"
  >
    <nav :aria-label="w.t('aiHistory.back')">
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
        @click="emit('back')"
      >
        <ArrowLeft class="size-4" aria-hidden="true" />{{ w.t('aiHistory.title') }}
      </button>
    </nav>
    <p
      v-if="missing"
      data-request-missing
      role="alert"
      tabindex="-1"
      class="flex items-start gap-2 rounded-xl border border-line bg-subtle px-4 py-3 text-ui text-fg-muted"
    >
      <SearchX class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ w.t('aiHistory.missing') }}
    </p>
    <div
      v-else-if="!item"
      class="flex flex-col gap-2 py-2"
      role="status"
      :aria-label="w.t('aiHistory.loading')"
    >
      <DsSkeleton v-for="n in 3" :key="n" class="h-5" />
    </div>
    <ChainDetails
      v-else-if="item.chain && item.thread"
      :key="item.thread"
      :item="item"
      :shown-id="shownId ?? item.id"
      @remove-step="emit('removeStep', $event)"
      @choose="emit('choose', $event)"
      @remove-chain="emit('removeChain', $event)"
    />
    <HistoryDetails v-else :key="item.id" :item="item" @remove="emit('remove', $event)" />
  </div>
</template>
