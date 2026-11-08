<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ChevronsUpDown, History, Layers, Pin, Search as SearchIcon, Star } from 'lucide-vue-next'
import type { LibraryItem } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { libraryApi } from '@/api/library'
import { openLibraryItem } from '@/library/openItem'
import { usePlacesStore } from '@/stores/places'
import DsCombobox from '@/ds/DsCombobox.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import WidgetFrame from './widgets/WidgetFrame.vue'
import { useWidget } from './widgets/context'
import { useDashboardStore } from '@/stores/dashboard'

/**
 * UI redesign R1 revision 2 §3.5: recent and saved queries from the library (phase 2c). The library
 * is per connection: the module shows the one opened last, or the first, and the header switches it.
 */
const { t } = useI18n()
const places = usePlacesStore()
const queryClient = useQueryClient()
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
// User review 2026-10-09: on the dashboard the connection and the view chosen are the widget's settings.
const widget = useWidget()
const dashboard = useDashboardStore()
const saved = computed(() =>
  widget?.value.widget.type === 'queries'
    ? (widget.value.widget.settings as { connectionId?: string; view?: 'recent' | 'saved' })
    : {},
)
const local = ref<{ connectionId?: string; view?: 'recent' | 'saved' }>({})
function choose(change: { connectionId?: string; view?: 'recent' | 'saved' }): void {
  const next = { ...saved.value, ...local.value, ...change }
  if (widget) dashboard.configure(widget.value.widget.id, next)
  else local.value = next
}
const chosen = computed(() => local.value.connectionId ?? saved.value.connectionId ?? null)
const mode = computed({
  get: () => local.value.view ?? saved.value.view ?? 'recent',
  set: (view: 'recent' | 'saved') => choose({ view }),
})
const connectionId = computed(() => {
  const list = connections.data.value ?? []
  const wanted = chosen.value ?? places.recent[0]?.params.connectionId
  return list.find((c) => c.id === wanted)?.id ?? list[0]?.id ?? null
})
const connection = computed(() => connections.data.value?.find((c) => c.id === connectionId.value))
const items = useQuery({
  queryKey: computed(() => ['overview', 'library', connectionId.value, mode.value] as const),
  queryFn: async () => {
    const id = connectionId.value!
    const result =
      mode.value === 'recent'
        ? await libraryApi.search(id, { type: 'history', limit: 6 })
        : await libraryApi.search(id, { limit: 30 })
    return mode.value === 'recent'
      ? result.items
      : result.items.filter((i) => i.type !== 'history').slice(0, 6)
  },
  enabled: computed(() => !!connectionId.value),
})
const modes = computed(() => [
  { value: 'recent' as const, label: t('home.recent'), icon: History },
  { value: 'saved' as const, label: t('home.saved'), icon: Star },
])
const options = computed(() =>
  (connections.data.value ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.group ?? undefined })),
)
const ICON = { favourite: Star, pipeline: Layers, history: History, snippet: SearchIcon } as const
async function open(item: LibraryItem): Promise<void> {
  if (connectionId.value) await openLibraryItem(connectionId.value, item, { t, queryClient })
}
</script>

<template>
  <WidgetFrame :title="t('home.queries')">
    <template #actions>
      <DsSegmented v-model="mode" size="sm" :label="t('home.queries')" :options="modes" icon-only />
    </template>
    <div v-if="connection" class="mb-2 flex items-center">
      <DsCombobox
        :label="t('layout.switchConnection')"
        :items="options"
        :current="connectionId ?? undefined"
        :placeholder="t('layout.find')"
        :empty-text="t('layout.noMatch')"
        trigger-class="-ml-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-small font-medium text-fg-muted hover:bg-subtle hover:text-fg"
        @select="choose({ connectionId: $event })"
      >
        <template #trigger>
          {{ connection.name }}
          <ChevronsUpDown class="size-3.5 text-fg-subtle" aria-hidden="true" />
        </template>
      </DsCombobox>
    </div>
    <p v-if="!connectionId" class="py-1 text-small text-fg-subtle">{{ t('home.queriesNone') }}</p>
    <div v-else-if="items.isPending.value" class="flex flex-col gap-2 py-1" aria-hidden="true">
      <DsSkeleton v-for="i in 3" :key="i" class="h-6" />
    </div>
    <p v-else-if="!items.data.value?.length" class="py-1 text-small text-fg-subtle">
      {{ mode === 'recent' ? t('home.recentEmpty') : t('home.savedEmpty') }}
    </p>
    <ul v-else class="-mx-2 flex flex-col">
      <li v-for="item in items.data.value" :key="`${item.type}:${item.id}`">
        <button
          type="button"
          class="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-120 hover:bg-subtle"
          @click="open(item)"
        >
          <component
            :is="ICON[item.type]"
            class="mt-0.5 size-3.5 shrink-0 text-fg-subtle"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1">
            <span v-if="item.name" class="flex min-w-0 items-center gap-1.5 text-ui font-medium text-fg">
              <span class="truncate">{{ item.name }}</span>
              <!-- W1 (completion §2): pinned saved queries come first (the server lists them so). -->
              <Pin
                v-if="item.pinned"
                data-pinned
                role="img"
                :aria-label="t('explorer.pins.pinned')"
                class="size-3 shrink-0 text-accent-fg"
              />
            </span>
            <span class="block truncate font-mono text-[12px] text-fg-muted">{{ item.preview }}</span>
          </span>
          <span class="shrink-0 pt-0.5 text-small text-fg-subtle">{{ item.coll }}</span>
        </button>
      </li>
    </ul>
  </WidgetFrame>
</template>
