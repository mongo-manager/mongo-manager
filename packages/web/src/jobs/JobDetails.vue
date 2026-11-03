<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Clipboard, Table, X } from 'lucide-vue-next'
import type { JobView } from '@mongo-manager/shared'
import DsButton from '@/ds/DsButton.vue'
import { formatBytes, formatCount } from '@/format'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab } from '@/workspace/openTabs'
import JobActions from './JobActions.vue'
import JobSentence from './JobSentence.vue'
import JobStatusIcon from './JobStatusIcon.vue'
import RunningJobCard from './RunningJobCard.vue'
import { placeOf, progressUnit } from './present'
import { useSendFailure, type SendJobView } from './sendJob'
import { useJobWords } from './useJobWords'

/**
 * User review 2026-10-08: one job in full — what happened in a headline, what can be done with it as
 * buttons, its timeline, its result, the facts, and the whole error to copy.
 */
const props = defineProps<{ job: JobView; now: number }>()
defineEmits<{ cancel: [job: JobView] }>()
const w = useJobWords()
const tabs = useTabsStore()

const headline = computed(() => w.t(`jobs.ui.headline.${w.status(props.job)}`, { kind: w.kind(props.job) }))
const sendFailure = useSendFailure()
/** A failed send names its destinations and why; any other failure says its error. */
const outcome = computed(() => {
  const job = props.job as SendJobView
  if (job.state === 'failed' && job.kind === 'backup.send') return sendFailure.sentence(job)
  if (job.state === 'interrupted' || job.state === 'unknown') return w.t(`jobs.state.${job.state}`)
  // Short names review 14 (M3): a cancelled send that kept its only local copy says so.
  if (job.state === 'cancelled' && job.kind === 'backup.send' && job.localKept)
    return w.t('backup.send.localKeptStopped')
  return null
})
const full = (ms: number) =>
  new Date(ms).toLocaleString(w.locale.value, { dateStyle: 'medium', timeStyle: 'medium' })
const result = computed(() => {
  const p = props.job.progress
  if (!p || props.job.state === 'running') return null
  const unit = progressUnit(props.job.kind)
  const n = (x: number) =>
    unit === 'bytes' ? formatBytes(x, w.locale.value) : formatCount(x, w.locale.value)
  const pair = p.done === p.total ? n(p.done) : `${n(p.done)} / ${n(p.total)}`
  return unit === 'documents' ? w.t('jobs.ui.documentsOf', { pair }, p.total) : pair
})
const collection = computed(() =>
  props.job.db !== '*' && props.job.coll !== '*' ? { db: props.job.db, coll: props.job.coll } : null,
)

const copied = ref<'error' | 'id' | null>(null)
async function copy(what: 'error' | 'id', text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = what
    setTimeout(() => (copied.value = null), 1200)
  } catch {
    // the clipboard was refused; the text stays selectable
  }
}
</script>

