<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Database, PinOff, Server, Table } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { COLOR_CLASSES } from '@/connections/colors'
import { usePlacesStore, type Place } from '@/stores/places'
import { useTabsStore } from '@/stores/tabs'
import { openCollectionTab, openConnectionTab, openDatabaseTab } from '../openTabs'

/**
 * UI redesign R1 revision 2 §3.6: the places the user pinned, at the top of the sidebar. A pin to a
 * connection that is gone, or no longer the user's, is shown greyed with only Unpin.
 */
const { t } = useI18n()
const places = usePlacesStore()
const tabs = useTabsStore()
const titleId = useId()
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const ICONS = { connection: Server, database: Database, collection: Table } as const
const connectionOf = (p: Place) => connections.data.value?.find((c) => c.id === p.params.connectionId)
const rows = computed(() =>
  places.pins.map((p) => {
    const c = connectionOf(p)
    return { place: p, connection: c, gone: connections.isSuccess.value && !c }
  }),
)

function open(p: Place): void {
  const c = connectionOf(p)
  if (!c) return
  if (p.kind === 'connection') openConnectionTab(tabs, c)
  else if (p.kind === 'database') openDatabaseTab(tabs, c.id, p.params.db!)
  else openCollectionTab(tabs, c.id, p.params.db!, p.params.coll!)
}
const labelOf = (p: Place) => (p.kind === 'connection' ? (connectionOf(p)?.name ?? p.title) : p.title)
/**
 * User report 2026-11-02: with several connections, a pinned database or collection names its
 * connection too — after its name, quieter, and first in its tooltip.
 */
const connectionNameOf = (p: Place) => (p.kind === 'connection' ? undefined : connectionOf(p)?.name)
const tooltipOf = (p: Place) => {
  const name = connectionNameOf(p)
  return name ? `${name} › ${p.title}` : p.title
}
</script>

<template>
  <section v-if="places.pins.length" data-test="pinned" :aria-labelledby="titleId" class="flex flex-col">
    <h2
      :id="titleId"
      class="flex h-8 items-center px-2.5 text-caption font-semibold tracking-wide text-fg-subtle uppercase"
    >
      {{ t('layout.pinned') }}
    </h2>
    <ul class="flex flex-col gap-0.5">
      <li v-for="row in rows" :key="row.place.key" class="group relative">
        <button
          type="button"
          class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg pr-8 pl-2.5 text-ui transition-colors duration-120 ease-out-soft"
          :class="
            row.gone
              ? 'cursor-default text-fg-subtle line-through'
              : 'text-fg-muted hover:bg-muted hover:text-fg'
          "
          :disabled="row.gone"
          :title="row.gone ? t('layout.unavailable') : tooltipOf(row.place)"
          @click="open(row.place)"
        >
          <span class="relative shrink-0">
            <component :is="ICONS[row.place.kind]" class="size-4" aria-hidden="true" />
            <span
              v-if="row.connection?.color"
              class="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-canvas"
              :class="COLOR_CLASSES[row.connection.color]"
              aria-hidden="true"
            />
          </span>
          <span class="min-w-0 flex-1 truncate text-left">
            {{ labelOf(row.place) }}
            <span v-if="connectionNameOf(row.place)" class="text-caption text-fg-subtle">{{
              connectionNameOf(row.place)
            }}</span>
          </span>
        </button>
        <button
          type="button"
          class="absolute top-1 right-1 grid size-6 cursor-pointer place-items-center rounded-md text-fg-subtle opacity-0 transition-opacity duration-120 group-hover:opacity-100 hover:bg-muted hover:text-fg focus-visible:opacity-100"
          :class="row.gone ? 'opacity-100' : ''"
          :aria-label="t('layout.unpinNamed', { name: tooltipOf(row.place) })"
          @click="places.unpin(row.place.key)"
        >
          <PinOff class="size-3.5" aria-hidden="true" />
        </button>
      </li>
    </ul>
  </section>
</template>
