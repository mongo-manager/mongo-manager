<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Download, Ellipsis, Plus, Search, Upload } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useSessionStore } from '@/stores/session'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import ConnectionTree from '../tree/ConnectionTree.vue'

/**
 * UI redesign R1 revision 2 §3.1: the sidebar's connections — a count, Add and Import/Export, a filter
 * and the tree. Plan ruling 10: "Add connection" is the empty state's button until a connection
 * exists, then an icon button in the header — one button either way.
 */
defineEmits<{ add: []; import: []; export: [] }>()
const { t } = useI18n()
const session = useSessionStore()
const titleId = useId()
const filter = ref('')
const { data, isError, isPending, refetch } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: connectionsApi.list,
})
const canManage = computed(() => session.can('connections:manage'))
const hasAny = computed(() => (data.value?.length ?? 0) > 0)
const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const list = data.value ?? []
  return q
    ? list.filter((c) => c.name.toLowerCase().includes(q) || (c.group ?? '').toLowerCase().includes(q))
    : list
})
const moreItems = computed(() => [
  { id: 'import', label: t('sidebar.import'), icon: Upload },
  { id: 'export', label: t('sidebar.export'), icon: Download },
])
</script>

<template>
  <section data-region="connections" :aria-labelledby="titleId" class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-8 shrink-0 items-center gap-1 pr-1 pl-2.5">
      <h2
        :id="titleId"
        class="flex min-w-0 flex-1 items-center gap-1.5 text-caption font-semibold tracking-wide text-fg-subtle uppercase"
      >
        <span class="truncate">{{ t('sidebar.connections') }}</span>
        <span
          v-if="hasAny"
          class="rounded-full bg-muted px-1.5 leading-[18px] font-medium tracking-normal text-fg-muted tabular-nums"
          >{{ data?.length }}</span
        >
      </h2>
      <template v-if="canManage && hasAny">
        <DsIconButton :icon="Plus" size="sm" :label="t('sidebar.addConnection')" @click="$emit('add')" />
        <DsMenu
          focusable
          :label="t('layout.moreConnectionActions')"
          :icon="Ellipsis"
          :items="moreItems"
          @select="$event === 'import' ? $emit('import') : $emit('export')"
        />
      </template>
    </div>
    <div v-if="hasAny" class="shrink-0 px-1 pt-1 pb-1.5">
      <DsInput
        v-model="filter"
        :label="t('tree.filter')"
        hide-label
        :icon="Search"
        size="sm"
        clearable
        type="search"
        :placeholder="t('tree.filter')"
        autocomplete="off"
      />
    </div>
    <div class="-mx-1 min-h-0 flex-1 overflow-auto">
      <div v-if="isPending" class="flex flex-col gap-2 px-3 py-2" aria-hidden="true">
        <DsSkeleton v-for="i in 5" :key="i" class="h-5" :style="{ width: `${90 - i * 9}%` }" />
      </div>
      <ConnectionTree v-else-if="visible.length > 0" :connections="visible" />
      <div
        v-else-if="!isError && data?.length === 0"
        class="mx-2 mt-1 rounded-xl border border-dashed border-line-strong p-3.5"
      >
        <p class="text-ui font-medium text-fg">{{ t('sidebar.empty') }}</p>
        <p class="mt-1 text-small text-fg-subtle">{{ t('layout.emptyBody') }}</p>
        <div v-if="canManage" class="mt-3 flex flex-wrap gap-1.5">
          <DsButton variant="primary" size="sm" :icon="Plus" @click="$emit('add')">{{
            t('sidebar.addConnection')
          }}</DsButton>
          <DsButton variant="ghost" size="sm" :icon="Upload" @click="$emit('import')">{{
            t('sidebar.import')
          }}</DsButton>
        </div>
      </div>
      <p v-else-if="filter && hasAny" class="px-3 py-3 text-ui text-fg-subtle">{{ t('tree.noMatch') }}</p>
      <div v-if="isError" class="px-2 py-2">
        <DsCallout tone="danger">
          {{ t('sidebar.loadError') }}
          <template #action>
            <DsButton size="sm" variant="ghost" @click="refetch()">{{ t('tree.retry') }}</DsButton>
          </template>
        </DsCallout>
      </div>
    </div>
  </section>
</template>
