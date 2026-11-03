<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'
import { ArrowRight, Lock } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabSectionsStore } from '@/stores/tabSections'
import { openConnectionTab } from '@/workspace/openTabs'

/**
 * User review 2026-10-09: what keeps a server busy now — its five longest operations (running a second
 * or more); all of them, and stopping one, on the connection's performance page.
 */
const props = defineProps<{ connectionId: string }>()
const { t } = useI18n()
const tabs = useTabsStore()
const sections = useTabSectionsStore()
const FILTER = { minSecs: 1 }
/** An operation on no namespace (a command on the server). */
const NONE = '—'
const operations = useQuery({
  queryKey: computed(() => serverKeys.operations(props.connectionId, FILTER)),
  queryFn: () => serverApi.operations(props.connectionId, FILTER),
  refetchInterval: 10_000,
})
const longest = computed(() =>
  [...(operations.data.value?.operations ?? [])].sort((a, b) => b.secsRunning - a.secsRunning).slice(0, 5),
)
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
function seeAll(): void {
  const c = connections.data.value?.find((x) => x.id === props.connectionId)
  if (!c) return
  const id = openConnectionTab(tabs, c)
  sections.set(id, 'performance')
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="operations.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="operations.isError.value"
      :text="t(`overview.errors.${widgetError(operations.error.value)}`)"
      :retry="() => void operations.refetch()"
    />
    <p v-else-if="!longest.length" class="py-1 text-small text-fg-subtle">
      {{ t('overview.operations.none') }}
    </p>
    <ul v-else class="-mx-1 flex flex-col">
      <li
        v-for="op in longest"
        :key="op.opid"
        data-operation
        class="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5"
      >
        <span class="w-14 shrink-0 rounded-md bg-subtle px-1.5 py-px text-center text-small text-fg-muted">{{
          op.op
        }}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-small text-fg">{{ op.ns || NONE }}</span>
        <Lock
          v-if="op.waitingForLock"
          class="size-3.5 shrink-0 text-warning"
          :aria-label="t('performance.waitingForLock')"
        />
        <span class="shrink-0 text-small font-medium text-fg tabular-nums">{{
          t('overview.operations.seconds', { s: op.secsRunning })
        }}</span>
      </li>
    </ul>
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1 self-start rounded-md px-1 py-0.5 text-small font-medium text-accent-fg hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
      @click="seeAll"
    >
      {{ t('overview.operations.seeAll') }}<ArrowRight class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
