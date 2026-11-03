<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { ArrowRight } from 'lucide-vue-next'
import type { AiCost, AiUsageCount } from '@mongo-manager/shared/browser'
import { aiHistoryApi, aiHistoryKeys } from '@/api/aiHistory'
import { useHistoryWords } from '@/ai/history/historyWords'
import { useTabsStore } from '@/stores/tabs'
import DsSpinner from '@/ds/DsSpinner.vue'
import { openAiHistoryTab } from '../../openTabs'
import WidgetFrame from './WidgetFrame.vue'
import DayColumns from './DayColumns.vue'
import WidgetError from './WidgetError.vue'

/**
 * User review 2026-10-09: the user's AI usage at a glance — today and this month (requests, tokens,
 * cost), and a column a day for the last 30 days, the days in the reader's time zone.
 */
const { t, locale, tokens, exact, costs } = useHistoryWords()
const tabs = useTabsStore()
/** The time, a minute at a time: the day and the month move on at midnight (final review 8). */
const now = ref(new Date())
const ticker = setInterval(() => (now.value = new Date()), 60_000)
onBeforeUnmount(() => clearInterval(ticker))
/** The offset the days are counted in (minutes east of UTC), as the server takes it. */
const tz = computed(() => -now.value.getTimezoneOffset())
// 31 days: this month whole on its last day, and 30 columns.
const DAYS = 31
const usage = useQuery({
  queryKey: computed(() => aiHistoryKeys.usage(DAYS, false, tz.value)),
  queryFn: () => aiHistoryApi.usage(DAYS, false, tz.value),
  refetchInterval: 5 * 60_000,
})

/** A local day as the server names it (YYYY-MM-DD). */
function dayOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const today = computed(() => dayOf(now.value))
const month = computed(() => today.value.slice(0, 8))
// A new day: its requests are asked for at once.
watch(today, () => void usage.refetch())
const EMPTY: AiUsageCount = { requests: 0, input: 0, output: 0, cost: [] }

/** Several days' counts as one, a sum per currency. */
function sum(list: AiUsageCount[]): AiUsageCount {
  const cost = new Map<string, number>()
  for (const c of list.flatMap((d) => d.cost)) cost.set(c.currency, (cost.get(c.currency) ?? 0) + c.amount)
  return {
    requests: list.reduce((n, d) => n + d.requests, 0),
    input: list.reduce((n, d) => n + d.input, 0),
    output: list.reduce((n, d) => n + d.output, 0),
    cost: [...cost].map(
      ([currency, amount]) => ({ currency, amount: Math.round(amount * 1e6) / 1e6 }) as AiCost,
    ),
  }
}
const byDay = computed(() => usage.data.value?.byDay ?? [])
const stats = computed(() => [
  {
    id: 'today',
    label: t('overview.ai.today'),
    count: byDay.value.find((d) => d.day === today.value) ?? EMPTY,
  },
  {
    id: 'month',
    label: t('overview.ai.month'),
    count: sum(byDay.value.filter((d) => d.day.startsWith(month.value))),
  },
])
const dayName = computed(() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'short' }))
/** The last 30 days, oldest first, empty ones too. */
const columns = computed(() => {
  const counts = new Map(byDay.value.map((d) => [d.day, d.requests]))
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now.value)
    d.setDate(d.getDate() - (29 - i))
    const day = dayOf(d)
    return { day, value: counts.get(day) ?? 0, name: dayName.value.format(d) }
  })
})
const requests = (n: number) => t('overview.ai.requests', { count: exact(n) }, n)
</script>

<template>
  <WidgetFrame :title="t('overview.widgets.aiUsage.title')">
    <template #actions>
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-small font-medium text-accent-fg hover:bg-subtle pointer-coarse:min-h-11"
        @click="openAiHistoryTab(tabs)"
      >
        {{ t('overview.ai.open') }}<ArrowRight class="size-3.5" aria-hidden="true" />
      </button>
    </template>
    <div v-if="usage.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="usage.isError.value"
      :text="t('overview.ai.error')"
      :retry="() => void usage.refetch()"
    />
    <div v-else class="flex flex-col gap-4">
      <dl class="grid grid-cols-2 gap-3">
        <div v-for="s in stats" :key="s.id" :data-ai-stat="s.id" class="flex min-w-0 flex-col gap-0.5">
          <dt class="text-small text-fg-subtle">{{ s.label }}</dt>
          <dd class="text-ui font-semibold text-fg tabular-nums">{{ requests(s.count.requests) }}</dd>
          <dd class="truncate text-small text-fg-muted tabular-nums">
            {{ t('overview.ai.tokens', { n: tokens(s.count.input + s.count.output) }) }}
          </dd>
          <dd class="truncate text-small text-fg-muted tabular-nums">{{ costs(s.count.cost) }}</dd>
        </div>
      </dl>
      <div data-ai-days>
        <DayColumns :label="t('overview.ai.perDay')" :days="columns" :format="requests" />
      </div>
    </div>
  </WidgetFrame>
</template>
