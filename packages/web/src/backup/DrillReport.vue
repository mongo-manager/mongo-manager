<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { DrillReport } from '@mongo-manager/shared/browser'
import DsCallout from '@/ds/DsCallout.vue'
import { formatCount } from '@/format'

/**
 * W4.4: what a restore drill found — per namespace, the documents the backup holds and those that
 * came back from the scratch database, and whether they are the same.
 */
defineProps<{ report: DrillReport }>()
const { t, locale } = useI18n()
const n = (v: number) => formatCount(v, locale.value)
const TONE = { match: 'text-success', mismatch: 'text-danger', skipped: 'text-fg-subtle' } as const
</script>

<template>
  <div class="flex flex-col gap-2 text-ui" data-backup-report>
    <DsCallout :tone="report.ok ? 'success' : 'danger'">
      {{ report.ok ? t('backup.drill.reportOk') : t('backup.drill.reportFailed') }}
      <span v-if="report.failure" class="block text-small text-fg-muted">{{ report.failure }}</span>
    </DsCallout>
    <!-- W4 review I2: a scratch database left behind holds a copy of the backup: said, named. -->
    <DsCallout v-if="report.cleanup === 'failed'" tone="warning" data-test="drill-cleanup">
      {{ t('backup.drill.cleanupFailed', { name: report.scratch ?? '' }) }}
    </DsCallout>
    <div class="max-h-60 overflow-auto rounded-md border border-line">
      <table class="w-full text-small" data-test="drill-report">
        <caption class="sr-only">
          {{
            t('backup.drill.namespaces')
          }}
        </caption>
        <thead class="sticky top-0 bg-subtle text-left text-fg-subtle">
          <tr>
            <th scope="col" class="p-1.5 font-medium">{{ t('backup.drill.ns') }}</th>
            <th scope="col" class="p-1.5 text-right font-medium">{{ t('backup.drill.archived') }}</th>
            <th scope="col" class="p-1.5 text-right font-medium">{{ t('backup.drill.restored') }}</th>
            <th scope="col" class="p-1.5 font-medium">{{ t('backup.drill.contents') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ns in report.namespaces" :key="ns.ns" class="border-t border-line">
            <th scope="row" class="p-1.5 text-left font-mono font-normal break-all">{{ ns.ns }}</th>
            <td class="p-1.5 text-right tabular-nums">{{ n(ns.archived) }}</td>
            <td class="p-1.5 text-right tabular-nums">{{ n(ns.restored) }}</td>
            <td class="p-1.5" :class="TONE[ns.contents]">
              {{ t(`backup.drill.result.${ns.contents}`) }}
              <span v-if="ns.crc === 'mismatch'" class="text-danger">· {{ t('backup.drill.crc') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
