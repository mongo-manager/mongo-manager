<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Puzzle, Table } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSpinner from '@/ds/DsSpinner.vue'
import { pluginKeys, pluginsApi } from '@/api/plugins'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useTabsStore } from '@/stores/tabs'
import { useSessionStore } from '@/stores/session'
import { useCollectionViewsStore } from '@/stores/collectionViews'
import { showDocumentById } from '@/documents/showDocument'
import { openCollectionTab, openPluginsTab } from '@/workspace/openTabs'
import PluginFrame from './PluginFrame.vue'
import { frameKey, localized, targetKey, usePluginsStore } from './store'

/**
 * User request 2026-10-10: a plugin's sidebar entry is a page of its own (a tab with its address),
 * never a drawer. Opened from a collection it works on that collection; otherwise as the plugin
 * does with none (the SQL plugin translates only). Review 2026-10-10: kept while another tab shows
 * (doing nothing out of sight); a collection that came in a link is read only when the user says so.
 */
const props = withDefaults(
  defineProps<{
    plugin: string
    contribution: string
    connectionId?: string
    db?: string
    coll?: string
    /** Whether its tab is the one shown (the page stays while another is). */
    active?: boolean
  }>(),
  { connectionId: undefined, db: undefined, coll: undefined, active: true },
)
const { t, locale } = useI18n()
const plugins = usePluginsStore()
const tabs = useTabsStore()
const session = useSessionStore()
const views = useCollectionViewsStore()

// The same query the workspace keeps the plugins with: its state is the page's (review I1).
const runtime = useQuery({ queryKey: pluginKeys.runtime, queryFn: pluginsApi.runtime, staleTime: 60_000 })
const page = computed(() => plugins.pageOf(props.plugin, props.contribution))
const title = computed(() =>
  page.value ? localized(page.value.title, locale.value) : t('plugins.page.title'),
)
const target = computed(() =>
  props.connectionId && props.db && props.coll
    ? { connectionId: props.connectionId, db: props.db, coll: props.coll }
    : null,
)
const ns = computed(() => (target.value ? `${target.value.db}.${target.value.coll}` : ''))
const ownTab = computed(
  () =>
    tabs.tabs.find(
      (t) =>
        t.kind === 'pluginPage' &&
        t.params.plugin === props.plugin &&
        t.params.contribution === props.contribution,
    )?.id,
)

const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connectionName = computed(
  () =>
    connections.data.value?.find((c) => c.id === target.value?.connectionId)?.name ??
    target.value?.connectionId,
)
// The collection is still there (review I4): the app's own list of its database.
const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(target.value?.connectionId ?? '', target.value?.db ?? '')),
  queryFn: () => connectionsApi.collections(target.value!.connectionId, target.value!.db),
  enabled: computed(() => !!target.value),
})
const gone = computed(
  () =>
    !!target.value && !!collections.data.value && !collections.data.value.some((c) => c.name === props.coll),
)
const chosen = computed(
  () => !target.value || plugins.chosen.has(targetKey(props.plugin, props.contribution, target.value)),
)

function openOnTarget(): void {
  if (target.value) plugins.choose(targetKey(props.plugin, props.contribution, target.value))
}
function withoutCollection(): void {
  if (ownTab.value) tabs.setView(ownTab.value, { connectionId: null, db: null, coll: null })
}
function close(): void {
  if (ownTab.value) tabs.close(ownTab.value)
}
/** A document the plugin names opens in its collection's tab. */
function openDocument(id: unknown): void {
  if (!target.value) return
  const tabId = openCollectionTab(tabs, target.value.connectionId, target.value.db, target.value.coll)
  if (showDocumentById(views.stateFor(tabId), id)) views.stateFor(tabId).section = 'documents'
}

const loadingLine = 'flex items-center gap-2 p-4 text-ui text-fg-subtle'
</script>

<template>
  <section data-plugin-page class="flex h-full min-h-0 flex-col" :aria-label="title">
    <template v-if="page">
      <div
        v-if="target && chosen && !gone"
        class="flex flex-wrap items-center gap-2 border-b border-line bg-canvas px-4 py-1.5 text-small text-fg-muted"
      >
        <Table class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span class="min-w-0 truncate"
          >{{ t('plugins.page.on', { ns }) }} · <span class="text-fg-subtle">{{ connectionName }}</span></span
        >
        <DsButton size="sm" variant="ghost" class="ml-auto" @click="withoutCollection">
          {{ t('plugins.page.withoutCollection') }}
        </DsButton>
      </div>
      <div v-if="target && gone" class="flex flex-col items-center gap-3 pb-12">
        <DsEmptyState
          :icon="Table"
          :title="t('plugins.page.gone', { ns })"
          :description="t('plugins.page.goneHint')"
        />
        <DsButton variant="primary" @click="withoutCollection">{{
          t('plugins.page.withoutCollection')
        }}</DsButton>
      </div>
      <div
        v-else-if="target && !chosen"
        class="mx-auto mt-12 flex max-w-md flex-col items-center gap-3 px-6 text-center"
        data-plugin-confirm
      >
        <span
          class="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <Puzzle class="size-5" />
        </span>
        <p class="font-medium text-fg">
          {{ t('plugins.page.confirm', { plugin: title, ns, connection: connectionName }) }}
        </p>
        <p class="text-small text-fg-subtle">{{ t('plugins.page.confirmHint') }}</p>
        <div class="flex flex-wrap justify-center gap-2">
          <DsButton variant="primary" @click="openOnTarget">{{ t('plugins.page.open') }}</DsButton>
          <DsButton @click="withoutCollection">{{ t('plugins.page.withoutCollection') }}</DsButton>
        </div>
      </div>
      <PluginFrame
        v-else
        :key="`${frameKey(page)}|${target ? Object.values(target).join('/') : ''}`"
        :plugin="page.plugin"
        kind="sidebarPanel"
        :contribution="page.id"
        :target="target"
        :inactive="!active"
        @open-document="openDocument"
      />
    </template>
    <p v-else-if="runtime.isPending.value" role="status" :class="loadingLine">
      <DsSpinner />{{ t('plugins.page.loading') }}
    </p>
    <div
      v-else-if="runtime.isError.value"
      role="alert"
      class="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <p class="font-medium text-fg">{{ t('plugins.page.failed') }}</p>
      <DsButton @click="runtime.refetch()">{{ t('plugins.page.retry') }}</DsButton>
    </div>
    <div v-else class="flex flex-col items-center gap-3 pb-12">
      <DsEmptyState
        :icon="Puzzle"
        :title="t('plugins.page.unavailable')"
        :description="t('plugins.page.unavailableHint')"
      />
      <div class="flex justify-center gap-2">
        <DsButton @click="close">{{ t('plugins.page.close') }}</DsButton>
        <DsButton v-if="session.can('settings:manage')" variant="primary" @click="openPluginsTab(tabs)">
          {{ t('plugins.page.manage') }}
        </DsButton>
      </div>
    </div>
  </section>
</template>
