<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import {
  ChevronRight,
  ChevronsUpDown,
  Download,
  FilterX,
  ListTree,
  RotateCw,
  ScrollText,
  Sparkles,
} from 'lucide-vue-next'
import { ALL_AUDIT_ACTIONS } from '@mongo-manager/shared/browser'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCombobox from '@/ds/DsCombobox.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsCodeView from '@/ds/DsCodeView.vue'
import { accountKeys, auditApi, usersApi, type AuditFilter } from '@/api/account'
import { connectionsApi, queryKeys } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useSessionStore } from '@/stores/session'
import AuditRetentionCard from './AuditRetentionCard.vue'
import { useAuditWords } from './auditWords'

/**
 * The audit log (phase 1g), redesigned (phase 4c §5): who did what and when, filtered, a page at a
 * time; exported (§1) as the filters show it; how long it is kept (§2). Opened on one user from the
 * users' activity (`userId`).
 */
const props = defineProps<{ userId?: string }>()
const PAGE = 50
const { t, locale } = useI18n()
const session = useSessionStore()
const form = reactive({ action: '', userId: props.userId ?? '', connectionId: '', from: '', to: '' })
const rangeError = ref('')
const applied = ref<AuditFilter>({ limit: PAGE, ...(props.userId ? { userId: props.userId } : {}) })
const open = ref(new Set<number>())
const words = useAuditWords()

/**
 * Audit action labels (2026-10-28): an action is picked by its words (or found by its code), not typed
 * as a code one has to know.
 */
const actionOptions = computed(() => [
  { value: '', label: t('audit.anyAction') },
  ...ALL_AUDIT_ACTIONS.map((a) => ({ value: a as string, label: words.action(a).text, hint: a })).sort(
    (x, y) => x.label.localeCompare(y.label, locale.value),
  ),
])
const actionShown = computed(() => (form.action ? words.action(form.action).text : t('audit.anyAction')))
const actionFilterId = useId()
/**
 * Final review: a code with no words (an older version's, a row changed outside the app) is still
 * filtered on by typing it, as the old free-text field allowed.
 */
const CODE = /^[a-zA-Z]+\.[a-zA-Z0-9_.]+$/
const codeOption = (typed: string) =>
  CODE.test(typed) ? { value: typed, label: t('audit.actionCode', { code: typed }) } : null
/** An entry's action in words, its code beside them in the tooltip; one with no words is its code. */
function actionOf(code: string): { text: string; known: boolean; title: string } {
  const said = words.action(code)
  return { ...said, title: said.known ? `${said.text}\n${code}` : code }
}

const pages = useInfiniteQuery({
  queryKey: computed(() => accountKeys.audit(applied.value)),
  queryFn: ({ pageParam }) =>
    auditApi.list({ ...applied.value, ...(pageParam ? { beforeId: pageParam } : {}) }),
  initialPageParam: 0,
  getNextPageParam: (last) => (last.length === PAGE ? last.at(-1)!.id : undefined),
})
const entries = computed(() => pages.data.value?.pages.flat() ?? [])
/** Each entry with its action's words, worked out once (final review). */
const rows = computed(() => entries.value.map((entry) => ({ entry, said: actionOf(entry.action) })))
/**
 * Security audit 2026-10-16: whether the log's chain checks — an entry changed, removed or added
 * outside the app breaks it. Asked again whenever the log is.
 */
const integrity = useQuery({ queryKey: accountKeys.auditIntegrity, queryFn: auditApi.integrity })

const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const connectionName = (id: string | null) =>
  id ? (connections.value?.find((c) => c.id === id)?.name ?? id) : ''
const users = useQuery({
  queryKey: accountKeys.users,
  queryFn: usersApi.list,
  enabled: computed(() => session.status?.mode === 'team' && session.can('users:manage')),
})
const userOptions = computed(() => [
  { value: '', label: t('audit.anyUser') },
  ...(users.data.value ?? []).map((u) => ({ value: u.id, label: u.username })),
])

const time = (ms: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'medium' }).format(ms)
const TONES = { success: 'accent', denied: 'warning', failure: 'danger' } as const

const connectionOptions = computed(() => [
  { value: '', label: t('audit.anyConnection') },
  ...(connections.value ?? []).map((c) => ({ value: c.id, label: c.name })),
])

