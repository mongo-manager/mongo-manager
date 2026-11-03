<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight } from 'lucide-vue-next'
import type { JobView } from '@mongo-manager/shared'
import { useJobsStore } from '@/jobs/store'
import { useCancelJob } from '@/jobs/cancel'
import JobLine from '@/jobs/JobLine.vue'
import RunningJobCard from '@/jobs/RunningJobCard.vue'
import { useTabsStore } from '@/stores/tabs'
import { openJobsTab } from '@/workspace/openTabs'
import WidgetFrame from './widgets/WidgetFrame.vue'

/**
 * UI redesign R1 revision 2 §3.5: running and recent background jobs, at a glance — read as on the
 * jobs page (user review 2026-10-08): a running job with its progress, an ended one with how long it
 * took and when; a job opens there with its details.
 */
const { t } = useI18n()
const store = useJobsStore()
const tabs = useTabsStore()
const cancel = useCancelJob()
const running = computed(() => store.running.slice(0, 2))
const ended = computed(() =>
  store.list.filter((j) => j.state !== 'running').slice(0, 5 - running.value.length),
)
const now = ref(store.serverNow())
const ticker = setInterval(() => (now.value = store.serverNow()), 1_000)
onBeforeUnmount(() => clearInterval(ticker))
watch(
  () => store.list,
  () => (now.value = store.serverNow()),
)
function show(job: JobView): void {
  store.focus(job.id)
  openJobsTab(tabs)
}
</script>

<template>
  <WidgetFrame :title="t('layout.activity')" :count="store.running.length || undefined">
    <template #actions>
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-small font-medium text-accent-fg transition-colors duration-120 hover:bg-accent-soft pointer-coarse:min-h-11"
        @click="openJobsTab(tabs)"
      >
        {{ t('jobs.showAll') }}<ArrowRight class="size-3.5" aria-hidden="true" />
      </button>
    </template>
    <p v-if="running.length === 0 && ended.length === 0" class="py-1 text-small text-fg-subtle">
      {{ t('jobs.empty') }}
    </p>
    <ul v-if="running.length" class="mb-1.5 flex flex-col gap-1.5">
      <RunningJobCard
        v-for="job in running"
        :key="job.id"
        compact
        :job="job"
        :now="now"
        @cancel="cancel"
        @select="show"
      />
    </ul>
    <ul v-if="ended.length" class="-mx-2 flex flex-col">
      <JobLine v-for="job in ended" :key="job.id" compact :job="job" :now="now" @select="show" />
    </ul>
  </WidgetFrame>
</template>
