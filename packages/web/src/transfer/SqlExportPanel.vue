<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArrowRight,
  CheckCircle2,
  CircleStop,
  Download,
  Eye,
  RotateCw,
  Search,
  Table2,
  TimerReset,
  XCircle,
} from 'lucide-vue-next'
import {
  SQL_DIALECTS,
  SQL_EXPORT_MAX_COLLECTIONS,
  type ExportReport,
  type SqlExportRequest,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsProgress from '@/ds/DsProgress.vue'
import { describeError } from '@/api/errors'
import { connectionsApi, queryKeys, type CollectionInfo } from '@/api/connections'
import { jobsApi } from '@/api/jobs'
import { transferApi } from '@/api/transfer'
import { useJobsStore } from '@/jobs/store'
import { formatBytes, formatCount } from '@/format'
import { useShownJob } from './shownJobs'
import TransferSteps from './TransferSteps.vue'
import ExportExpiry from './ExportExpiry.vue'

/**
 * User request 2026-10-11: the SQL ↔ MongoDB page's export — collections, views and time-series
 * collections of the database chosen, written by one job into one SQL file; its progress, report
 * and download in place. Masked for a restricted user, as every export. One database at a time
 * (user request 2026-10-12). User request 2026-10-12: one step at a time — the collections, the
 * options — and the job followed on a page of its own, apart from the forms.
 */
/** `inSight`: in sight (its tab and part shown), how its job ends said here, no toast besides. */
const props = defineProps<{
  connectionId: string
  db: string
  preselect?: string
  inSight?: boolean
}>()
const { t, locale } = useI18n()
const jobs = useJobsStore()
const id = useId()
const n = (v: number) => formatCount(v, locale.value)

/** What a SQL export writes: collections, views and time-series collections, never a system one. */
const EXPORTABLE = new Set(['collection', 'view', 'timeseries'])
const listed = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db)),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db),
})
const list = computed<CollectionInfo[]>(() =>
  ((listed.data.value ?? []) as CollectionInfo[])
    .filter((c) => !c.name.startsWith('system.') && EXPORTABLE.has(c.type))
    .sort((a, b) => a.name.localeCompare(b.name)),
)
const picked = ref(new Set<string>())
// The collection it was opened for, or every one, chosen to begin with — again for another database.
let seeded = false
watch(
  () => props.db,
  () => {
    seeded = false
    // A finished export's card goes with its database; a running one stays in sight (review I2).
    if (phase.value !== 'running') {
      again()
      step.value = 'collections'
    }
  },
)
watch(
  [list, () => listed.isPending.value],
  ([names, loading]) => {
    if (seeded || loading) return
    seeded = true
    const only = props.preselect && names.some((c) => c.name === props.preselect) ? [props.preselect] : null
    picked.value = new Set(only ?? names.map((c) => c.name))
  },
  { immediate: true },
)
const filter = ref('')
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return q ? list.value.filter((c) => c.name.toLowerCase().includes(q)) : list.value
})
const allOn = computed(() => shown.value.length > 0 && shown.value.every((c) => picked.value.has(c.name)))
const someOn = computed(() => !allOn.value && shown.value.some((c) => picked.value.has(c.name)))
function set(names: string[], on: boolean): void {
  const next = new Set(picked.value)
  for (const name of names) {
    if (on) next.add(name)
    else next.delete(name)
  }
  picked.value = next
}
/** What is chosen, in the list's order, only what is still there. */
const chosen = computed(() => list.value.filter((c) => picked.value.has(c.name)).map((c) => c.name))
/** Why the choice cannot be sent, if it cannot (the server's limit, said before). */
const tooMany = computed(() =>
  chosen.value.length > SQL_EXPORT_MAX_COLLECTIONS
    ? t('sqlTransfer.export.tooMany', { max: n(SQL_EXPORT_MAX_COLLECTIONS) })
    : null,
)