<template>
  <div class="flex flex-col gap-5 p-4" data-job-details-body>
    <div class="flex items-start gap-3">
      <JobStatusIcon :status="w.status(job)" :label="w.state(job)" />
      <div class="min-w-0 flex-1">
        <h3 class="text-title-s font-semibold text-fg">{{ headline }}</h3>
        <JobSentence class="mt-0.5 text-[12.5px] text-fg-muted" :job="job" />
      </div>
    </div>

    <ul v-if="job.state === 'running'">
      <RunningJobCard :job="job" :now="now" @cancel="$emit('cancel', job)" />
    </ul>

    <div class="flex flex-wrap items-center gap-2">
      <JobActions :job="job" variant="buttons" />
      <DsButton
        v-if="collection"
        size="sm"
        :icon="Table"
        @click="openCollectionTab(tabs, job.connectionId, collection.db, collection.coll)"
      >
        {{ w.t('jobs.ui.openCollection') }}
      </DsButton>
      <DsButton
        v-if="job.cancellable && job.state !== 'running'"
        size="sm"
        variant="danger"
        :icon="X"
        @click="$emit('cancel', job)"
      >
        {{ w.t('jobs.cancel') }}
      </DsButton>
    </div>

    <p v-if="outcome" role="status" class="rounded-lg bg-warning-soft px-3 py-2 text-ui text-warning">
      {{ outcome }}
    </p>

    <section class="flex flex-col gap-2">
      <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
        {{ w.t('jobs.ui.timeline') }}
      </h4>
      <ol class="relative flex flex-col gap-3 border-l border-line pl-4">
        <li class="relative">
          <span
            class="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-line-strong"
            aria-hidden="true"
          />
          <span class="block text-ui text-fg">{{ w.t('jobs.ui.started') }}</span>
          <time
            class="block text-small text-fg-subtle tabular-nums"
            :datetime="new Date(job.startedAt).toISOString()"
          >
            {{ full(job.startedAt) }}
          </time>
        </li>
        <li class="relative">
          <span
            class="absolute top-1.5 -left-[21px] size-2.5 rounded-full"
            :class="
              job.state === 'running'
                ? 'animate-pulse bg-info motion-reduce:animate-none'
                : job.state === 'done'
                  ? 'bg-success'
                  : 'bg-danger'
            "
            aria-hidden="true"
          />
          <span class="block text-ui text-fg">
            {{
              job.state === 'running' ? w.t('jobs.ui.runningFor', { time: w.took(job, now) }) : w.state(job)
            }}
          </span>
          <span v-if="job.finishedAt" class="block text-small text-fg-subtle tabular-nums">
            {{ full(job.finishedAt) }} · {{ w.t('jobs.ui.took', { time: w.took(job, now) }) }}
          </span>
        </li>
      </ol>
    </section>

    <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-ui">
      <template v-if="result">
        <dt class="text-fg-subtle">{{ w.t('jobs.ui.result') }}</dt>
        <dd class="text-fg tabular-nums">{{ result }}</dd>
      </template>
      <dt class="text-fg-subtle">{{ w.t('jobs.ui.connection') }}</dt>
      <dd class="min-w-0 break-words text-fg">
        {{ w.connection(job.connectionId) }}
        <span class="font-mono text-small text-fg-subtle">{{
          placeOf(job) ?? w.t('jobs.ui.wholeServer')
        }}</span>
      </dd>
      <template v-if="job.targetConnectionId">
        <dt class="text-fg-subtle">{{ w.t('jobs.ui.targetConnection') }}</dt>
        <dd class="min-w-0 break-words text-fg">{{ w.connection(job.targetConnectionId) }}</dd>
      </template>
      <dt class="text-fg-subtle">{{ w.t('jobs.ui.startedBy') }}</dt>
      <dd class="text-fg">{{ w.who(job) }}</dd>
      <template v-if="job.scheduleName">
        <dt class="text-fg-subtle">{{ w.t('jobs.ui.schedule') }}</dt>
        <dd class="text-fg">{{ job.scheduleName }}</dd>
      </template>
      <template v-if="job.waitingFor?.length">
        <dt class="text-fg-subtle">{{ w.t('jobs.ui.waiting') }}</dt>
        <dd class="text-fg">{{ job.waitingFor.join(', ') }}</dd>
      </template>
      <template v-if="job.verified !== undefined">
        <dt class="text-fg-subtle">{{ w.t('jobs.ui.verified') }}</dt>
        <dd class="text-fg">{{ job.verified ? w.t('jobs.ui.yes') : w.t('jobs.ui.no') }}</dd>
      </template>
      <template v-if="job.localKept !== undefined">
        <dt class="text-fg-subtle">{{ w.t('jobs.ui.localKept') }}</dt>
        <dd class="text-fg">{{ job.localKept ? w.t('jobs.ui.yes') : w.t('jobs.ui.no') }}</dd>
      </template>
    </dl>

    <section v-if="job.failures?.length" class="flex flex-col gap-1.5">
      <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
        {{ w.t('jobs.ui.failures') }}
      </h4>
      <ul class="flex flex-col gap-1 text-ui">
        <li v-for="f in job.failures" :key="f.destination" class="flex flex-wrap gap-x-2">
          <span class="font-medium text-fg">{{ f.destination }}</span>
          <span v-if="f.reason" class="text-danger">{{ w.t(`destinations.reason.${f.reason}`) }}</span>
        </li>
      </ul>
    </section>

    <section v-if="job.error" class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">
          {{ w.t('jobs.ui.error') }}
        </h4>
        <DsButton
          size="sm"
          variant="ghost"
          :icon="copied === 'error' ? Check : Clipboard"
          @click="copy('error', job.error)"
        >
          {{ copied === 'error' ? w.t('jobs.ui.copied') : w.t('jobs.ui.copyError') }}
        </DsButton>
      </div>
      <p
        data-job-error
        class="rounded-lg border border-danger/25 bg-danger-soft p-3 font-mono text-small break-words whitespace-pre-wrap text-danger"
      >
        {{ job.error }}
      </p>
    </section>

    <div class="flex items-center gap-2 border-t border-line pt-3 text-small text-fg-subtle">
      <span>{{ w.t('jobs.ui.id') }}</span>
      <code class="min-w-0 truncate font-mono">{{ job.id }}</code>
      <button
        type="button"
        class="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-subtle hover:text-fg"
        :aria-label="w.t('jobs.ui.copyId')"
        @click="copy('id', job.id)"
      >
        <component :is="copied === 'id' ? Check : Clipboard" class="size-3.5" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
