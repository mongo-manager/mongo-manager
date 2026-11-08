<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TransferReport } from '@mongo-manager/shared/browser'
import { transferApi } from '@/api/transfer'
import { formatCount } from '@/format'
import CopyReport from './CopyReport.vue'
import SqlImportReport from './SqlImportReport.vue'
import BackupReport from '@/backup/BackupReport.vue'
import DrillReport from '@/backup/DrillReport.vue'
import { unfinishedText } from './unfinished'
import ExportExpiry from './ExportExpiry.vue'

/**
 * Phase 3d-1 spec §6.3: what a transfer did — counts, the first errors, and the files it left. Copy
 * and sync reports (phase 3d-2) and a SQL dump's import have their own card.
 */
const props = defineProps<{ report: TransferReport; jobId: string }>()
const { t, locale } = useI18n()
const n = (v: number) => formatCount(v, locale.value)

const COUNTS = ['read', 'inserted', 'matched', 'modified', 'upserted', 'skipped', 'failed'] as const
const counts = computed(() => {
  const r = props.report
  if (r.kind === 'export') return [t('dataTransfer.report.written', { n: n(r.written) })]
  if (r.kind !== 'import') return []
  return COUNTS.filter((k) => k === 'read' || r[k] > 0).map((k) =>
    t(`dataTransfer.report.${k}`, { n: n(r[k]) }),
  )
})
const shown = computed(() => (props.report.kind === 'import' ? props.report.errors.slice(0, 50) : []))
</script>

<template>
  <CopyReport v-if="report.kind === 'copy' || report.kind === 'sync'" :report="report" :job-id="jobId" />
  <SqlImportReport v-else-if="report.kind === 'importSql'" :report="report" :job-id="jobId" />
  <DrillReport v-else-if="report.kind === 'drill'" :report="report" />
  <BackupReport
    v-else-if="report.kind === 'dump' || report.kind === 'restore'"
    :report="report"
    :job-id="jobId"
  />
  <section
    v-else-if="report.kind === 'import' || report.kind === 'export'"
    class="flex flex-col gap-2 text-ui"
    data-transfer-report
  >
    <p v-if="report.kind === 'import' && report.dryRun" class="font-medium">
      {{ t('dataTransfer.report.dryRun') }}
    </p>
    <ul class="flex flex-wrap gap-x-4 gap-y-1">
      <li v-for="c in counts" :key="c">{{ c }}</li>
      <li v-if="report.kind === 'import' && report.wouldMatch !== undefined">
        {{ t('dataTransfer.report.wouldMatch', { n: n(report.wouldMatch) }) }}
      </li>
    </ul>
    <template v-if="report.kind === 'import'">
      <!-- W4.1: per mapped field, how many values converted to the chosen type and how many did not. -->
      <div v-if="report.fields.length" class="max-h-48 overflow-auto rounded-md border border-line">
        <table class="w-full text-small" data-test="field-conversions">
          <caption class="sr-only">
            {{
              t('dataTransfer.report.conversions')
            }}
          </caption>
          <thead class="sticky top-0 bg-subtle text-left text-fg-subtle">
            <tr>
              <th scope="col" class="p-1.5 font-medium">{{ t('dataTransfer.report.conversionField') }}</th>
              <th scope="col" class="p-1.5 text-right font-medium">
                {{ t('dataTransfer.report.conversionOk') }}
              </th>
              <th scope="col" class="p-1.5 text-right font-medium">
                {{ t('dataTransfer.report.conversionFailed') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in report.fields" :key="f.source" class="border-t border-line">
              <th scope="row" class="p-1.5 text-left font-mono font-normal break-all">{{ f.source }}</th>
              <td class="p-1.5 text-right tabular-nums">{{ n(f.converted) }}</td>
              <td class="p-1.5 text-right tabular-nums" :class="f.failed ? 'text-warning' : ''">
                {{ n(f.failed) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ol
        v-if="shown.length"
        class="max-h-48 overflow-auto rounded-md bg-subtle p-2 font-mono text-small"
        :aria-label="t('dataTransfer.report.errors')"
      >
        <li v-for="(e, i) in shown" :key="i">
          {{
            e.field
              ? t('dataTransfer.report.errorField', { record: e.record, field: e.field, reason: e.reason })
              : t('dataTransfer.report.error', { record: e.record, reason: e.reason })
          }}
        </li>
      </ol>
      <p v-if="report.moreErrors || report.errors.length > shown.length" class="text-small text-fg-subtle">
        {{ t('dataTransfer.report.moreErrors') }}
      </p>
      <a
        v-if="report.rejectedFile"
        :href="transferApi.rejectedUrl(jobId)"
        class="self-start text-accent-fg underline hover:no-underline"
        download
      >
        {{ t('dataTransfer.report.downloadRejected') }}
      </a>
      <p v-else-if="report.rejectedDropped" class="text-small text-warning">
        {{ t('dataTransfer.report.rejectedDropped') }}
      </p>
      <!-- Data review 2026-10-13: a run that did not finish says what it wrote. -->
      <template v-if="report.unfinished">
        <p class="text-small text-warning" data-test="unfinished">
          {{ unfinishedText(t, n, report.unfinished) }}
        </p>
        <p v-if="report.mode === 'insert' && report.unfinished.written" class="text-small">
          {{
            t(
              'dataTransfer.report.unfinishedAgain',
              { n: n(report.unfinished.written) },
              report.unfinished.written,
            )
          }}
        </p>
      </template>
    </template>
    <template v-else>
      <ExportExpiry :expires-at="report.expiresAt" />
      <p v-if="report.masked" class="text-small text-fg-subtle">{{ t('dataTransfer.maskedNotice') }}</p>
      <p v-if="report.omittedFields.length" class="text-small">
        {{ t('dataTransfer.report.omitted', { fields: report.omittedFields.join(', ') }) }}
      </p>
      <p v-if="report.cutCells" class="text-small">
        {{ t('dataTransfer.report.cut', { n: n(report.cutCells) }) }}
      </p>
    </template>
  </section>
</template>