const dialect = ref<SqlExportRequest['sql']['dialect']>('postgres')
const dialects = computed(() =>
  SQL_DIALECTS.map((d) => ({ value: d, label: t(`dataTransfer.sql.dialects.${d}`) })),
)
const rowsPerInsert = ref('100')
const rowsError = computed(() => {
  const v = Number(rowsPerInsert.value)
  return Number.isInteger(v) && v >= 1 && v <= 1000 ? null : t('sqlTransfer.export.rowsInvalid')
})
const transaction = ref(true)
const gzip = ref(false)
/** MySQL: nested values in LONGTEXT for older tools (user request 2026-10-12); MySQL's only. */
const jsonAsText = ref(false)
const transactionHint = computed(() =>
  t(
    dialect.value === 'mysql'
      ? 'sqlTransfer.export.transactionHintMysql'
      : 'sqlTransfer.export.transactionHint',
  ),
)

const errors = ref<string[]>([])
const busy = ref(false)
/** Its job: started here, or one of mine still running on this connection (the page shown again). */
const running = Object.values(jobs.byId)
  .filter(
    (j) =>
      j.mine &&
      j.kind === 'data.export' &&
      j.coll === '*' &&
      j.connectionId === props.connectionId &&
      j.db === props.db &&
      j.state === 'running',
  )
  .sort((a, b) => b.startedAt - a.startedAt)[0]
const jobId = ref<string | null>(running?.id ?? null)
useShownJob(
  jobId,
  computed(() => !!props.inSight),
)
const report = ref<ExportReport | null>(null)
const job = computed(() => (jobId.value ? jobs.byId[jobId.value] : undefined))
/** Running, done, or ended otherwise (failed, cancelled, interrupted): said so, never a spinner on. */
const phase = computed<'running' | 'done' | 'ended' | null>(() => {
  if (!jobId.value) return null
  const state = job.value?.state
  if (!state || state === 'running') return 'running'
  return state === 'done' ? 'done' : 'ended'
})
type Step = 'collections' | 'options' | 'run'
const STEPS: Step[] = ['collections', 'options', 'run']
/** An export running when the panel is built again is in sight, on its page. */
const step = ref<Step>(jobId.value ? 'run' : 'collections')
const steps = computed(() => STEPS.map((s) => ({ id: s, label: t(`sqlTransfer.steps.export.${s}`) })))
/** None while the export runs (its page stays); its page again once it ended, until another starts. */
const reachable = computed<Step[]>(() => {
  // None while it is being started either (review 2026-10-12, M3).
  if (busy.value || phase.value === 'running') return []
  const to: Step[] = ['collections']
  if (chosen.value.length && !tooMany.value) to.push('options')
  if (jobId.value) to.push('run')
  return to
})
/**
 * Where a step's focus goes: its heading, said and in sight — only for a step
 * asked for here, never for one the page changed (another database; review 2026-10-12, I4).
 */
const heading = ref<HTMLElement | null>(null)
function go(to: Step): void {
  step.value = to
  void nextTick(() => heading.value?.focus())
}
const percent = computed(() => {
  const p = job.value?.progress
  return p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null
})

