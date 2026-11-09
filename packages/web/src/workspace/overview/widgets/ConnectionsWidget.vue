<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ArrowRight, Server, Star } from 'lucide-vue-next'
import { connectionsApi, queryKeys } from '@/api/connections'
import { COLOR_CLASSES } from '@/connections/colors'
import { useTabsStore } from '@/stores/tabs'
import DsBadge from '@/ds/DsBadge.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import type { ConnectionHealth } from '@mongo-manager/shared/browser'
import { openConnectionTab } from '@/workspace/openTabs'
import WidgetFrame from './WidgetFrame.vue'

/** UI redesign R1 spec §3: the connections as cards, favourites first (now a widget, 2026-10-09). */
const { t } = useI18n()
const tabs = useTabsStore()
const { data } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const SHOWN = 9
const all = computed(() => data.value ?? [])
const connections = computed(() =>
  [...all.value]
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
    .slice(0, SHOWN),
)
// W3.4: each card's live health — cached by the server, never a reason for it to connect.
const healthList = useQuery({
  queryKey: alertKeys.health,
  queryFn: alertsApi.health,
  refetchInterval: 30_000,
  retry: false,
})
const healthOf = (id: string): ConnectionHealth | undefined =>
  healthList.data.value?.find((h) => h.connectionId === id)
const DOTS = { ok: 'connected', down: 'error', idle: 'idle', per_person: 'idle' } as const
function healthWords(h: ConnectionHealth | undefined): string {
  if (!h || h.state === 'idle') return t('health.idle')
  if (h.state === 'down') return t('health.down')
  if (h.state === 'per_person') return t('health.perPerson')
  return [
    t('health.ok', { ms: h.latencyMs ?? 0 }),
    h.version ? t('health.version', { version: h.version }) : null,
    h.topology ? t(`connection.topology.${h.topology}`) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
</script>

<template>
  <WidgetFrame :title="t('home.connections')" :count="all.length">
    <ul class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5">
      <li
        v-for="c in connections"
        :key="c.id"
        data-test="home-connection"
        class="group relative flex flex-col rounded-xl border border-line bg-surface p-3.5 transition-[border-color,box-shadow,transform] duration-160 ease-out-soft hover:-translate-y-px hover:border-line-strong hover:shadow-float has-[:focus-visible]:border-focus"
      >
        <span
          v-if="c.color"
          class="absolute inset-x-4 top-0 h-0.5 rounded-b-full"
          :class="COLOR_CLASSES[c.color]"
          aria-hidden="true"
        />
        <div class="flex items-start gap-3">
          <span
            class="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted ring-1 ring-line ring-inset transition-colors duration-160 group-hover:text-accent-fg"
          >
            <Server class="size-4" aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-ui font-semibold text-fg">{{ c.name }}</p>
            <p class="truncate text-small text-fg-subtle">{{ c.group ?? t('home.noGroup') }}</p>
          </div>
          <Star
            v-if="c.favorite"
            class="mt-0.5 size-3.5 shrink-0 fill-warning text-warning"
            :aria-label="t('home.favorite')"
          />
        </div>
        <p
          class="mt-2.5 flex min-w-0 items-center gap-1.5 text-small text-fg-muted"
          data-test="connection-health"
        >
          <DsStatusDot :state="DOTS[healthOf(c.id)?.state ?? 'idle']" :label="healthWords(healthOf(c.id))" />
          <span class="truncate" aria-hidden="true">{{ healthWords(healthOf(c.id)) }}</span>
          <DsBadge v-if="healthOf(c.id)?.alertsFiring" tone="danger" class="ml-auto shrink-0">{{
            t('alerts.firingCount', { count: healthOf(c.id)!.alertsFiring }, healthOf(c.id)!.alertsFiring)
          }}</DsBadge>
        </p>
        <div class="mt-3 flex min-w-0 items-center gap-1.5">
          <DsBadge>{{ t(`overview.roles.${c.access}`) }}</DsBadge>
          <DsBadge v-if="c.readOnly" tone="warning">{{ t('header.readOnly') }}</DsBadge>
          <DsBadge v-if="c.restricted" tone="info" class="min-w-0 truncate">{{
            t('layout.personalDataHidden')
          }}</DsBadge>
          <span
            class="ml-auto flex shrink-0 items-center gap-1 text-small font-medium text-accent-fg opacity-0 transition-opacity duration-160 group-hover:opacity-100"
            aria-hidden="true"
            >{{ t('home.open') }}<ArrowRight class="size-3.5"
          /></span>
        </div>
        <button
          type="button"
          class="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-none"
          :aria-label="t('home.openNamed', { name: c.name })"
          @click="openConnectionTab(tabs, c)"
        />
      </li>
    </ul>
    <p v-if="all.length > SHOWN" class="mt-3 text-small text-fg-subtle">
      {{ t('home.more', { n: all.length - SHOWN }) }}
    </p>
  </WidgetFrame>
</template>
