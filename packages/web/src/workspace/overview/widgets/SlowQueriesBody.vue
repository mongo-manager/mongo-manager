<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { SlowQueriesQuery } from '@mongo-manager/shared/browser'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import WidgetError from './WidgetError.vue'
import WidgetLink from './WidgetLink.vue'
import { widgetError } from './errors'
import { useOpenSection } from './openSection'

/**
 * Widgets wave 2 (2026-10-27; Atlas RTPP's slowest operations): a server's latest slow operations —
 * kind, namespace, plan, duration and documents examined per returned, from the server log (which
 * holds every database's; the profiler is one database's). Never the command: the Performance page
 * shows it, masked as the user's rules say.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const open = useOpenSection()
const QUERY: SlowQueriesQuery = { limit: 5, source: 'log' }
const slow = useQuery({
  queryKey: computed(() => serverKeys.slowQueries(props.connectionId, QUERY)),
  queryFn: () => serverApi.slowQueries(props.connectionId, QUERY),
  refetchInterval: 60_000,
})
const rows = computed(() =>
  (slow.data.value?.entries ?? []).slice(0, 5).map((e, i) => ({
    key: `${e.ts}:${i}`,
    op: e.op,
    ns: e.ns || '—',
    plan: e.planSummary ?? null,
    ms: t('overview.slow.ms', { n: new Intl.NumberFormat(locale.value).format(e.durationMs) }),
    // Nothing returned: no ratio to say (never "Infinity").
    ratio:
      e.docsExamined !== undefined && e.nreturned !== undefined && e.nreturned > 0
        ? t('overview.slow.ratio', {
            n: new Intl.NumberFormat(locale.value).format(Math.round(e.docsExamined / e.nreturned)),
          })
        : null,
  })),
)
/** Why MongoDB would not give its log, in the Performance page's words. */
const refused = computed(() => slow.data.value?.refused.log ?? null)
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="slow.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="slow.isError.value"
      :text="t(`overview.errors.${widgetError(slow.error.value)}`)"
      :retry="() => void slow.refetch()"
    />
    <template v-else>
      <p v-if="!rows.length" class="py-1 text-small text-fg-subtle">{{ t('overview.slow.none') }}</p>
      <ul v-else class="-mx-1 flex flex-col">
        <li
          v-for="r in rows"
          :key="r.key"
          data-slow-query
          class="flex min-w-0 flex-col gap-0.5 rounded-lg px-1 py-1.5"
        >
          <span class="flex min-w-0 items-center gap-2.5">
            <span
              class="w-14 shrink-0 rounded-md bg-subtle px-1.5 py-px text-center text-small text-fg-muted"
              >{{ r.op }}</span
            >
            <span class="min-w-0 flex-1 truncate font-mono text-small text-fg">{{ r.ns }}</span>
            <span class="shrink-0 text-small font-medium text-fg tabular-nums">{{ r.ms }}</span>
          </span>
          <span v-if="r.plan || r.ratio" class="flex flex-wrap gap-x-3 pl-16 text-caption text-fg-subtle">
            <span v-if="r.plan" class="truncate font-mono">{{ r.plan }}</span>
            <span v-if="r.ratio">{{ r.ratio }}</span>
          </span>
        </li>
      </ul>
      <p v-if="refused" class="text-small text-fg-subtle">
        {{ t(`slowQueries.refused.log.${refused}`) }}
      </p>
    </template>
    <WidgetLink @open="open(connectionId, 'performance')">{{ t('overview.operations.seeAll') }}</WidgetLink>
  </div>
</template>