async function start(): Promise<void> {
  if (!chosen.value.length || rowsError.value || tooMany.value) return
  errors.value = []
  report.value = null
  busy.value = true
  try {
    const started = await transferApi.exportSql(props.connectionId, props.db, {
      collections: chosen.value,
      sql: {
        dialect: dialect.value,
        rowsPerInsert: Number(rowsPerInsert.value),
        transaction: transaction.value,
        jsonAsText: dialect.value === 'mysql' && jsonAsText.value,
      },
      gzip: gzip.value,
    })
    jobs.upsert(started.job)
    jobId.value = started.job.id
    go('run')
  } catch (e) {
    errors.value = [describeError(e, t)]
  } finally {
    busy.value = false
  }
}
const stopping = ref(false)
async function stop(): Promise<void> {
  if (!jobId.value) return
  stopping.value = true
  try {
    jobs.upsert((await jobsApi.cancel(jobId.value)).job)
  } catch (e) {
    errors.value = [describeError(e, t)]
  } finally {
    stopping.value = false
  }
}
watch(phase, async (now) => {
  if (now !== 'done' || !jobId.value) return
  try {
    const r = await transferApi.report(jobId.value)
    if (r.kind === 'export') report.value = r
  } catch (e) {
    errors.value = [describeError(e, t)]
  }
})
/** Why it ended without a file, in the user's words. */
const endedText = computed(() => {
  const state = job.value?.state
  if (state === 'cancelled') return t('sqlTransfer.export.cancelled')
  if (state === 'interrupted') return t('sqlTransfer.export.interrupted')
  return job.value?.error ?? t('sqlTransfer.export.failed')
})
const fileName = computed(() => job.value?.target ?? 'export.sql')
/** The tables a report tells something about: renamed, or leaving fields or cells out. */
const notable = computed(() =>
  (report.value?.tables ?? [])
    .map((r) => ({ ...r, renamed: r.table !== r.collection }))
    .filter((r) => r.renamed || r.omittedFields.length > 0 || r.cutCells > 0),
)
function again(): void {
  jobId.value = null
  report.value = null
  errors.value = []
}
/** Another export, asked for here: its options again, what was chosen kept. */
function exportAgain(): void {
  again()
  go('options')
}

const typeIcon = (type: string) => (type === 'view' ? Eye : type === 'timeseries' ? TimerReset : Table2)
</script>

