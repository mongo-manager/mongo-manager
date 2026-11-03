<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Download, History, Trash2 } from 'lucide-vue-next'
import type { WatchRecording, WatchRecordingPage } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import { watchApi } from '@/api/watch'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import { useToastStore } from '@/stores/toasts'

/**
 * W4.7: the viewer's recorded feeds of this connection — replayed here on the Watch page, downloaded
 * (NDJSON, as recorded) or deleted. A recording still being written can be replayed as it is so far.
 */
const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{
  replay: [recording: { name: string; fileId: string; page: WatchRecordingPage }]
}>()
const { t, locale } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()
const key = computed(() => ['watch', 'recordings', props.connectionId])
const list = useQuery({ queryKey: key, queryFn: () => watchApi.recordings(props.connectionId) })
const busy = ref<string | null>(null)
const when = (at: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(at)

async function replay(r: WatchRecording): Promise<void> {
  busy.value = r.id
  try {
    emit('replay', { name: r.name, fileId: r.id, page: await watchApi.page(props.connectionId, r.id, 0) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    busy.value = null
  }
}
async function remove(r: WatchRecording): Promise<void> {
  busy.value = r.id
  try {
    await watchApi.remove(props.connectionId, r.id)
    await queryClient.invalidateQueries({ queryKey: key.value })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="flex flex-col gap-2 border-b border-line bg-subtle/60 px-4 py-3" data-watch-recordings>
    <h3 class="text-ui font-semibold text-fg">{{ t('watch.recordings.title') }}</h3>
    <p v-if="list.isError.value" class="text-small text-danger">{{ describeError(list.error.value, t) }}</p>
    <p v-else-if="list.data.value && list.data.value.length === 0" class="text-small text-fg-subtle">
      {{ t('watch.recordings.none') }}
    </p>
    <ul v-else class="flex flex-col gap-1.5">
      <li
        v-for="r in list.data.value ?? []"
        :key="r.id"
        class="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-ui"
        data-recording
      >
        <span class="min-w-0 flex-1 truncate font-mono text-small" :title="r.name">{{ r.name }}</span>
        <span class="text-small text-fg-subtle tabular-nums">
          {{ when(r.createdAt) }} · {{ formatBytes(r.size, locale) }}
          <template v-if="r.recording"> · {{ t('watch.recordings.live') }}</template>
          <template v-if="r.masked"> · {{ t('watch.recordings.masked') }}</template>
        </span>
        <DsButton size="sm" variant="secondary" :loading="busy === r.id" @click="replay(r)"
          ><History class="size-4" aria-hidden="true" />{{ t('watch.recordings.replay') }}</DsButton
        >
        <a
          :href="watchApi.downloadUrl(connectionId, r.id)"
          download
          class="inline-flex items-center gap-1 text-small font-medium text-accent-fg hover:underline"
          ><Download class="size-4" aria-hidden="true" />{{ t('watch.recordings.download') }}</a
        >
        <DsButton
          size="sm"
          variant="ghost"
          :aria-label="t('watch.recordings.delete', { name: r.name })"
          :disabled="r.recording"
          @click="remove(r)"
          ><Trash2 class="size-4" aria-hidden="true"
        /></DsButton>
      </li>
    </ul>
  </section>
</template>
