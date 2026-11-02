<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ArrowUpRight, Database, Server, Table } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { COLOR_CLASSES } from '@/connections/colors'
import { usePlacesStore, type Place } from '@/stores/places'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab, openConnectionTab, openDatabaseTab } from '../openTabs'
import WidgetFrame from './widgets/WidgetFrame.vue'

/**
 * UI redesign R1 revision 2 §3.6: Continue (the places opened last) and Pinned — one click back into
 * each. A place whose connection is gone is not offered.
 */
const props = defineProps<{ kind: 'continue' | 'pinned' }>()
const { t } = useI18n()
const places = usePlacesStore()
const tabs = useTabsStore()
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const ICONS = { connection: Server, database: Database, collection: Table } as const
const connectionOf = (p: Place) => connections.data.value?.find((c) => c.id === p.params.connectionId)
const rows = computed(() =>
  (props.kind === 'continue' ? places.recent.slice(0, 6) : places.pins)
    .map((place) => ({ place, connection: connectionOf(place) }))
    .filter((r) => !connections.isSuccess.value || r.connection),
)
function open(p: Place): void {
  const c = connectionOf(p)
  if (!c) return
  if (p.kind === 'connection') openConnectionTab(tabs, c)
  else if (p.kind === 'database') openDatabaseTab(tabs, c.id, p.params.db!)
  else openCollectionTab(tabs, c.id, p.params.db!, p.params.coll!)
}
</script>

<template>
  <WidgetFrame
    :title="kind === 'continue' ? t('home.continue') : t('layout.pinned')"
    :count="rows.length || undefined"
  >
    <p v-if="rows.length === 0" class="py-1 text-small text-fg-subtle">
      {{ kind === 'continue' ? t('home.continueEmpty') : t('home.pinnedEmpty') }}
    </p>
    <ul v-else class="-mx-2 flex flex-col">
      <li v-for="r in rows" :key="r.place.key">
        <button
          type="button"
          class="group flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-subtle"
          @click="open(r.place)"
        >
          <span
            class="relative grid size-6 shrink-0 place-items-center rounded-md bg-subtle text-fg-muted ring-1 ring-line ring-inset"
          >
            <component :is="ICONS[r.place.kind]" class="size-3.5" aria-hidden="true" />
            <span
              v-if="r.connection?.color"
              class="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface"
              :class="COLOR_CLASSES[r.connection.color]"
              aria-hidden="true"
            />
          </span>
          <span class="min-w-0 flex-1 truncate text-ui font-medium text-fg">{{
            r.place.kind === 'connection' ? (r.connection?.name ?? r.place.title) : r.place.title
          }}</span>
          <span
            v-if="r.place.kind !== 'connection'"
            class="hidden shrink-0 truncate text-small text-fg-subtle sm:block"
            >{{ r.connection?.name }}</span
          >
          <ArrowUpRight
            class="size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity duration-120 group-hover:opacity-100"
            aria-hidden="true"
          />
        </button>
      </li>
    </ul>
  </WidgetFrame>
</template>
