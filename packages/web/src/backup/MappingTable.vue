<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Eye, Table2, Timer } from 'lucide-vue-next'
import type { RestorePlan } from '@mongo-manager/shared/browser'
import { formatCount } from '@/format'

export interface MappingRow {
  from: { db: string; coll: string }
  to: { db: string; coll: string }
  type: 'collection' | 'view' | 'timeseries'
  on: boolean
}
/** U5: each archive namespace and its target, editable; conflicts come from the plan. */
const props = withDefaults(
  defineProps<{
    plan: RestorePlan | null
    /** The target connection's databases: a new database is never one of them (W4.4). */
    taken?: string[]
  }>(),
  { taken: () => [] },
)
const rows = defineModel<MappingRow[]>({ required: true })
const { t, locale } = useI18n()
// User report 2026-10-30: the target's databases offered in the "to" fields (a new one is typed).
const dbList = useId()
const bulkFrom = ref(rows.value[0]?.to.db ?? '')
const bulkTo = ref('')
const planned = (r: MappingRow) =>
  props.plan?.namespaces.find((n) => n.from.db === r.from.db && n.from.coll === r.from.coll)
// The server checks the same rules; here they only mark a field before a plan is asked for.
const validDb = (s: string) =>
  // eslint-disable-next-line no-control-regex -- NUL is one of the characters refused here
  /^[^/\\. "$*<>:|?\u0000]{1,63}$/.test(s) && !['admin', 'local', 'config'].includes(s)
const validColl = (s: string) =>
  s.length > 0 && s.length <= 255 && !s.includes('\u0000') && !s.includes('$') && !s.startsWith('system.')
const anyOn = computed(() => rows.value.some((r) => r.on))
const allOn = computed(() => rows.value.every((r) => r.on))
function renameDb(from: string, to: string): void {
  if (!validDb(to)) return
  rows.value = rows.value.map((r) => (r.to.db === from ? { ...r, to: { ...r.to, db: to } } : r))
  bulkFrom.value = to
}
function suffix(): void {
  for (const d of [...new Set(rows.value.map((r) => r.to.db))]) renameDb(d, `${d.slice(0, 54)}_restored`)
}
/**
 * W4.4 (U5): into new databases — "<source>_restore_<date>", numbered past any name the target already
 * has — so a restore never touches what is there. W4 review (minor): one new database per source
 * database, so two databases' collections of one name never meet (duplicate_target).
 */
const sourceDbs = computed(() => [...new Set(rows.value.map((r) => r.from.db))])
function intoNew(): void {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const taken = new Set([...props.taken, ...sourceDbs.value].map((n) => n.toLowerCase()))
  const into = new Map<string, string>()
  for (const db of sourceDbs.value) {
    const base = `${db.slice(0, 40)}_restore_${stamp}`
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()) && n < 1000; n++) name = `${base}_${n}`
    if (!validDb(name)) return
    taken.add(name.toLowerCase())
    into.set(db, name)
  }
  rows.value = rows.value.map((r) => ({ ...r, to: { ...r.to, db: into.get(r.from.db)! } }))
  bulkFrom.value = into.get(sourceDbs.value[0] ?? '') ?? ''
}
function setAll(on: boolean): void {
  rows.value = rows.value.map((r) => ({ ...r, on }))
}
const field =
  'h-8 rounded-md border bg-surface px-2 font-mono text-xs transition-colors focus:border-accent focus:ring-2 focus:ring-focus/30 focus:outline-none'
const ok = 'border-line-strong'
const bad = 'border-danger/30'
</script>