<template>
  <section class="flex flex-col gap-5 text-ui" data-sql-export>
    <DsFormErrors :messages="errors" />

    <!-- The list's state, except on the job's page: a running export stays in sight, its Stop too. -->
    <div
      v-if="listed.isPending.value && step !== 'run'"
      class="flex flex-col gap-2 py-2"
      role="status"
      :aria-label="t('tree.loading')"
    >
      <DsSkeleton v-for="row in 3" :key="row" class="h-5" />
    </div>
    <DsCallout v-else-if="listed.isError.value && step !== 'run'" tone="danger" data-export-failed>
      {{ describeError(listed.error.value, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="listed.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <DsEmptyState
      v-else-if="!list.length && step !== 'run'"
      :icon="Table2"
      :title="t('sqlTransfer.export.none')"
      :description="t('sqlTransfer.export.noneHint', { db })"
    />

    <template v-else>
      <TransferSteps
        :label="t('sqlTransfer.steps.label')"
        :steps="steps"
        :current="step"
        :reachable="reachable"
        @go="go"
      />

      <!-- The collections: which ones become tables. -->
      <section
        v-if="step === 'collections'"
        class="flex min-w-0 flex-col gap-2"
        :aria-labelledby="`${id}-list`"
        data-sql-step="collections"
      >
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 :id="`${id}-list`" ref="heading" tabindex="-1" class="font-semibold text-fg outline-none">
            {{ t('sqlTransfer.export.collections') }}
          </h3>
          <label class="flex cursor-pointer items-center gap-2 text-fg">
            <input
              type="checkbox"
              class="size-4 cursor-pointer accent-accent"
              :checked="allOn"
              :indeterminate="someOn"
              data-export-all
              @change="
                set(
                  shown.map((c) => c.name),
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />{{ t('sqlTransfer.export.all') }}
          </label>
          <div class="relative ml-auto w-full max-w-60">
            <Search
              class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              v-model="filter"
              type="search"
              :aria-label="t('sqlTransfer.export.filter')"
              :placeholder="t('sqlTransfer.export.filter')"
              class="h-8 w-full rounded-md border border-line-strong bg-surface pr-2 pl-7 text-small text-fg shadow-xs focus:border-focus focus:ring-3 focus:ring-focus/20 focus:outline-none"
            />
          </div>
        </div>
        <ul
          v-if="shown.length"
          class="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface"
        >
          <li v-for="c in shown" :key="c.name">
            <label
              class="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors duration-120 hover:bg-subtle"
              :data-export-collection="c.name"
            >
              <input
                type="checkbox"
                class="size-4 shrink-0 cursor-pointer accent-accent"
                :checked="picked.has(c.name)"
                @change="set([c.name], ($event.target as HTMLInputElement).checked)"
              />
              <component :is="typeIcon(c.type)" class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate font-mono text-fg">{{ c.name }}</span>
              <DsBadge v-if="c.type !== 'collection'">{{ t(`sqlTransfer.export.types.${c.type}`) }}</DsBadge>
            </label>
          </li>
        </ul>
        <p v-else class="text-small text-fg-subtle">{{ t('sqlTransfer.export.noMatch') }}</p>
        <p v-if="tooMany" role="alert" class="text-small text-danger" data-export-too-many>{{ tooMany }}</p>
      </section>

      <!-- The options: how the file is written. -->
      <div v-else-if="step === 'options'" class="flex flex-col gap-4" data-sql-step="options">
        <h3 ref="heading" tabindex="-1" class="font-semibold text-fg outline-none">
          {{ t('sqlTransfer.export.options') }}
        </h3>
        <div class="flex max-w-xl flex-col gap-4 rounded-xl border border-line bg-surface p-4">
          <div class="flex flex-col gap-1.5">
            <span class="text-small font-medium text-fg">{{ t('sqlTransfer.export.dialect') }}</span>
            <DsSegmented
              v-model="dialect"
              :label="t('sqlTransfer.export.dialect')"
              :options="dialects"
              size="sm"
              class="self-start"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label :for="`${id}-rows`" class="text-small font-medium text-fg">{{
              t('sqlTransfer.export.rowsPerInsert')
            }}</label>
            <input
              :id="`${id}-rows`"
              v-model="rowsPerInsert"
              inputmode="numeric"
              :aria-invalid="rowsError ? 'true' : undefined"
              :aria-describedby="rowsError ? `${id}-rows-error` : undefined"
              class="h-8 w-24 rounded-md border bg-surface px-2 font-mono text-small text-fg shadow-xs focus:ring-3 focus:outline-none"
              :class="
                rowsError ? 'border-danger' : 'border-line-strong focus:border-focus focus:ring-focus/20'
              "
            />
            <p v-if="rowsError" :id="`${id}-rows-error`" class="text-small text-danger">{{ rowsError }}</p>
          </div>
          <DsSwitch
            v-model="transaction"
            :label="t('sqlTransfer.export.transaction')"
            :hint="transactionHint"
          />
          <DsSwitch
            v-if="dialect === 'mysql'"
            v-model="jsonAsText"
            :label="t('sqlTransfer.export.jsonAsText')"
            :hint="t('sqlTransfer.export.jsonAsTextHint')"
            data-export-json-text
          />
          <DsSwitch v-model="gzip" :label="t('sqlTransfer.export.gzip')" />
          <p class="text-small text-fg-subtle">{{ t('sqlTransfer.export.oneFile') }}</p>
        </div>
      </div>

      <!-- The job, followed on a page of its own. -->
      <div v-else class="flex flex-col gap-4" data-sql-step="run">
        <h3 ref="heading" tabindex="-1" class="font-semibold text-fg outline-none">
          {{ t('sqlTransfer.export.runTitle') }}
        </h3>
        <div
          v-if="jobId"
          class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
          data-sql-export-job
        >
          <template v-if="phase === 'running'">
            <div class="flex flex-wrap items-center gap-3">
              <p class="flex items-center gap-2 font-medium text-fg" role="status" aria-live="polite">
                <DsSpinner />{{ t('sqlTransfer.export.running') }}
                <span v-if="percent !== null" class="text-fg-subtle tabular-nums">{{ percent }}%</span>
              </p>
              <DsButton
                class="ml-auto"
                size="sm"
                :icon="CircleStop"
                :loading="stopping"
                data-export-stop
                @click="stop"
                >{{ t('sqlTransfer.stop') }}</DsButton
              >
            </div>
            <DsProgress
              v-if="percent !== null"
              :label="t('sqlTransfer.export.running')"
              :value="percent / 100"
            />
          </template>
          <template v-else-if="phase === 'ended'">
            <p class="flex items-center gap-2 font-medium text-danger" role="alert" data-export-ended>
              <XCircle class="size-4" aria-hidden="true" />{{ endedText }}
            </p>
            <DsButton class="self-start" @click="exportAgain">{{ t('sqlTransfer.export.again') }}</DsButton>
          </template>
          <template v-else-if="report">
            <p class="flex items-center gap-2 font-medium text-fg" role="status">
              <CheckCircle2 class="size-4 text-accent-fg" aria-hidden="true" />
              {{
                t(
                  'sqlTransfer.export.ready',
                  { rows: n(report.written), size: formatBytes(report.bytes, locale) },
                  report.written,
                )
              }}
            </p>
            <DsCallout v-if="report.masked" tone="info">{{ t('sqlTransfer.export.masked') }}</DsCallout>
            <ul v-if="notable.length" class="flex flex-col gap-2 text-small" data-export-notes>
              <li v-for="r in notable" :key="r.collection" class="flex flex-col gap-0.5">
                <span class="font-mono text-fg">{{ r.collection }}</span>
                <span v-if="r.renamed" class="text-fg-muted">{{
                  t('sqlTransfer.export.renamed', { table: r.table })
                }}</span>
                <span v-if="r.omittedFields.length" class="text-warning">{{
                  t(
                    'sqlTransfer.export.omitted',
                    { fields: r.omittedFields.join(', ') },
                    r.omittedFields.length,
                  )
                }}</span>
                <span v-if="r.cutCells" class="text-warning">{{
                  t('sqlTransfer.export.cut', { n: n(r.cutCells) }, r.cutCells)
                }}</span>
              </li>
            </ul>
            <div class="flex flex-wrap items-center gap-2">
              <a
                :href="transferApi.fileUrl(jobId)"
                :download="fileName"
                class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 font-medium whitespace-nowrap text-on-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] transition-colors duration-120 hover:bg-accent-hover"
                data-export-download
              >
                <Download class="size-4" aria-hidden="true" />{{
                  t('sqlTransfer.export.download', { file: fileName })
                }}
              </a>
              <DsButton variant="ghost" @click="exportAgain">{{ t('sqlTransfer.export.again') }}</DsButton>
            </div>
            <ExportExpiry :expires-at="report.expiresAt" />
          </template>
          <div
            v-else-if="!errors.length"
            class="flex flex-col gap-2 py-2"
            role="status"
            :aria-label="t('tree.loading')"
          >
            <DsSkeleton v-for="row in 3" :key="row" class="h-5" />
          </div>
        </div>
      </div>

      <!-- What the step leads to, always at hand under a long list. -->
      <div
        v-if="step !== 'run'"
        class="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur pr-[max(0.25rem,var(--mm-launcher-clearance,0px))]"
        data-sql-export-actions
      >
        <p class="mr-auto text-small text-fg-subtle tabular-nums" aria-live="polite">
          {{ t('sqlTransfer.export.chosen', { n: n(chosen.length), total: n(list.length) }, list.length) }}
        </p>
        <template v-if="step === 'collections'">
          <DsButton
            variant="primary"
            :disabled="!chosen.length || !!tooMany"
            data-step-next
            @click="go('options')"
          >
            {{ t('sqlTransfer.steps.next') }}<ArrowRight class="size-4" aria-hidden="true" />
          </DsButton>
        </template>
        <template v-else>
          <DsButton variant="ghost" :disabled="busy" data-step-back @click="go('collections')">{{
            t('sqlTransfer.steps.back')
          }}</DsButton>
          <DsButton
            variant="primary"
            :icon="Download"
            :loading="busy"
            :disabled="!chosen.length || !!rowsError || !!tooMany"
            data-export-start
            @click="start"
          >
            {{ t('sqlTransfer.export.start', { n: n(chosen.length) }, chosen.length) }}
          </DsButton>
        </template>
      </div>
    </template>
  </section>
</template>
