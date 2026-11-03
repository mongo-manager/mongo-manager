<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { ChevronRight, Database, Server, Table } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'

/**
 * User review 2026-10-09 ("collection adı daha belirgin olmalı"): where a request was asked — its
 * connection (when it is still there), database and collection — at a glance.
 */
const props = withDefaults(
  defineProps<{ connectionId: string | null; namespace: string; large?: boolean }>(),
  {
    large: false,
  },
)
/** Read between the parts by a screen reader (the chevrons are hidden): "Prod › shop › orders". */
const SEP = ' › '
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connection = computed(
  () => connections.data.value?.find((c) => c.id === props.connectionId)?.name ?? null,
)
const parts = computed(() => {
  const dot = props.namespace.indexOf('.')
  return dot < 0
    ? { db: props.namespace, coll: '' }
    : { db: props.namespace.slice(0, dot), coll: props.namespace.slice(dot + 1) }
})
</script>

<template>
  <span
    data-namespace
    class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-line bg-subtle text-fg"
    :class="large ? 'px-2.5 py-1 text-ui' : 'px-1.5 py-px text-small'"
    :title="connection ? `${connection} › ${namespace}` : namespace"
  >
    <template v-if="connection">
      <Server class="shrink-0 text-fg-subtle" :class="large ? 'size-4' : 'size-3'" aria-hidden="true" />
      <span class="min-w-0 truncate">{{ connection }}</span>
      <ChevronRight
        class="shrink-0 text-fg-subtle"
        :class="large ? 'size-3.5' : 'size-3'"
        aria-hidden="true"
      /><span class="sr-only">{{ SEP }}</span>
    </template>
    <Database class="shrink-0 text-fg-subtle" :class="large ? 'size-4' : 'size-3'" aria-hidden="true" />
    <span class="min-w-0 truncate font-mono">{{ parts.db }}</span>
    <template v-if="parts.coll">
      <ChevronRight
        class="shrink-0 text-fg-subtle"
        :class="large ? 'size-3.5' : 'size-3'"
        aria-hidden="true"
      /><span class="sr-only">{{ SEP }}</span>
      <Table class="shrink-0 text-accent-fg" :class="large ? 'size-4' : 'size-3'" aria-hidden="true" />
      <span class="min-w-0 truncate font-mono font-semibold">{{ parts.coll }}</span>
    </template>
  </span>
</template>