<template>
  <div class="flex flex-col gap-3">
    <datalist :id="dbList">
      <option v-for="name in taken" :key="name" :value="name" />
    </datalist>
    <div class="flex flex-wrap items-end gap-2 rounded-xl bg-subtle p-3 text-ui">
      <span class="w-full text-small font-medium tracking-wide text-fg-subtle uppercase">{{
        t('backup.restore.bulk')
      }}</span>
      <label class="flex flex-col gap-1 text-fg"
        >{{ t('backup.restore.bulkFrom') }}<input v-model="bulkFrom" :class="[field, ok, 'h-9 w-40 text-ui']"
      /></label>
      <ArrowRight class="mb-2.5 size-4 text-fg-subtle" aria-hidden="true" />
      <label class="flex flex-col gap-1 text-fg"
        >{{ t('backup.restore.bulkTo')
        }}<input
          v-model="bulkTo"
          :list="dbList"
          autocomplete="off"
          :class="[field, bulkTo !== '' && !validDb(bulkTo) ? bad : ok, 'h-9 w-48 text-ui']"
          :aria-invalid="bulkTo !== '' && !validDb(bulkTo)"
      /></label>
      <button
        type="button"
        class="h-9 cursor-pointer rounded-lg border border-line-strong px-3 font-medium transition-colors duration-150 hover:bg-surface focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-default disabled:opacity-50"
        :disabled="!validDb(bulkTo)"
        @click="renameDb(bulkFrom, bulkTo)"
      >
        {{ t('backup.restore.apply') }}
      </button>
      <span class="flex-1" />
      <button
        type="button"
        class="h-9 cursor-pointer rounded-full bg-accent-soft px-3 text-small font-medium text-accent-fg transition-colors duration-150 hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        @click="suffix"
      >
        {{ t('backup.restore.suggestSuffix') }}
      </button>
      <button
        type="button"
        class="h-9 cursor-pointer rounded-full bg-accent-soft px-3 text-small font-medium text-accent-fg transition-colors duration-150 hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        @click="intoNew"
      >
        {{ t('backup.restore.suggestNew', sourceDbs.length) }}
      </button>
    </div>
    <div role="table" class="flex flex-col text-ui" :aria-label="t('backup.restore.pick')">
      <div role="row" class="sr-only">
        <span role="columnheader">
          <input
            type="checkbox"
            :checked="allOn"
            :aria-label="allOn ? t('backup.scope.none') : t('backup.scope.all')"
            @change="setAll(($event.target as HTMLInputElement).checked)"
          />
        </span>
        <span role="columnheader">{{ t('backup.restore.bulkFrom') }}</span>
        <span role="columnheader">{{ t('backup.restore.bulkTo') }}</span>
      </div>
      <div
        v-for="(r, i) in rows"
        :key="`${r.from.db}.${r.from.coll}`"
        role="row"
        class="grid grid-cols-[1.25rem_minmax(0,1fr)_1rem_minmax(0,1.3fr)] items-center gap-x-2 gap-y-1 border-b border-line py-2 transition-opacity duration-150 last:border-0 sm:grid-cols-[1.25rem_minmax(0,1fr)_1rem_minmax(0,9rem)_minmax(0,1fr)_auto]"
        :class="r.on ? '' : 'opacity-50'"
      >
        <span role="cell" class="flex">
          <input
            v-model="rows[i]!.on"
            type="checkbox"
            class="size-4 accent-accent"
            :aria-label="`${r.from.db}.${r.from.coll}`"
          />
        </span>
        <span
          role="cell"
          class="flex min-w-0 items-center gap-1.5 font-mono text-fg"
          :title="`${r.from.db}.${r.from.coll}`"
        >
          <component
            :is="r.type === 'view' ? Eye : r.type === 'timeseries' ? Timer : Table2"
            class="size-4 shrink-0 text-fg-subtle"
            aria-hidden="true"
          />
          <span class="truncate">{{ r.from.db }}.{{ r.from.coll }}</span>
        </span>
        <ArrowRight class="size-4 text-fg-subtle" aria-hidden="true" />
        <span role="cell" class="contents">
          <input
            v-model="rows[i]!.to.db"
            :list="dbList"
            autocomplete="off"
            :aria-label="`${r.from.db}.${r.from.coll}: ${t('backup.restore.bulkTo')}`"
            :class="[field, validDb(r.to.db) ? ok : bad, 'min-w-0']"
            :aria-invalid="!validDb(r.to.db)"
            :disabled="!r.on"
          />
          <input
            v-model="rows[i]!.to.coll"
            :aria-label="`${r.from.db}.${r.from.coll}`"
            :class="[field, validColl(r.to.coll) ? ok : bad, 'col-start-4 min-w-0 sm:col-start-auto']"
            :aria-invalid="!validColl(r.to.coll)"
            :disabled="!r.on"
          />
        </span>
        <span role="cell" class="col-start-4 justify-self-start sm:col-start-auto sm:justify-self-end">
          <template v-if="r.on && planned(r)">
            <span
              v-if="planned(r)!.skipped"
              class="rounded-full bg-muted px-2 py-0.5 text-small whitespace-nowrap text-fg-muted"
              :title="planned(r)!.skipped"
              >{{ t('backup.restore.skippedBadge') }}</span
            >
            <span
              v-else-if="planned(r)!.exists"
              class="rounded-full bg-warning-soft px-2 py-0.5 text-small whitespace-nowrap text-warning"
            >
              {{
                planned(r)!.documents === null
                  ? t('backup.restore.existsView')
                  : t('backup.restore.exists', { count: formatCount(planned(r)!.documents!, locale) })
              }}
            </span>
            <span
              v-else
              class="rounded-full bg-success-soft px-2 py-0.5 text-small whitespace-nowrap text-success"
              >{{ t('backup.restore.new') }}</span
            >
          </template>
        </span>
      </div>
    </div>
    <p v-if="!anyOn" class="text-ui text-danger" role="alert">
      {{ t('backup.restore.pick') }}
    </p>
  </div>
</template>
