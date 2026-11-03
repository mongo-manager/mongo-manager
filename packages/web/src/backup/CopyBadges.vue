<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CloudCheck, CloudUpload, CloudAlert } from 'lucide-vue-next'
import type { CopyView } from '@mongo-manager/shared/browser'
import { useReasonText } from '@/destinations/errors'
import DsProgress from '@/ds/DsProgress.vue'

/**
 * Phase 3d-3b V6: where a kept backup's copies are — sent, being sent (with progress), or failed.
 * Final review C22: a failed copy says why on the page, in the reader's words when the server named a
 * reason (its own sentence is English), with Retry and Discard beside it.
 */
const props = defineProps<{ copies: CopyView[] }>()
const emit = defineEmits<{ retry: [copyId: string]; discard: [copyId: string] }>()
const { t } = useI18n()
const reasonWords = useReasonText()
// Floored like the job row: one transfer shows one percentage, and 100% only when it is done.
const pct = (c: CopyView) => (c.size ? Math.min(100, Math.floor((c.sent / c.size) * 100)) : 0)
const chips = computed(() => props.copies.filter((c) => c.state !== 'failed'))
const failed = computed(() => props.copies.filter((c) => c.state === 'failed'))
const why = (c: CopyView) => (c.reason ? reasonWords(c.reason) : (c.error ?? reasonWords(null)))
const action =
  'cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none'
</script>

<template>
  <div v-if="copies.length" class="flex flex-col gap-1">
    <ul v-if="chips.length" class="flex flex-wrap gap-1.5" :aria-label="t('backup.where.title')">
      <li
        v-for="c in chips"
        :key="c.id"
        class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
        :class="c.state === 'complete' ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent-fg'"
      >
        <CloudCheck v-if="c.state === 'complete'" class="size-3.5" aria-hidden="true" />
        <CloudUpload v-else class="size-3.5" aria-hidden="true" />
        <template v-if="c.state === 'complete'">{{
          t('backup.copies.sent', { name: c.destinationName })
        }}</template>
        <template v-else>
          {{ t('backup.copies.sending', { name: c.destinationName, pct: pct(c) }) }}
          <div class="w-12"><DsProgress :label="c.destinationName" :value="pct(c) / 100" /></div>
        </template>
      </li>
    </ul>
    <ul v-if="failed.length" class="flex flex-col gap-1">
      <li
        v-for="c in failed"
        :key="c.id"
        data-copy-failed
        class="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-danger-soft px-2 py-1 text-[11px] text-danger"
      >
        <CloudAlert class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="font-medium">{{ t('backup.copies.failed', { name: c.destinationName }) }}</span>
        <span class="ml-auto flex gap-0.5">
          <button
            type="button"
            :class="action"
            class="hover:bg-danger-soft"
            :aria-label="t('backup.copies.retryNamed', { name: c.destinationName })"
            @click="emit('retry', c.id)"
          >
            {{ t('backup.copies.retry') }}
          </button>
          <button
            type="button"
            :class="action"
            class="hover:bg-danger-soft"
            :aria-label="t('backup.copies.discardNamed', { name: c.destinationName })"
            @click="emit('discard', c.id)"
          >
            {{ t('backup.copies.discard') }}
          </button>
        </span>
        <!-- Its own line at the badge's full width: a long setting name is not split mid-word. -->
        <span class="basis-full break-words opacity-90">{{ why(c) }}</span>
      </li>
    </ul>
  </div>
</template>
