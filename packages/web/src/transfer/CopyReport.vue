<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CopyReport, RowError, SyncReport } from '@mongo-manager/shared/browser'
import { transferApi } from '@/api/transfer'
import { formatCount } from '@/format'

/** Phase 3d-2 spec §3.3: what a copy or a sync did, per collection. */
const props = defineProps<{ report: CopyReport | SyncReport; jobId: string }>()
const { t, locale } = useI18n()
const n = (v: number) => formatCount(v, locale.value)

const COPY_COUNTS = ['read', 'inserted', 'matched', 'modified', 'upserted', 'skipped', 'failed'] as const
const copyCounts = (c: CopyReport['collections'][number]) => [
  ...COPY_COUNTS.filter((k) => k === 'read' || c[k] > 0).map((k) =>
    t(`dataTransfer.report.${k}`, { n: n(c[k]) }),
  ),
  ...(c.wouldMatch !== undefined ? [t('dataTransfer.report.wouldMatch', { n: n(c.wouldMatch) })] : []),
]
const syncCounts = (c: SyncReport['collections'][number]) => [
  t('dataTransfer.report.inserted', { n: n(c.inserted) }),
  t('dataTransfer.sync.replaced', { n: n(c.replaced) }),
  t('dataTransfer.sync.deleted', { n: n(c.deleted) }),
  ...(c.changedMeanwhile ? [t('dataTransfer.sync.changedMeanwhile', { n: n(c.changedMeanwhile) })] : []),
  ...(c.outsideFilter
    ? [t('dataTransfer.sync.outsideFilter', { n: n(c.outsideFilter) }, c.outsideFilter)]
    : []),
  ...(c.failed ? [t('dataTransfer.report.failed', { n: n(c.failed) })] : []),
]
const errorLine = (e: RowError) =>
  e.field
    ? t('dataTransfer.report.errorField', { record: e.record, field: e.field, reason: e.reason })
    : t('dataTransfer.report.error', { record: e.record, reason: e.reason })
const copy = props.report.kind === 'copy' ? props.report : null
const sync = props.report.kind === 'sync' ? props.report : null
</script>

<template>
  <section class="flex flex-col gap-3 text-ui" data-transfer-report>
    <template v-if="copy">
      <p v-if="copy.dryRun" class="font-medium">{{ t('dataTransfer.report.dryRun') }}</p>
      <div v-for="c in copy.collections" :key="c.source" class="flex flex-col gap-1">
        <p class="font-mono text-small font-medium">{{ c.source }} → {{ c.target }}</p>
        <ul class="flex flex-wrap gap-x-4 gap-y-1">
          <li v-for="line in copyCounts(c)" :key="line">{{ line }}</li>
        </ul>
        <p v-if="c.path === 'shortcut'" class="text-small text-fg-subtle">
          {{ t('dataTransfer.copy.report.pathShortcut') }}
        </p>
        <p v-if="c.failure" class="text-small text-danger">{{ c.failure }}</p>
        <p v-if="c.validatorBeforeLoad" class="text-small text-warning" data-validator-before-load>
          {{ t('dataTransfer.copy.report.validatorBeforeLoad') }}
        </p>
        <p v-if="c.indexes.built.length" class="text-small">
          {{ t('dataTransfer.copy.report.indexesBuilt', { names: c.indexes.built.join(', ') }) }}
        </p>
        <p v-for="s in c.indexes.skipped" :key="s.name" class="text-small text-warning">
          {{ t('dataTransfer.copy.report.indexSkipped', { name: s.name, reason: s.reason }) }}
        </p>
        <ol
          v-if="c.errors.length"
          class="max-h-40 overflow-auto rounded-md bg-subtle p-2 font-mono text-small"
          :aria-label="t('dataTransfer.report.errors')"
        >
          <li v-for="(e, i) in c.errors.slice(0, 50)" :key="i">{{ errorLine(e) }}</li>
        </ol>
        <p v-if="c.moreErrors || c.errors.length > 50" class="text-small text-fg-subtle">
          {{ t('dataTransfer.report.moreErrors') }}
        </p>
      </div>
      <ul v-if="copy.views.length" class="flex flex-col gap-0.5 text-small">
        <li v-for="v in copy.views" :key="v.name">
          {{
            v.created
              ? v.reason
                ? t('dataTransfer.copy.report.viewCreatedNoSource', { name: v.name })
                : t('dataTransfer.copy.report.viewCreated', { name: v.name })
              : t('dataTransfer.copy.report.viewNotCreated', { name: v.name, reason: v.reason ?? '' })
          }}
        </li>
      </ul>
      <p v-if="copy.stoppedAt" class="text-small text-danger">
        {{ t('dataTransfer.copy.report.stopped', copy.stoppedAt) }}
      </p>
      <p v-if="copy.rulesAdded" class="text-small">
        {{ t('dataTransfer.copy.report.rulesAdded', { n: copy.rulesAdded }) }}
      </p>
      <p v-if="copy.anonymous" class="text-small text-fg-subtle">
        {{ t('dataTransfer.copy.report.anonymous') }}
      </p>
      <p v-if="copy.masked" class="text-small text-fg-subtle">{{ t('dataTransfer.copy.maskedNotice') }}</p>
      <a
        v-if="copy.rejectedFile"
        :href="transferApi.rejectedUrl(jobId)"
        class="self-start text-accent-fg underline hover:no-underline"
        download
      >
        {{ t('dataTransfer.report.downloadRejected') }}
      </a>
      <p v-else-if="copy.rejectedDropped" class="text-small text-warning">
        {{ t('dataTransfer.report.rejectedDropped') }}
      </p>
    </template>
    <template v-else-if="sync">
      <div v-for="c in sync.collections" :key="c.source" class="flex flex-col gap-1">
        <p class="font-mono text-small font-medium">{{ c.source }} → {{ c.target }}</p>
        <ul class="flex flex-wrap gap-x-4 gap-y-1">
          <li v-for="line in syncCounts(c)" :key="line">{{ line }}</li>
        </ul>
        <p v-if="c.deletionStopped" class="text-small text-warning">
          {{ t('dataTransfer.sync.deletionStopped') }}
        </p>
        <p v-if="c.failure" class="text-small text-danger">{{ c.failure }}</p>
        <ol
          v-if="c.errors.length"
          class="max-h-40 overflow-auto rounded-md bg-subtle p-2 font-mono text-small"
          :aria-label="t('dataTransfer.report.errors')"
        >
          <li v-for="(e, i) in c.errors.slice(0, 50)" :key="i">{{ errorLine(e) }}</li>
        </ol>
      </div>
    </template>
  </section>
</template>
