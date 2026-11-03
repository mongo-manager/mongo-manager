<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CheckCircle2, Download, ShieldAlert } from 'lucide-vue-next'
import type { DumpReport, RestoreReport } from '@mongo-manager/shared/browser'
import { backupApi } from '@/api/backup'
import { transferApi } from '@/api/transfer'
import { formatBytes, formatCount } from '@/format'

/** A dump or restore report, inside a job row (spec §7.2). */
defineProps<{ jobId: string; report: DumpReport | RestoreReport }>()
const { t, locale } = useI18n()
const n = (v: number) => formatCount(v, locale.value)
const bad = (ns: RestoreReport['namespaces'][number]) => ns.crc === 'mismatch' || Boolean(ns.failure)
</script>

<template>
  <div class="flex flex-col gap-2 text-ui" data-backup-report>
    <template v-if="report.kind === 'dump'">
      <ul class="flex flex-col gap-1">
        <li
          v-for="ns in report.namespaces"
          :key="`${ns.db}.${ns.coll}`"
          class="flex flex-wrap items-center gap-2"
        >
          <span class="font-mono text-small">{{ ns.db }}.{{ ns.coll }}</span>
          <span v-if="ns.skipped" class="text-small text-warning">{{ ns.skipped }}</span>
          <span v-else class="text-small text-fg-subtle">{{
            t('backup.report.written', { count: n(ns.written) })
          }}</span>
          <span v-if="ns.note" class="basis-full text-small text-fg-subtle">{{ ns.note }}</span>
        </li>
      </ul>
      <a
        v-if="report.backupId"
        :href="backupApi.downloadUrl(report.backupId)"
        download
        class="inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-small font-medium text-accent-fg hover:bg-accent-soft"
      >
        <Download class="size-3.5" aria-hidden="true" />{{ t('backup.report.download') }} ·
        {{ formatBytes(report.size, locale) }}
      </a>
    </template>
    <template v-else>
      <p v-if="report.dryRun" class="text-small font-medium">{{ t('backup.restore.dryRun') }}</p>
      <ul class="flex flex-col gap-1">
        <li v-for="ns in report.namespaces" :key="ns.to" class="flex flex-wrap items-center gap-2">
          <component
            :is="bad(ns) ? ShieldAlert : CheckCircle2"
            class="size-3.5"
            :class="bad(ns) ? 'text-danger' : 'text-success'"
            aria-hidden="true"
          />
          <span class="font-mono text-small">{{ ns.from }} → {{ ns.to }}</span>
          <span class="text-small text-fg-subtle tabular-nums"
            >{{ n(ns.inserted + ns.upserted + ns.modified) }} / {{ n(ns.read) }}</span
          >
          <span v-if="ns.failed" class="text-small text-danger tabular-nums">{{
            t('backup.report.refused', { count: n(ns.failed) })
          }}</span>
          <!-- Backup review M10: deleted by a TTL index as soon as they were written. -->
          <span v-if="'expiring' in ns && ns.expiring" class="text-small text-warning tabular-nums">{{
            t(
              report.dryRun ? 'backup.report.wouldExpire' : 'backup.report.expiring',
              { count: n(ns.expiring) },
              ns.expiring,
            )
          }}</span>
          <!-- Backup review M9: found stored as the backup has them (a restore run again). -->
          <span
            v-if="'alreadyThere' in ns && ns.alreadyThere"
            class="text-small text-fg-subtle tabular-nums"
            >{{ t('backup.report.alreadyThere', { count: n(ns.alreadyThere) }) }}</span
          >
          <span class="text-small text-fg-subtle">{{ t(`backup.report.crc.${ns.crc}`) }}</span>
          <span v-if="ns.failure" class="basis-full text-small text-danger">{{ ns.failure }}</span>
        </li>
      </ul>
      <ul v-if="report.views.length" class="flex flex-col gap-0.5 text-small text-fg-subtle">
        <li v-for="v in report.views" :key="v.name">
          <span class="font-mono">{{ v.name }}</span
          ><template v-if="v.reason">: {{ v.reason }}</template>
        </li>
      </ul>
      <a
        v-if="report.rejectedFile"
        :href="transferApi.rejectedUrl(jobId)"
        download
        class="w-fit text-small font-medium text-accent-fg underline-offset-2 hover:underline"
        >{{ t('dataTransfer.report.downloadRejected') }}</a
      >
    </template>
    <details v-if="report.toolLog?.length" class="text-small">
      <summary class="cursor-pointer text-fg-subtle">{{ t('backup.report.toolLog') }}</summary>
      <pre class="mt-1 max-h-40 overflow-auto rounded-md bg-subtle p-2">{{ report.toolLog.join('\n') }}</pre>
    </details>
  </div>
</template>