/** A date field's day in local time: its first or last millisecond, as an instant. */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString()
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString()

/** A date input can hold a year Date cannot represent (e.g. 20260); such a day has no instant. */
const validDay = (d: string) => !d || !Number.isNaN(new Date(`${d}T00:00:00`).getTime())

function apply(): void {
  rangeError.value = ''
  if (!validDay(form.from) || !validDay(form.to)) {
    rangeError.value = t('audit.dateInvalid')
    return
  }
  if (form.from && form.to && form.from > form.to) {
    rangeError.value = t('audit.rangeReversed')
    return
  }
  applied.value = {
    limit: PAGE,
    ...(form.action.trim() ? { action: form.action.trim() } : {}),
    ...(form.userId ? { userId: form.userId } : {}),
    ...(form.connectionId ? { connectionId: form.connectionId } : {}),
    ...(form.from ? { from: dayStart(form.from) } : {}),
    ...(form.to ? { to: dayEnd(form.to) } : {}),
  }
  open.value = new Set()
}
const narrowed = computed(() => Object.keys(applied.value).some((k) => k !== 'limit'))
function clear(): void {
  Object.assign(form, { action: '', userId: '', connectionId: '', from: '', to: '' })
  apply()
}
// Opened again on another user (from their activity): that user's entries.
watch(
  () => props.userId,
  (id) => {
    form.userId = id ?? ''
    apply()
  },
)

/** Phase 4c §1: the export follows what the filters show (every entry, not a page). */
const exportHref = (format: 'csv' | 'ndjson') => {
  const { limit: _limit, ...filter } = applied.value
  return auditApi.exportHref(filter, format)
}

/**
 * Design 2026-10-25 (B6): the assistant turn an entry belongs to — a route's row made by one of its calls
 * (`agent`), or the assistant's own row (a tool call, an answer).
 */
function turnOf(entry: { action: string; details: unknown }): string | null {
  const d = (entry.details ?? {}) as { agent?: { run?: unknown }; run?: unknown }
  if (typeof d.agent?.run === 'string') return d.agent.run
  return entry.action.startsWith('ai.') && typeof d.run === 'string' ? d.run : null
}
/** Review of B6 (M2): made by the assistant — a route's row for its call, or its own tool call. */
function byAssistant(entry: { action: string; details: unknown }): boolean {
  const d = (entry.details ?? {}) as { agent?: { run?: unknown } }
  return typeof d.agent?.run === 'string' || (entry.action === 'ai.agent.tool' && turnOf(entry) !== null)
}
/** One turn's entries, whatever the other filters said. */
function showTurn(run: string): void {
  Object.assign(form, { action: '', userId: '', connectionId: '', from: '', to: '' })
  rangeError.value = ''
  applied.value = { limit: PAGE, run }
  open.value = new Set()
}

function toggle(id: number): void {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}
/**
 * Not DsDataTable: an entry opens a details row under it, which the kit's table has no place for. Its
 * look is the kit table's — a sticky head, hairlines and 32 px rows (UI redesign R2–R5 spec §2).
 */
const th =
  'sticky top-0 z-10 border-b border-line bg-surface px-3 py-2 text-left text-small font-medium whitespace-nowrap text-fg-subtle first:pl-4'
const td = 'h-8 border-b border-line px-3 align-middle first:pl-4'
/** The action picker's button, in the measure of the kit's fields (DsSelect). */
const actionTrigger =
  'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-ui text-fg transition-[border-color,box-shadow] duration-120 ease-out-soft hover:border-fg-subtle focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/20 focus-visible:outline-none'
/** The kit's small secondary button (DsButton size sm), on a download link. */
const exportLink =
  'inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-small font-medium whitespace-nowrap text-fg select-none transition-[background-color,border-color,color,opacity,transform] duration-120 ease-out-soft hover:bg-subtle active:translate-y-px'
</script>

