<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ChevronRight, Filter, RotateCw, ScanSearch, Timer } from 'lucide-vue-next'
import type { SlowQueriesQuery } from '@mongo-manager/shared/browser'
import { serverApi, serverKeys, type SlowQuery } from '@/api/server'
import { describeError } from '@/api/errors'
import { openLibraryItem } from '@/library/openItem'
import { originToLibraryItem } from '@/shell/results'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { groupByShape, type ShapeGroup } from './slowShapes'
/**
 * Phase 3b spec §3.2: slow operations from the profiler and the server log, newest first. The
 * command is shown as text; "Open in Explain" is offered only to a user who sees the values.
 * UI redesign R3 §4: a card with its filter bar on the kit; each entry opens in place (a data table
 * has no expanding rows, as Schema's fields).
 */
const props = defineProps<{ connectionId: string; restricted: boolean }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()

interface Form {
  db: string
  coll: string
  minMs: number | ''
  source: 'both' | 'profile' | 'log'
}
const form = ref<Form>({ db: '', coll: '', minMs: '', source: 'both' })
// The field speaks text; the form keeps a number, or '' for no minimum (as v-model.number did).
const minMs = computed({
  get: () => String(form.value.minMs),
  set: (v: string) => (form.value.minMs = v === '' ? '' : Number(v)),
})
const sources = computed(() =>
  (['both', 'profile', 'log'] as const).map((value) => ({ value, label: t(`slowQueries.sources.${value}`) })),
)
const applied = ref<SlowQueriesQuery>({ source: 'both', limit: 100 })
function apply(): void {
  const f = form.value
  applied.value = {
    source: f.source,
    limit: 100,
    ...(f.db.trim() ? { db: f.db.trim() } : {}),
    ...(f.db.trim() && f.coll.trim() ? { coll: f.coll.trim() } : {}),
    ...(f.minMs !== '' ? { minMs: Number(f.minMs) } : {}),
  }
}

const list = useQuery({
  queryKey: computed(() => serverKeys.slowQueries(props.connectionId, applied.value)),
  queryFn: () => serverApi.slowQueries(props.connectionId, applied.value),
  retry: false,
})
const entries = computed(() => list.data.value?.entries ?? [])
const refused = computed(() =>
  Object.entries(list.data.value?.refused ?? {}).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  ),
)
const open = ref<number | null>(null)
/** Many documents read for each one returned: an index may be missing. */
const INDEX_RATIO = 100
const missingIndex = (e: SlowQuery) => (e.docsExamined ?? 0) > INDEX_RATIO * Math.max(1, e.nreturned ?? 0)
const when = (iso: string) => new Date(iso).toLocaleString(locale.value)
const ids = useId()
const detailId = (i: number) => `${ids}-${i}`

// Index advice gaps (2026-10-27, wave 4 #6): the same queries counted together by what they asked.
const view = ref<'list' | 'shape'>('list')
const views = computed(() =>
  (['list', 'shape'] as const).map((value) => ({ value, label: t(`slowQueries.views.${value}`) })),
)
const groups = computed(() => groupByShape(entries.value))
const openGroup = ref<string | null>(null)
/** A shape as shown: what it asked, after the command's name. */
const asked = (g: ShapeGroup) => g.shape.slice(g.shape.indexOf(' ') + 1) || g.shape
const ms = (n: number) => t('slowQueries.ms', { n: new Intl.NumberFormat(locale.value).format(n) })

function explain(e: SlowQuery): void {
  if (!e.origin || props.restricted) return
  void openLibraryItem(props.connectionId, originToLibraryItem(e.origin), { t, queryClient, explain: true })
}
</script>

