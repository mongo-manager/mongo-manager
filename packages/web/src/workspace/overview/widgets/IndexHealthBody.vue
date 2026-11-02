<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import WidgetError from './WidgetError.vue'
import WidgetLink from './WidgetLink.vue'
import { useWidget } from './context'
import { widgetError } from './errors'
import { useOpenSection } from './openSection'

/**
 * Widgets wave 2 (2026-10-27; Atlas Performance Advisor's create and drop suggestions): one database's
 * index health — the indexes its slow queries miss, those unused, those another's prefix repeats —
 * from the Performance page's index advice. It reads the profiler and the log, so once in ten minutes.
 */
const props = defineProps<{ connectionId: string }>()
const { t } = useI18n()
const open = useOpenSection()
const widget = useWidget()
const db = computed(() => (widget?.value.widget.settings as { db?: string } | undefined)?.db ?? '')
const advice = useQuery({
  queryKey: computed(() => serverKeys.indexAdvice(props.connectionId, db.value)),
  queryFn: () => serverApi.indexAdvice(props.connectionId, db.value),
  enabled: computed(() => db.value !== ''),
  // Review of wave 2 (M4): once in ten minutes, not again at each focus of the window.
  staleTime: 10 * 60_000,
  refetchInterval: 10 * 60_000,
  refetchOnWindowFocus: false,
})
const counts = computed(() => {
  const a = advice.data.value
  return [
    { key: 'missing', n: a?.suggestions.length ?? 0 },
    { key: 'unused', n: a?.unneeded.filter((u) => u.reason === 'unused').length ?? 0 },
    { key: 'prefix', n: a?.unneeded.filter((u) => u.reason === 'prefix').length ?? 0 },
  ] as const
})
const first = computed(() =>
  (advice.data.value?.suggestions ?? []).slice(0, 3).map((s) => ({
    ns: s.ns,
    key: `{ ${s.key.map(([f, d]) => `${f}: ${d}`).join(', ')} }`,
  })),
)
const healthy = computed(() => counts.value.every((c) => c.n === 0))
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="text-small text-fg-subtle">{{ t('overview.indexHealth.database', { db }) }}</p>
    <div v-if="advice.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="advice.isError.value"
      :text="t(`overview.errors.${widgetError(advice.error.value)}`)"
      :retry="() => void advice.refetch()"
    />
    <template v-else>
      <dl class="grid grid-cols-3 gap-2">
        <div v-for="c in counts" :key="c.key" class="rounded-lg bg-subtle px-2.5 py-2">
          <dt class="text-caption text-fg-subtle">{{ t(`overview.indexHealth.counts.${c.key}`) }}</dt>
          <dd
            :data-index-count="c.key"
            class="text-title font-semibold tabular-nums"
            :class="c.n ? 'text-warning' : 'text-fg'"
          >
            {{ c.n }}
          </dd>
        </div>
      </dl>
      <p v-if="healthy" class="text-small text-fg-subtle">{{ t('overview.indexHealth.none', { db }) }}</p>
      <ul v-else-if="first.length" class="-mx-1 flex flex-col">
        <li
          v-for="s in first"
          :key="`${s.ns} ${s.key}`"
          class="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-small"
        >
          <span class="min-w-0 truncate font-mono text-fg">{{ s.ns }}</span>
          <span class="min-w-0 truncate font-mono text-fg-muted">{{ s.key }}</span>
        </li>
      </ul>
      <p
        v-if="advice.data.value?.refused.profile && advice.data.value?.refused.log"
        class="text-small text-fg-subtle"
      >
        {{ t('overview.indexHealth.refused') }}
      </p>
    </template>
    <WidgetLink @open="open(connectionId, 'performance')">{{
      t('overview.indexHealth.seeAdvice')
    }}</WidgetLink>
  </div>
</template>
