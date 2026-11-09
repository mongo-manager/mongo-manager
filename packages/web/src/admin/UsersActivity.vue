<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Activity, RotateCw, ScrollText } from 'lucide-vue-next'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import type { DsColumn } from '@/ds/table'
import { accountKeys, usersApi } from '@/api/account'
import { describeError } from '@/api/errors'
import { formatRelative } from '@/format'
import { useTabsStore } from '@/stores/tabs'
import { openAuditTab } from '@/workspace/openTabs'
import { useAuditWords } from './auditWords'

/**
 * Phase 4c §3: each user's activity over the last days, from the audit log — sign-ins, failed ones,
 * actions (refused ones too), last activity and what they did most; a user opens the audit log on them.
 */
const { t, locale } = useI18n()
const tabs = useTabsStore()
const words = useAuditWords()
const days = ref<'7' | '30' | '90'>('30')
const periods = computed(() =>
  (['7', '30', '90'] as const).map((n) => ({
    value: n,
    label: t('users.activity.period', { n: Number(n) }),
  })),
)
const activity = useQuery({
  queryKey: computed(() => accountKeys.activity(Number(days.value))),
  queryFn: () => usersApi.activity(Number(days.value) as 7 | 30 | 90),
})
type Row = NonNullable<typeof activity.data.value>[number]
// The busiest first; nothing done last.
const rows = computed(() =>
  [...(activity.data.value ?? [])].sort(
    (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.username.localeCompare(b.username),
  ),
)
// The audit log link is a column of its own (always shown), not a hover action: it is the row's purpose.
const columns = computed<DsColumn[]>(() => [
  { key: 'username', label: t('users.username') },
  { key: 'lastSignIn', label: t('users.activity.lastSignIn'), width: '8rem' },
  { key: 'signIns', label: t('users.activity.signIns'), align: 'right', width: '5.5rem' },
  { key: 'failed', label: t('users.activity.failed'), align: 'right', width: '6rem' },
  { key: 'actions', label: t('users.activity.actions'), align: 'right', width: '8rem' },
  { key: 'groups', label: t('users.activity.groups'), width: '13rem' },
  { key: 'lastActivity', label: t('users.activity.lastActivity'), width: '8rem' },
  { key: 'audit', label: t('users.activity.auditLog'), align: 'right', width: '8rem', hideLabel: true },
])
const when = (ms: number | null) =>
  ms === null ? t('users.activity.never') : formatRelative(ms - Date.now(), locale.value)
const exact = (ms: number | null) =>
  ms === null
    ? ''
    : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
const count = (n: number) => new Intl.NumberFormat(locale.value).format(n)
function audit(userId: string): void {
  const id = openAuditTab(tabs)
  tabs.setView(id, { userId })
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-small text-fg-subtle">{{ t('users.activity.intro') }}</p>
      <DsSegmented v-model="days" size="sm" :label="t('users.activity.periodLabel')" :options="periods" />
    </div>
    <DsDataTable
      :label="t('users.tabs.activity')"
      :columns="columns"
      :rows="rows"
      :row-key="(r: Row) => r.userId"
      :loading="activity.isPending.value"
      :loading-label="t('app.loading')"
      :error="activity.isError.value ? describeError(activity.error.value, t) : undefined"
    >
      <template #cell-username="{ row: r }">
        <span :data-activity="r.userId" class="flex min-w-0 items-center gap-1.5">
          <span class="truncate font-medium text-fg">{{ r.username }}</span>
          <span class="shrink-0 text-small text-fg-subtle">{{ t(`overview.roles.${r.role}`) }}</span>
          <DsBadge v-if="r.disabled" tone="danger">{{ t('users.disabled') }}</DsBadge>
        </span>
      </template>
      <template #cell-lastSignIn="{ row: r }">
        <span class="whitespace-nowrap text-fg-muted" :title="exact(r.lastSignInAt)">{{
          when(r.lastSignInAt)
        }}</span>
      </template>
      <template #cell-signIns="{ row: r }">{{ count(r.signIns) }}</template>
      <template #cell-failed="{ row: r }">
        <span :class="r.failedSignIns ? 'font-medium text-warning' : 'text-fg-muted'">{{
          count(r.failedSignIns)
        }}</span>
      </template>
      <template #cell-actions="{ row: r }">
        {{ count(r.actions) }}
        <span v-if="r.denied" class="ml-1 text-small text-danger">{{
          t('users.activity.denied', { n: count(r.denied) })
        }}</span>
      </template>
      <template #cell-groups="{ row: r }">
        <span class="flex flex-wrap gap-1 py-1">
          <DsBadge v-for="g in r.groups.slice(0, 3)" :key="g.group" tone="neutral">
            <!-- Audit action labels (2026-10-28): in words; a group with none, by its code. -->
            <span :class="words.group(g.group).known ? '' : 'font-mono'">{{
              words.group(g.group).text
            }}</span>
            <span class="text-fg-subtle">{{ count(g.count) }}</span>
          </DsBadge>
        </span>
      </template>
      <template #cell-lastActivity="{ row: r }">
        <span class="whitespace-nowrap text-fg-muted" :title="exact(r.lastActivityAt)">{{
          when(r.lastActivityAt)
        }}</span>
      </template>
      <template #cell-audit="{ row: r }">
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-small font-medium text-accent-fg hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
          @click="audit(r.userId)"
        >
          <ScrollText class="size-3.5" aria-hidden="true" />{{ t('users.activity.auditLog') }}
        </button>
      </template>
      <template #retry>
        <DsButton size="sm" :icon="RotateCw" @click="activity.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
      <template #empty>
        <DsEmptyState :icon="Activity" :title="t('users.activity.empty')" />
      </template>
    </DsDataTable>
  </div>
</template>
