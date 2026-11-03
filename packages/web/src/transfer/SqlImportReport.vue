<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SqlImportReport, SqlImportTableReport } from '@mongo-manager/shared/browser'
import { transferApi } from '@/api/transfer'
import { formatCount } from '@/format'
import { skippedList } from './sqlText'
import { unfinishedText } from './unfinished'

/**
 * SQL transfer spec §3: what a SQL dump's import did — per table (into which collection, read,
 * written, failed), the statements it never ran, the first failed rows and the rejected-rows file.
 */
const props = defineProps<{ report: SqlImportReport; jobId: string }>()
const { t, locale } = useI18n()
const n = (v: number) => formatCount(v, locale.value)

const ALWAYS = ['read', 'inserted', 'matched', 'modified', 'upserted'] as const
/** "Nothing to change" (a merge of a row with only its key) is a column only when it happened. */
const hasSkipped = computed(() => props.report.tables.some((r) => (r.skipped ?? 0) > 0))
const COUNTS = computed(() =>
  hasSkipped.value ? ([...ALWAYS, 'skipped', 'failed'] as const) : ([...ALWAYS, 'failed'] as const),
)
const hasWouldMatch = computed(() => props.report.tables.some((r) => r.wouldMatch !== undefined))
const total = computed<Omit<SqlImportTableReport, 'table' | 'collection'>>(() => {
  const sum = (k: (typeof ALWAYS)[number] | 'skipped' | 'failed') =>
    props.report.tables.reduce((s, r) => s + (r[k] ?? 0), 0)
  return {
    read: sum('read'),
    inserted: sum('inserted'),
    matched: sum('matched'),
    modified: sum('modified'),
    upserted: sum('upserted'),
    skipped: sum('skipped'),
    failed: sum('failed'),
    ...(hasWouldMatch.value
      ? { wouldMatch: props.report.tables.reduce((s, r) => s + (r.wouldMatch ?? 0), 0) }
      : {}),
  }
})
const skipped = computed(() => skippedList(props.report.skipped, locale.value))
const shown = computed(() => props.report.errors.slice(0, 50))
/** A count the report does not hold for a table. */
const NONE = '—'
const cell = 'px-2.5 py-1.5 text-right tabular-nums'
</script>

<template>
  <section class="flex flex-col gap-3 text-ui" data-transfer-report data-sql-report>
    <p v-if="report.dryRun" class="font-medium text-fg">{{ t('dataTransfer.report.dryRun') }}</p>
    <div class="overflow-x-auto rounded-lg border border-line">
      <table class="w-full text-small">
        <caption class="sr-only">
          {{
            t('dataTransfer.sql.report.caption')
          }}
        </caption>
        <thead class="bg-subtle text-fg-muted">
          <tr>
            <th scope="col" class="px-2.5 py-1.5 text-left font-medium">
              {{ t('dataTransfer.sql.report.table') }}
            </th>
            <th scope="col" class="px-2.5 py-1.5 text-left font-medium">
              {{ t('dataTransfer.sql.report.collection') }}
            </th>
            <th v-for="k in COUNTS" :key="k" scope="col" :class="[cell, 'font-medium']">
              {{ t(`dataTransfer.sql.report.${k}`) }}
            </th>
            <th v-if="hasWouldMatch" scope="col" :class="[cell, 'font-medium']">
              {{ t('dataTransfer.sql.report.wouldMatch') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in report.tables" :key="r.table" class="border-t border-line">
            <th scope="row" class="max-w-48 truncate px-2.5 py-1.5 text-left font-mono font-normal text-fg">
              {{ r.table }}
            </th>
            <td class="max-w-48 truncate px-2.5 py-1.5 font-mono text-fg">{{ r.collection }}</td>
            <td
              v-for="k in COUNTS"
              :key="k"
              :class="[cell, k === 'failed' && r.failed > 0 ? 'font-medium text-danger' : 'text-fg']"
            >
              {{ n(r[k] ?? 0) }}
            </td>
            <td v-if="hasWouldMatch" :class="[cell, 'text-fg']">
              {{ r.wouldMatch === undefined ? NONE : n(r.wouldMatch) }}
            </td>
          </tr>
        </tbody>
        <tfoot v-if="report.tables.length > 1" class="border-t border-line-strong font-medium">
          <tr>
            <th scope="row" colspan="2" class="px-2.5 py-1.5 text-left">
              {{ t('dataTransfer.sql.report.total') }}
            </th>
            <td
              v-for="k in COUNTS"
              :key="k"
              :class="[cell, k === 'failed' && total.failed > 0 ? 'text-danger' : '']"
            >
              {{ n(total[k]) }}
            </td>
            <td v-if="hasWouldMatch" :class="cell">{{ n(total.wouldMatch ?? 0) }}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p v-if="report.dumpError" class="text-small text-warning">
      {{ t('dataTransfer.sql.report.dumpError', { reason: report.dumpError }) }}
    </p>
    <p v-if="report.stoppedAt?.table" class="text-small text-warning">
      {{
        t('dataTransfer.sql.report.stopped', {
          table: report.stoppedAt.table,
          record: report.stoppedAt.record,
        })
      }}
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
    <p v-if="skipped" class="text-small text-fg-subtle">
      {{ t('dataTransfer.sql.skipped', { list: skipped }) }}
    </p>
    <ol
      v-if="shown.length"
      class="max-h-48 overflow-auto rounded-md bg-subtle p-2 font-mono text-small"
      :aria-label="t('dataTransfer.sql.report.errors')"
    >
      <li v-for="(e, i) in shown" :key="i">
        {{
          e.field
            ? t('dataTransfer.sql.report.errorField', {
                table: e.table,
                record: e.record,
                field: e.field,
                reason: e.reason,
              })
            : t('dataTransfer.sql.report.error', { table: e.table, record: e.record, reason: e.reason })
        }}
      </li>
    </ol>
    <p v-if="report.moreErrors || report.errors.length > shown.length" class="text-small text-fg-subtle">
      {{ t('dataTransfer.sql.report.moreErrors') }}
    </p>
    <a
      v-if="report.rejectedFile"
      :href="transferApi.rejectedUrl(jobId)"
      class="self-start text-accent-fg underline hover:no-underline"
      download
    >
      {{ t('dataTransfer.sql.report.downloadRejected') }}
    </a>
    <p v-else-if="report.rejectedDropped" class="text-small text-warning">
      {{ t('dataTransfer.report.rejectedDropped') }}
    </p>
  </section>
</template>
