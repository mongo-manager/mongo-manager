<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { FileArchive, Lock, RotateCw, Search, Snowflake } from 'lucide-vue-next'
import type { DestinationSummary, RemoteBackup } from '@mongo-manager/shared/browser'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { useListingError } from './checkText'
import { formatBytes, formatRelative } from '@/format'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSelect from '@/ds/DsSelect.vue'
/**
 * Phase 3d-3b V7: pick a backup at one of the caller's destinations; archived and incomplete ones say
 * why not. Final review C5: later pages load on demand and the search covers every loaded page; C3:
 * while a pick is being fetched () nothing else can be picked.
 */
const props = defineProps<{ destinations: DestinationSummary[]; busy?: boolean }>()
const emit = defineEmits<{ pick: [choice: { destinationId: string; key: string; name: string }] }>()
const { t, locale } = useI18n()
const listingError = useListingError()
const chosen = ref(props.destinations[0]?.id ?? '')
watch(
  () => props.destinations,
  (list) => {
    if (!list.some((d) => d.id === chosen.value)) chosen.value = list[0]?.id ?? ''
  },
)
const page = useQuery({
  queryKey: computed(() => destinationKeys.remote(chosen.value)),
  queryFn: () => destinationsApi.remote(chosen.value),
  enabled: computed(() => Boolean(chosen.value)),
})
const more = ref<RemoteBackup[]>([])
const cursor = ref<string | null | undefined>(undefined)
const loadingMore = ref(false)
const moreError = ref<string | null>(null)
// Another destination starts again from its first page.
watch(chosen, () => {
  more.value = []
  cursor.value = undefined
  moreError.value = null
})
const nextCursor = computed(() =>
  cursor.value === undefined ? (page.data.value?.cursor ?? null) : cursor.value,
)
async function loadMore(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return
  const from = chosen.value
  loadingMore.value = true
  moreError.value = null
  try {
    const next = await destinationsApi.remote(from, nextCursor.value)
    if (from !== chosen.value) return
    more.value = [...more.value, ...next.items]
    cursor.value = next.cursor
  } catch (e) {
    moreError.value = listingError(e)
  } finally {
    loadingMore.value = false
  }
}
const loaded = computed(() => {
  const seen = new Set<string>()
  return [...(page.data.value?.items ?? []), ...more.value].filter((r) =>
    seen.has(r.key) ? false : (seen.add(r.key), true),
  )
})
const filter = ref('')
const rows = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return loaded.value.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      (r.scope && r.scope.kind !== 'server' && r.scope.db.toLowerCase().includes(q)),
  )
})
const blocked = (r: RemoteBackup) =>
  r.archived ? t('backup.remote.archived') : r.state === 'incomplete' ? t('backup.remote.incomplete') : null
const now = Date.now()
const when = (r: RemoteBackup) =>
  r.createdAt ? formatRelative(Math.min(0, r.createdAt - now), locale.value) : ''
const control =
  'h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm focus:border-accent focus:ring-2 focus:ring-focus/30 focus:outline-none'
</script>

<template>
  <div class="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
    <div class="flex flex-wrap items-center gap-2">
      <DsSelect
        v-if="destinations.length > 1"
        v-model="chosen"
        class="w-48"
        :disabled="busy"
        hide-label
        :label="t('backup.remote.source')"
        :options="destinations.map((d) => ({ value: d.id, label: d.name }))"
      />
      <label class="relative min-w-56 flex-1">
        <Search
          class="pointer-events-none absolute top-2.5 left-3 size-4 text-fg-subtle"
          aria-hidden="true"
        />
        <input
          v-model="filter"
          type="search"
          :placeholder="t('backup.remote.search')"
          :aria-label="t('backup.remote.search')"
          :class="control"
          class="w-full pl-9"
        />
      </label>
    </div>
    <div v-if="page.isPending.value" class="flex flex-col gap-2" aria-busy="true">
      <DsSkeleton v-for="n in 3" :key="n" class="h-10 rounded-lg" />
    </div>
    <DsCallout v-else-if="page.isError.value" tone="danger">
      {{ listingError(page.error.value) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="page.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <p v-else-if="!rows.length" class="py-6 text-center text-ui text-fg-subtle">
      {{ filter.trim() && loaded.length ? t('backup.remote.noMatch') : t('backup.remote.empty') }}
    </p>
    <ul v-else class="flex max-h-80 flex-col gap-1 overflow-auto" :aria-busy="busy ? 'true' : undefined">
      <li v-for="r in rows" :key="r.key">
        <button
          type="button"
          data-remote-pick
          :disabled="busy || Boolean(blocked(r))"
          class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-ui transition-colors duration-150 enabled:cursor-pointer enabled:hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-60"
          @click="emit('pick', { destinationId: chosen, key: r.key, name: r.name })"
        >
          <Snowflake v-if="r.archived" class="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
          <FileArchive v-else class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="flex items-center gap-1.5">
              <span class="truncate font-mono">{{ r.name }}</span>
              <Lock v-if="r.format === 'mmbak'" class="size-3.5 shrink-0 text-success" aria-hidden="true" />
            </span>
            <span class="truncate text-small text-fg-subtle">{{
              r.scope
                ? r.scope.kind === 'server'
                  ? t('backup.scope.server')
                  : r.scope.db
                : t('backup.remote.unknownScope')
            }}</span>
            <!-- Final review C22: why a row cannot be picked, on the page (not only on hover). -->
            <span
              v-if="blocked(r)"
              data-why
              class="text-small"
              :class="r.archived ? 'text-accent-fg' : 'text-warning'"
              >{{ blocked(r) }}</span
            >
          </span>
          <span class="text-fg-subtle tabular-nums">{{ formatBytes(r.size, locale) }}</span>
          <span class="w-24 text-right text-small text-fg-subtle">{{ when(r) }}</span>
        </button>
      </li>
    </ul>
    <DsCallout v-if="moreError" tone="danger">
      {{ moreError }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="loadMore()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <DsButton
      v-if="nextCursor && !page.isPending.value && !page.isError.value"
      class="self-center"
      size="sm"
      variant="ghost"
      :loading="loadingMore"
      @click="loadMore"
    >
      {{ t('backup.remote.more') }}
    </DsButton>
  </div>
</template>