<template>
  <DsCard
    :title="t('slowQueries.title')"
    :count="list.data.value ? entries.length : undefined"
    data-slow-queries
  >
    <div class="flex flex-col gap-3">
      <form
        class="flex flex-wrap items-end gap-3 rounded-lg bg-subtle p-3"
        data-slow-form
        @submit.prevent="apply"
      >
        <!-- User report 2026-10-30: the connection's names offered (a filter: any namespace). -->
        <NamespaceNameInput
          v-model="form.db"
          kind="database"
          :connection-id="connectionId"
          class="w-36"
          size="sm"
          mono
          maxlength="64"
          autocomplete="off"
          :label="t('slowQueries.db')"
          data-slow-db
        />
        <NamespaceNameInput
          v-model="form.coll"
          kind="collection"
          :connection-id="connectionId"
          :db="form.db"
          views
          class="w-36"
          size="sm"
          mono
          maxlength="255"
          autocomplete="off"
          :label="t('slowQueries.coll')"
        />
        <DsInput
          v-model="minMs"
          class="w-28"
          size="sm"
          type="number"
          min="0"
          inputmode="numeric"
          :label="t('slowQueries.minMs')"
        />
        <DsSelect
          v-model="form.source"
          class="w-44"
          size="sm"
          :label="t('slowQueries.source')"
          :options="sources"
        />
        <DsButton type="submit" size="sm" :icon="Filter">{{ t('slowQueries.apply') }}</DsButton>
      </form>
      <DsSegmented v-model="view" size="sm" :label="t('slowQueries.views.label')" :options="views" />
      <DsCallout v-for="[src, reason] in refused" :key="src" tone="warning" :data-slow-refused="src">
        {{ t(`slowQueries.refused.${src}.${reason}`) }}
      </DsCallout>
      <DsCallout v-if="list.isError.value" tone="danger">
        {{ describeError(list.error.value, t) }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" @click="list.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
      </DsCallout>
      <div
        v-else-if="list.isPending.value"
        class="flex flex-col gap-2 p-1"
        role="status"
        :aria-label="t('app.loading')"
      >
        <DsSkeleton v-for="n in 4" :key="n" class="h-6" />
      </div>
      <DsEmptyState
        v-else-if="entries.length === 0"
        :icon="Timer"
        :title="t('slowQueries.none')"
        :description="t('slowQueries.noneHint')"
      />
      <ul v-else-if="view === 'shape'" class="flex flex-col" :aria-label="t('slowQueries.views.shape')">
        <li v-for="g in groups" :key="g.key" class="border-b border-line last:border-b-0">
          <button
            type="button"
            class="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-ui transition-colors duration-120 hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            data-slow-group
            :aria-expanded="openGroup === g.key"
            :aria-controls="openGroup === g.key ? `${ids}-group` : undefined"
            @click="openGroup = openGroup === g.key ? null : g.key"
          >
            <ChevronRight
              class="size-3.5 shrink-0 text-fg-subtle transition-transform duration-160 motion-reduce:transition-none"
              :class="openGroup === g.key ? 'rotate-90' : ''"
              aria-hidden="true"
            />
            <span class="w-20 shrink-0 text-right font-mono text-[12.5px] text-fg tabular-nums">{{
              ms(g.totalMs)
            }}</span>
            <span class="w-10 shrink-0 text-right text-small text-fg-muted tabular-nums">{{
              t('slowQueries.times', { n: g.count })
            }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" :title="g.shape">
              {{ g.ns }} <span class="text-fg-subtle">{{ asked(g) }}</span>
            </span>
            <DsBadge v-if="g.ratio !== null && g.ratio > INDEX_RATIO" tone="warning">
              {{ t('slowQueries.indexWarning') }}
            </DsBadge>
            <span class="hidden shrink-0 text-small text-fg-subtle md:inline">{{ g.op }}</span>
          </button>
          <div
            v-if="openGroup === g.key"
            :id="`${ids}-group`"
            data-slow-group-detail
            class="flex flex-col gap-2 pt-1 pb-3 pl-9"
          >
            <p class="text-small text-fg-muted">
              {{
                t('slowQueries.groupDetail', {
                  avg: ms(g.avgMs),
                  p95: ms(g.p95Ms),
                  max: ms(g.maxMs),
                  when: when(g.lastTs),
                })
              }}
            </p>
            <p v-if="g.ratio !== null" class="text-small text-fg-muted">
              {{ t('slowQueries.groupRatio', { n: new Intl.NumberFormat(locale).format(g.ratio) }) }}
            </p>
            <DsCodeBlock
              :code="g.shape"
              :label="t('slowQueries.shape')"
              :copy-label="t('slowQueries.copyShape')"
            />
            <p class="text-small text-fg-subtle">{{ t('slowQueries.newest') }}</p>
            <DsCodeBlock
              :code="g.newest.command"
              :label="t('performance.command')"
              :copy-label="t('performance.copyCommand')"
            />
            <div v-if="!restricted && g.newest.origin">
              <DsButton size="sm" :icon="ScanSearch" @click="explain(g.newest)">
                {{ t('slowQueries.explain') }}
              </DsButton>
            </div>
          </div>
        </li>
      </ul>
      <ul v-else class="flex flex-col" :aria-label="t('slowQueries.title')">
        <li v-for="(e, i) in entries" :key="i" class="border-b border-line last:border-b-0">
          <button
            type="button"
            class="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-ui transition-colors duration-120 hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            data-slow-entry
            :aria-expanded="open === i"
            :aria-controls="detailId(i)"
            @click="open = open === i ? null : i"
          >
            <ChevronRight
              class="size-3.5 shrink-0 text-fg-subtle transition-transform duration-160 motion-reduce:transition-none"
              :class="open === i ? 'rotate-90' : ''"
              aria-hidden="true"
            />
            <span class="w-20 shrink-0 text-right font-mono text-[12.5px] text-fg tabular-nums">{{
              t('slowQueries.ms', { n: e.durationMs })
            }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" :title="e.ns">{{
              e.ns
            }}</span>
            <DsBadge v-if="missingIndex(e)" tone="warning" data-slow-index-warning>
              {{ t('slowQueries.indexWarning') }}
            </DsBadge>
            <span class="hidden shrink-0 text-small text-fg-subtle md:inline">
              {{ e.op }} · {{ t(`slowQueries.sources.${e.source}`) }} · {{ when(e.ts) }}
            </span>
          </button>
          <div v-if="open === i" :id="detailId(i)" class="flex flex-col gap-2 pt-1 pb-3 pl-9">
            <p class="text-small text-fg-subtle md:hidden">
              {{ e.op }} · {{ t(`slowQueries.sources.${e.source}`) }} · {{ when(e.ts) }}
            </p>
            <p class="text-small text-fg-muted">
              {{
                t('slowQueries.detail', {
                  plan: e.planSummary ?? '—',
                  keys: e.keysExamined ?? '—',
                  docs: e.docsExamined ?? '—',
                  returned: e.nreturned ?? '—',
                })
              }}
            </p>
            <DsCodeBlock
              :code="e.command"
              :label="t('performance.command')"
              :copy-label="t('performance.copyCommand')"
            />
            <div v-if="!restricted && e.origin">
              <DsButton size="sm" :icon="ScanSearch" data-slow-explain @click="explain(e)">
                {{ t('slowQueries.explain') }}
              </DsButton>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </DsCard>
</template>
