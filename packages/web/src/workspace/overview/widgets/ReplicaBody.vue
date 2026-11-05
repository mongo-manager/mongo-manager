<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import WidgetError from './WidgetError.vue'
import { widgetError } from './errors'
import { serverApi, serverKeys } from '@/api/server'
import DsSpinner from '@/ds/DsSpinner.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'

/** User review 2026-10-09: a replica set at a glance — its members, their state and lag, the oplog window. */
const props = defineProps<{ connectionId: string }>()
const { t } = useI18n()
const replica = useQuery({
  queryKey: computed(() => serverKeys.replica(props.connectionId)),
  queryFn: () => serverApi.replica(props.connectionId),
  refetchInterval: 15_000,
})
const set = computed(() => (replica.data.value?.mode === 'replicaSet' ? replica.data.value : null))
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="replica.isPending.value" class="flex items-center gap-2 py-2 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('overview.status.waiting') }}
    </div>
    <WidgetError
      v-else-if="replica.isError.value"
      :text="t(`overview.errors.${widgetError(replica.error.value)}`)"
      :retry="() => void replica.refetch()"
    />
    <p v-else-if="!set" class="text-ui text-fg-muted">
      {{
        replica.data.value?.mode === 'sharded'
          ? t('overview.replica.sharded')
          : t('overview.replica.standalone')
      }}
    </p>
    <template v-else>
      <p class="flex flex-wrap gap-x-3 gap-y-1 text-small text-fg-subtle">
        <span class="font-medium text-fg">{{ t('overview.status.replicaSet', { set: set.set }) }}</span>
        <span v-if="set.majorityLagSeconds !== null">{{
          t('overview.replica.majorityLag', { s: set.majorityLagSeconds })
        }}</span>
        <span v-if="set.oplogWindowHours !== null">{{
          t('overview.replica.oplog', { h: Math.round(set.oplogWindowHours) })
        }}</span>
      </p>
      <ul class="-mx-1 flex flex-col">
        <li
          v-for="m in set.members"
          :key="m.name"
          data-member
          :data-healthy="m.healthy ? 'true' : 'false'"
          class="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5"
        >
          <DsStatusDot
            :state="m.healthy ? 'connected' : 'error'"
            :label="m.healthy ? t('overview.replica.healthy') : t('overview.replica.unhealthy')"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-small text-fg">{{ m.name }}</span>
          <span
            class="shrink-0 text-small font-medium"
            :class="m.healthy ? 'text-fg-muted' : 'text-danger'"
            >{{ m.state }}</span
          >
          <span class="w-16 shrink-0 text-right text-small text-fg-subtle tabular-nums">
            <template v-if="m.lagSeconds !== null">{{
              t('overview.replica.lag', { s: m.lagSeconds })
            }}</template>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>
