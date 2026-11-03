<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { TriangleAlert } from 'lucide-vue-next'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import { formatBytes } from '@/format'
import WidgetError from './WidgetError.vue'
import WidgetLink from './WidgetLink.vue'
import { widgetError } from './errors'
import { useOpenSection } from './openSection'

/**
 * Widgets wave 2 (2026-10-27; mongosh's start banner): what a server is — version, feature
 * compatibility, storage engine, cores, memory, system — and its start-up warnings. The server never
 * sends a host name, an address or a path.
 */
const props = defineProps<{ connectionId: string }>()
const { t, locale } = useI18n()
const open = useOpenSection()
const facts = useQuery({
  queryKey: computed(() => serverKeys.facts(props.connectionId)),
  queryFn: () => serverApi.facts(props.connectionId),
  staleTime: 5 * 60_000,
  refetchInterval: 10 * 60_000,
})
const unknown = () => t('overview.facts.unknown')
const majorMinor = (v: string | null) => {
  const m = v ? /^(\d+)\.(\d+)/.exec(v) : null
  return m ? Number(m[1]) * 1000 + Number(m[2]) : null
}
const rows = computed(() => {
  const f = facts.data.value
  if (!f) return []
  return [
    { key: 'version', value: f.version ?? unknown() },
    { key: 'fcv', value: f.fcv ?? unknown() },
    { key: 'engine', value: f.storageEngine ?? unknown() },
    {
      key: 'cores',
      value: f.cores === null ? unknown() : t('overview.facts.coresOf', { n: f.cores }, f.cores),
    },
    {
      key: 'memory',
      value: f.memoryMb === null ? unknown() : formatBytes(f.memoryMb * 1024 ** 2, locale.value),
    },
    {
      key: 'os',
      value: f.os ? [f.os.type, f.os.name].filter(Boolean).join(' · ') || unknown() : unknown(),
    },
  ]
})
/** Review nit: what MongoDB did not give, said in words (not only shown as unknown). */
const refused = computed(() =>
  (facts.data.value?.refused ?? []).map((p) => t(`overview.facts.parts.${p}`)).join(', '),
)
/** The feature compatibility version is behind the binary's (an upgrade not finished). */
const behind = computed(() => {
  const f = facts.data.value
  const binary = majorMinor(f?.version ?? null)
  const fcv = majorMinor(f?.fcv ?? null)
  return binary !== null && fcv !== null && fcv < binary
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="facts.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="facts.isError.value"
      :text="t(`overview.errors.${widgetError(facts.error.value)}`)"
      :retry="() => void facts.refetch()"
    />
    <template v-else-if="facts.data.value">
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-small">
        <div v-for="r in rows" :key="r.key" class="flex min-w-0 flex-col">
          <dt class="text-caption text-fg-subtle">{{ t(`overview.facts.labels.${r.key}`) }}</dt>
          <dd class="truncate text-fg">{{ r.value }}</dd>
        </div>
      </dl>
      <p v-if="behind" class="text-small text-warning">
        {{ t('overview.facts.behind', { fcv: facts.data.value.fcv, version: facts.data.value.version }) }}
      </p>
      <div class="flex flex-col gap-1">
        <p class="text-caption font-medium text-fg-subtle">{{ t('overview.facts.warnings') }}</p>
        <p v-if="facts.data.value.warnings === null" class="text-small text-fg-subtle">{{ unknown() }}</p>
        <p v-else-if="!facts.data.value.warnings.length" class="text-small text-fg-subtle">
          {{ t('overview.facts.noWarnings') }}
        </p>
        <ul v-else class="flex flex-col gap-1">
          <li
            v-for="(w, i) in facts.data.value.warnings"
            :key="i"
            data-warning
            class="flex items-start gap-2 text-small text-fg"
          >
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span class="min-w-0">{{ w }}</span>
          </li>
        </ul>
      </div>
      <p v-if="refused" class="text-small text-fg-subtle">
        {{ t('overview.facts.refused', { parts: refused }) }}
      </p>
      <WidgetLink @open="open(connectionId, 'overview')">{{ t('overview.facts.openConnection') }}</WidgetLink>
    </template>
  </div>
</template>
