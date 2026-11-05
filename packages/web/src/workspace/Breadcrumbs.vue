<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ChevronsUpDown } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { COLOR_CLASSES } from '@/connections/colors'
import { useTabsStore } from '@/stores/tabs'
import DsCombobox from '@/ds/DsCombobox.vue'
import { openCollectionTab, openConnectionTab, openDatabaseTab } from './openTabs'
import { useTabIcon, useTabTitle } from './tabTitle'

/**
 * UI redesign R1 spec §3: where the active tab is — connection / database / collection — each a
 * switcher. Tabs without a connection show their own name.
 */
const { t } = useI18n()
const tabs = useTabsStore()
const titleOf = useTabTitle()
const iconOf = useTabIcon()
/**
 * A page that chooses where it works itself (a plugin's page, SQL ↔ MongoDB) is named, never given
 * switchers that would leave it for another tab.
 */
const ownPlace = computed(() => tabs.active?.kind === 'pluginPage' || tabs.active?.kind === 'sqlTransfer')
const params = computed(() => (ownPlace.value ? {} : (tabs.active?.params ?? {})))
const connectionId = computed(() => params.value.connectionId ?? '')
const db = computed(() => params.value.db ?? '')

const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(connectionId.value)),
  queryFn: () => connectionsApi.databases(connectionId.value),
  enabled: computed(() => !!connectionId.value && !!db.value),
})
const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(connectionId.value, db.value)),
  queryFn: () => connectionsApi.collections(connectionId.value, db.value),
  enabled: computed(() => !!connectionId.value && !!db.value && !!params.value.coll),
})
const connection = computed(() => connections.data.value?.find((c) => c.id === connectionId.value))

const connectionOptions = computed(() =>
  (connections.data.value ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.group ?? undefined })),
)
const databaseOptions = computed(() =>
  (databases.data.value?.databases ?? []).map((d) => ({ value: d.name, label: d.name })),
)
const collectionOptions = computed(() =>
  (collections.data.value ?? []).map((c) => ({ value: c.name, label: c.name })),
)

function toConnection(id: string): void {
  const c = connections.data.value?.find((x) => x.id === id)
  if (c) openConnectionTab(tabs, c)
}
const toDatabase = (name: string) => openDatabaseTab(tabs, connectionId.value, name)
const toCollection = (name: string) => openCollectionTab(tabs, connectionId.value, db.value, name)

const crumb =
  'flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-ui text-fg-muted transition-colors duration-120 hover:bg-subtle hover:text-fg'
</script>

<template>
  <nav :aria-label="t('layout.location')" class="min-w-0 flex-1">
    <ol class="flex min-w-0 items-center gap-0.5">
      <template v-if="connectionId">
        <li class="flex min-w-0 max-w-[200px] shrink-0 items-center" :class="db ? 'max-lg:hidden' : ''">
          <DsCombobox
            :label="t('layout.switchConnection')"
            :items="connectionOptions"
            :current="connectionId"
            :placeholder="t('layout.find')"
            :empty-text="t('layout.noMatch')"
            :trigger-class="crumb"
            @select="toConnection"
          >
            <template #trigger>
              <span
                class="size-2 shrink-0 rounded-full"
                :class="connection?.color ? COLOR_CLASSES[connection.color] : 'bg-line-strong'"
                aria-hidden="true"
              />
              <span class="truncate" :class="db ? '' : 'font-medium text-fg'">{{
                connection?.name ?? '…'
              }}</span>
              <ChevronsUpDown v-if="!db" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            </template>
          </DsCombobox>
        </li>
        <li v-if="db" class="flex min-w-0 max-w-[200px] shrink-0 items-center">
          <span class="px-0.5 text-fg-subtle select-none max-lg:hidden" aria-hidden="true">/</span>
          <DsCombobox
            :label="t('layout.switchDatabase')"
            :items="databaseOptions"
            :current="db"
            :placeholder="t('layout.find')"
            :empty-text="t('layout.noMatch')"
            :trigger-class="crumb"
            @select="toDatabase"
          >
            <template #trigger>
              <span class="truncate" :class="params.coll ? '' : 'font-medium text-fg'">{{ db }}</span>
              <ChevronsUpDown
                v-if="!params.coll"
                class="size-3.5 shrink-0 text-fg-subtle"
                aria-hidden="true"
              />
            </template>
          </DsCombobox>
        </li>
        <li v-if="params.coll" class="flex min-w-0 shrink items-center">
          <span class="px-0.5 text-fg-subtle select-none" aria-hidden="true">/</span>
          <DsCombobox
            :label="t('layout.switchCollection')"
            :items="collectionOptions"
            :current="params.coll"
            :placeholder="t('layout.find')"
            :empty-text="t('layout.noMatch')"
            :trigger-class="crumb"
            @select="toCollection"
          >
            <template #trigger>
              <span class="truncate font-medium text-fg">{{ params.coll }}</span>
              <ChevronsUpDown class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            </template>
          </DsCombobox>
        </li>
      </template>
      <li v-else-if="tabs.active" class="flex min-w-0 items-center gap-2 px-1.5 text-ui font-medium text-fg">
        <component :is="iconOf(tabs.active)" class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span class="truncate">{{
          tabs.active.kind === 'welcome' ? t('layout.home') : titleOf(tabs.active)
        }}</span>
        <!-- A plugin page says which collection it is on (review I5): no switcher, it is not that tab. -->
        <span
          v-if="tabs.active.kind === 'pluginPage' && tabs.active.params.db && tabs.active.params.coll"
          class="truncate font-mono text-small font-normal text-fg-muted"
          >{{ tabs.active.params.db }}.{{ tabs.active.params.coll }}</span
        >
      </li>
    </ol>
  </nav>
</template>