<template>
  <section data-admin-page class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="t('tabs.audit')" :icon="ScrollText" :description="t('audit.subtitle')">
      <template #actions>
        <div class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('audit.export')">
          <a
            v-for="f in ['csv', 'ndjson'] as const"
            :key="f"
            :data-audit-export="f"
            :href="exportHref(f)"
            download
            :class="exportLink"
          >
            <Download class="size-4 shrink-0" aria-hidden="true" />{{
              t(`audit.export${f === 'csv' ? 'Csv' : 'Ndjson'}`)
            }}
          </a>
        </div>
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-5">
        <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <form
            class="grid grid-cols-1 items-end gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:grid-cols-2 xl:grid-cols-3"
            novalidate
            @submit.prevent="apply"
          >
            <div data-audit-action-filter class="flex min-w-0 flex-col gap-1.5">
              <label :for="actionFilterId" class="text-small font-medium text-fg-muted">{{
                t('audit.filterAction')
              }}</label>
              <DsCombobox
                :label="t('audit.filterAction')"
                :trigger-label="`${t('audit.filterAction')}: ${actionShown}`"
                :trigger-id="actionFilterId"
                :items="actionOptions"
                :current="form.action"
                :placeholder="t('audit.findAction')"
                :empty-text="t('layout.noMatch')"
                :trigger-class="actionTrigger"
                panel-class="w-[30rem] max-w-[calc(100vw-2rem)]"
                search-hints
                :free-option="codeOption"
                @select="form.action = $event"
              >
                <template #trigger>
                  <span class="min-w-0 flex-1 truncate text-left">{{ actionShown }}</span>
                  <ChevronsUpDown class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                </template>
              </DsCombobox>
            </div>
            <DsSelect
              v-if="users.data.value"
              v-model="form.userId"
              :label="t('audit.filterUser')"
              :options="userOptions"
            />
            <DsSelect
              v-model="form.connectionId"
              :label="t('audit.filterConnection')"
              :options="connectionOptions"
            />
            <div>
              <DsInput v-model="form.from" type="date" :label="t('audit.from')" :error="rangeError" />
            </div>
            <div>
              <DsInput v-model="form.to" type="date" :label="t('audit.to')" />
            </div>
            <div class="flex items-center gap-1">
              <DsButton type="submit" variant="primary">{{ t('audit.apply') }}</DsButton>
              <DsButton v-if="narrowed" variant="ghost" :icon="FilterX" @click="clear">{{
                t('audit.clear')
              }}</DsButton>
            </div>
          </form>
          <AuditRetentionCard />
        </div>

        <DsCallout
          v-if="integrity.data.value && !integrity.data.value.ok && integrity.data.value.brokenAt"
          data-audit-chain-broken
          tone="danger"
          :title="t('audit.chain.brokenTitle')"
        >
          {{
            t('audit.chain.broken', {
              id: integrity.data.value.brokenAt.id,
              time: time(integrity.data.value.brokenAt.at),
            })
          }}
        </DsCallout>
        <!-- Review of the audit fixes (important 4): entries the chain does not cover are said. -->
        <DsCallout
          v-if="integrity.data.value && integrity.data.value.legacy > 0"
          data-audit-chain-legacy
          tone="info"
        >
          {{ t('audit.chain.legacy', { n: integrity.data.value.legacy }, integrity.data.value.legacy) }}
        </DsCallout>
        <!-- B6: one assistant turn's entries are shown, until cleared. -->
        <DsCallout v-if="applied.run" tone="info" data-audit-turn>
          {{ t('audit.oneTurn') }}
          <template #action>
            <DsButton size="sm" :icon="FilterX" @click="clear">{{ t('audit.clear') }}</DsButton>
          </template>
        </DsCallout>
        <DsCallout v-if="pages.isError.value" tone="danger">
          {{ describeError(pages.error.value, t) }}
          <template #action>
            <DsButton size="sm" :icon="RotateCw" @click="pages.refetch()">{{ t('common.retry') }}</DsButton>
          </template>
        </DsCallout>
        <div
          v-else-if="pages.isPending.value"
          class="flex flex-col gap-2 p-1"
          role="status"
          :aria-label="t('app.loading')"
        >
          <DsSkeleton v-for="n in 4" :key="n" class="h-6" />
        </div>
        <DsEmptyState v-else-if="entries.length === 0" :icon="ScrollText" :title="t('audit.empty')" />
        <!-- No scroll box of its own, so the head sticks to the page's scroller (as DsDataTable). -->
        <div v-else class="min-w-0 overflow-x-clip">
          <table
            class="w-full table-fixed border-separate border-spacing-0 text-ui"
            :aria-label="t('tabs.audit')"
          >
            <thead>
              <tr>
                <th scope="col" :class="th" class="w-12">
                  <span class="sr-only">{{ t('audit.details') }}</span>
                </th>
                <th scope="col" :class="th" class="w-44">{{ t('audit.time') }}</th>
                <th scope="col" :class="th" class="w-32">{{ t('audit.user') }}</th>
                <th scope="col" :class="th" class="w-56">{{ t('audit.action') }}</th>
                <th scope="col" :class="th">{{ t('audit.target') }}</th>
                <th scope="col" :class="th" class="w-28">{{ t('audit.outcome') }}</th>
                <th scope="col" :class="th" class="w-32">{{ t('audit.ip') }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="{ entry, said } in rows" :key="entry.id">
                <tr data-entry class="transition-colors duration-120 hover:bg-subtle">
                  <td :class="td">
                    <!-- Final review: always, so an entry's code is in reach without a pointer. -->
                    <button
                      type="button"
                      class="grid size-6 cursor-pointer place-items-center rounded-md text-fg-subtle hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
                      :aria-expanded="open.has(entry.id)"
                      :aria-label="t('audit.showDetails')"
                      @click="toggle(entry.id)"
                    >
                      <ChevronRight
                        class="size-4 transition-transform duration-120"
                        :class="open.has(entry.id) ? 'rotate-90' : ''"
                        aria-hidden="true"
                      />
                    </button>
                  </td>
                  <td :class="td" class="truncate text-fg-muted tabular-nums">
                    {{ time(entry.at) }}
                  </td>
                  <td :class="td" class="truncate text-fg">{{ entry.username ?? t('audit.system') }}</td>
                  <td :class="td" class="py-1 leading-snug text-fg">
                    <!-- Final review: two lines before it is cut, its whole name in the tooltip. -->
                    <span class="line-clamp-2"
                      ><!-- B6: made by the assistant, for one of its turns. -->
                      <span v-if="byAssistant(entry)" :title="t('audit.byAssistant')" data-audit-assistant>
                        <Sparkles
                          class="mr-1 inline size-3.5 align-[-2px] text-accent-fg"
                          aria-hidden="true"
                        />
                        <span class="sr-only">{{ t('audit.byAssistant') }}</span> </span
                      ><span
                        data-audit-action
                        :title="said.title"
                        :class="said.known ? '' : 'font-mono text-[12.5px]'"
                        >{{ said.text }}</span
                      ><span v-if="said.known" class="sr-only"> ({{ entry.action }})</span></span
                    >
                  </td>
                  <td
                    :class="td"
                    class="truncate text-small"
                    :title="[connectionName(entry.connectionId), entry.namespace].filter(Boolean).join(' ')"
                  >
                    <span class="text-fg">{{ connectionName(entry.connectionId) }}</span>
                    <span v-if="entry.namespace" class="ml-1 font-mono text-fg-subtle">{{
                      entry.namespace
                    }}</span>
                  </td>
                  <td :class="td">
                    <DsBadge :tone="TONES[entry.outcome]">{{ t(`audit.outcomes.${entry.outcome}`) }}</DsBadge>
                  </td>
                  <td :class="td" class="truncate font-mono text-[12.5px] text-fg-subtle">{{ entry.ip }}</td>
                </tr>
                <tr v-if="open.has(entry.id)">
                  <td class="border-b border-line" />
                  <td colspan="6" class="border-b border-line px-3 pt-1 pb-3">
                    <div class="flex flex-col gap-2 rounded-lg bg-subtle p-3">
                      <p data-audit-code class="font-mono text-[12.5px] text-fg-subtle">
                        {{ t('audit.actionCode', { code: entry.action }) }}
                      </p>
                      <DsCodeView
                        v-if="entry.details !== null"
                        :text="JSON.stringify(entry.details, null, 2)"
                      />
                      <div v-if="turnOf(entry) && applied.run !== turnOf(entry)">
                        <DsButton
                          size="sm"
                          variant="ghost"
                          :icon="ListTree"
                          @click="showTurn(turnOf(entry)!)"
                          >{{ t('audit.showTurn') }}</DsButton
                        >
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <DsButton
          v-if="pages.hasNextPage.value"
          size="sm"
          class="self-center"
          :loading="pages.isFetchingNextPage.value"
          @click="pages.fetchNextPage()"
        >
          {{ t('audit.loadMore') }}
        </DsButton>
      </div>
    </div>
  </section>
</template>
