<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowDown, ArrowUp, Gauge, Plus, Trash2 } from 'lucide-vue-next'
import { MAX_SHARD_KEY_FIELDS, type KeyHints, type ShardKey } from '@mongo-manager/shared/browser'
import DsSheet from '@/ds/DsSheet.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import type { DsColumn } from '@/ds/table'
import { connectionsApi, queryKeys } from '@/api/connections'
import { serverApi } from '@/api/server'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'

/**
 * W3.2: shard a collection. The key is built field by field (ranged or hashed, in order); "Check
 * this key" reads a sample on the server and answers counts only — how many distinct values, how
 * often the commonest appears, whether values grow with time, whether an index supports it — with a
 * verdict. Sharding cannot be undone (only resharded): the namespace is typed to confirm.
 */
const props = defineProps<{ connectionId: string; sharded: readonly string[] }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()

const SYSTEM = new Set(['admin', 'config', 'local'])
const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connectionId)),
  queryFn: () => connectionsApi.databases(props.connectionId),
})
const db = ref('')
const coll = ref('')
const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, db.value)),
  queryFn: () => connectionsApi.collections(props.connectionId, db.value),
  enabled: computed(() => db.value !== ''),
})
const dbOptions = computed(() => [
  { value: '', label: t('shardingAdmin.shard.chooseDb') },
  ...(databases.data.value?.databases ?? [])
    .filter((d) => !SYSTEM.has(d.name))
    .map((d) => ({ value: d.name, label: d.name })),
])
const collOptions = computed(() => [
  { value: '', label: t('shardingAdmin.shard.chooseColl') },
  ...(collections.data.value ?? [])
    .filter((c) => !c.name.startsWith('system.') && c.type !== 'view')
    .map((c) => ({ value: c.name, label: c.name })),
])
watch(db, () => (coll.value = ''))
const ns = computed(() => (db.value && coll.value ? `${db.value}.${coll.value}` : ''))
const already = computed(() => props.sharded.includes(ns.value))

let seq = 0
const key = ref<Array<ShardKey[number] & { id: number }>>([{ id: ++seq, field: '', kind: 'ranged' }])
const unique = ref(false)
const presplit = ref(false)
const chunks = ref('')
const zonesPresplit = ref(false)
const hashed = computed(() => key.value.some((f) => f.kind === 'hashed'))
watch(hashed, (h) => {
  if (h) unique.value = false
  else presplit.value = zonesPresplit.value = false
})
const kinds = computed(() => [
  { value: 'ranged' as const, label: t('shardingAdmin.shard.ranged') },
  { value: 'hashed' as const, label: t('shardingAdmin.shard.hashed') },
])
const fields = computed(() => key.value.map((f) => f.field.trim()).filter(Boolean))
const addField = () => key.value.push({ id: ++seq, field: '', kind: 'ranged' })
function move(i: number, by: -1 | 1): void {
  const next = [...key.value]
  const [item] = next.splice(i, 1)
  next.splice(i + by, 0, item!)
  key.value = next
}

const hints = ref<KeyHints | null>(null)
const hinting = ref(false)
const errors = ref<string[]>([])
const saving = ref(false)
watch([ns, () => fields.value.join(',')], () => (hints.value = null))
async function check(): Promise<void> {
  if (!ns.value || !fields.value.length) return
  hinting.value = true
  errors.value = []
  try {
    hints.value = await serverApi.keyHints(props.connectionId, ns.value, fields.value)
  } catch (e) {
    errors.value = [adminErrorText(e, t)]
  } finally {
    hinting.value = false
  }
}
const pct = (v: number) =>
  new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 1 }).format(v)
const num = (v: number) => new Intl.NumberFormat(locale.value).format(v)
const hintColumns = computed<DsColumn[]>(() => [
  { key: 'field', label: t('shardingAdmin.hints.field'), mono: true },
  { key: 'present', label: t('shardingAdmin.hints.present'), align: 'right', width: '7rem', hideBelow: 560 },
  { key: 'distinct', label: t('shardingAdmin.hints.distinct'), align: 'right', width: '7rem' },
  { key: 'top', label: t('shardingAdmin.hints.top'), align: 'right', width: '8rem' },
  { key: 'notes', label: t('shardingAdmin.hints.notes'), width: '30%', hideBelow: 640 },
])
const verdictTone = { good: 'success', fair: 'warning', poor: 'danger' } as const
const monotonicRanged = computed(
  () =>
    hints.value?.fields.some(
      (h) => h.monotonic && key.value.find((f) => f.field.trim() === h.field)?.kind === 'ranged',
    ) ?? false,
)

async function save(): Promise<void> {
  errors.value = []
  if (!ns.value) errors.value.push(t('shardingAdmin.shard.nsRequired'))
  if (!fields.value.length || fields.value.length !== key.value.length)
    errors.value.push(t('shardingAdmin.shard.fieldsRequired'))
  const n = Number(chunks.value)
  if (presplit.value && (!Number.isInteger(n) || n < 1 || n > 8192))
    errors.value.push(t('shardingAdmin.shard.chunksRange'))
  if (errors.value.length || saving.value) return
  const ok = await dialogs.confirm({
    title: t('shardingAdmin.shard.confirmTitle', { ns: ns.value }),
    message: t('shardingAdmin.shard.confirmMessage', {
      ns: ns.value,
      key: key.value.map((f) => `${f.field.trim()}: ${f.kind === 'hashed' ? 'hashed' : 1}`).join(', '),
    }),
    confirmLabel: t('shardingAdmin.shard.confirm'),
    danger: true,
    requireText: ns.value,
  })
  if (!ok) return
  saving.value = true
  try {
    await serverApi.shardCollection(props.connectionId, {
      ns: ns.value,
      key: key.value.map((f) => ({ field: f.field.trim(), kind: f.kind })),
      unique: unique.value,
      ...(presplit.value ? { numInitialChunks: n } : {}),
      ...(zonesPresplit.value ? { presplitHashedZones: true } : {}),
      confirm: true,
    })
    toasts.push({ kind: 'success', message: t('shardingAdmin.shard.done', { ns: ns.value }) })
    await queryClient.invalidateQueries({
      queryKey: ['connections', props.connectionId, 'server', 'sharding'],
    })
    emit('close')
  } catch (e) {
    errors.value = [adminErrorText(e, t)]
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DsSheet
    open
    :title="t('shardingAdmin.shard.title')"
    :subtitle="t('shardingAdmin.shard.subtitle')"
    :dirty="!!ns"
    @close="emit('close')"
  >
    <form class="flex max-w-3xl flex-col gap-5" data-shard-collection @submit.prevent="save">
      <DsFormErrors :messages="errors" />
      <section class="flex flex-col gap-3">
        <h3 class="text-ui font-semibold text-fg">{{ t('shardingAdmin.shard.collection') }}</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <DsSelect v-model="db" :label="t('shardingAdmin.shard.db')" :options="dbOptions" />
          <DsSelect
            v-model="coll"
            :label="t('shardingAdmin.shard.coll')"
            :options="collOptions"
            :disabled="!db"
          />
        </div>
        <DsCallout v-if="already" tone="warning">{{ t('shardingAdmin.shard.already', { ns }) }}</DsCallout>
      </section>
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-ui font-semibold text-fg">{{ t('shardingAdmin.shard.key') }}</h3>
          <DsButton size="sm" :icon="Plus" :disabled="key.length >= MAX_SHARD_KEY_FIELDS" @click="addField">{{
            t('shardingAdmin.shard.addField')
          }}</DsButton>
        </div>
        <p class="text-small text-fg-subtle">{{ t('shardingAdmin.shard.keyHelp') }}</p>
        <ol class="flex flex-col gap-2">
          <li
            v-for="(f, i) in key"
            :key="f.id"
            class="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2"
          >
            <DsInput
              v-model="f.field"
              class="min-w-40 flex-1"
              size="sm"
              mono
              spellcheck="false"
              autocomplete="off"
              :label="t('shardingAdmin.shard.field', { n: i + 1 })"
            />
            <DsSegmented
              v-model="f.kind"
              size="sm"
              :label="t('shardingAdmin.shard.kind', { n: i + 1 })"
              :options="kinds"
            />
            <DsIconButton
              size="sm"
              :icon="ArrowUp"
              :label="t('shardingAdmin.shard.up', { n: i + 1 })"
              :disabled="i === 0"
              @click="move(i, -1)"
            />
            <DsIconButton
              size="sm"
              :icon="ArrowDown"
              :label="t('shardingAdmin.shard.down', { n: i + 1 })"
              :disabled="i === key.length - 1"
              @click="move(i, 1)"
            />
            <DsIconButton
              size="sm"
              :icon="Trash2"
              :label="t('shardingAdmin.shard.removeField', { n: i + 1 })"
              :disabled="key.length === 1"
              @click="key = key.filter((x) => x.id !== f.id)"
            />
          </li>
        </ol>
        <div>
          <DsButton
            size="sm"
            :icon="Gauge"
            :loading="hinting"
            :disabled="!ns || !fields.length"
            data-check-key
            @click="check"
            >{{ t('shardingAdmin.hints.check') }}</DsButton
          >
        </div>
        <div v-if="hints" class="flex flex-col gap-3 rounded-lg bg-subtle p-3" data-key-hints>
          <div class="flex flex-wrap items-center gap-2">
            <DsBadge :tone="verdictTone[hints.verdict]">{{
              t(`shardingAdmin.hints.verdict.${hints.verdict}`)
            }}</DsBadge>
            <span class="text-small text-fg-muted">{{
              t('shardingAdmin.hints.sampled', {
                n: num(hints.sampled),
                of: hints.documents === null ? '—' : num(hints.documents),
                distinct: num(hints.combined.distinct),
                top: pct(hints.combined.topShare),
              })
            }}</span>
          </div>
          <DsDataTable
            dense
            :label="t('shardingAdmin.hints.title')"
            :columns="hintColumns"
            :rows="hints.fields"
            :row-key="(h: KeyHints['fields'][number]) => h.field"
          >
            <template #cell-present="{ row: h }">{{
              pct(hints.sampled ? h.present / hints.sampled : 0)
            }}</template>
            <template #cell-distinct="{ row: h }">{{ num(h.distinct) }}</template>
            <template #cell-top="{ row: h }">{{ pct(h.topShare) }}</template>
            <template #cell-notes="{ row: h }">
              <DsBadge v-if="h.monotonic" tone="warning">{{ t('shardingAdmin.hints.monotonic') }}</DsBadge>
              <DsBadge v-else-if="h.topShare >= 0.3" tone="danger">{{
                t('shardingAdmin.hints.hot')
              }}</DsBadge>
            </template>
          </DsDataTable>
          <DsCallout v-if="monotonicRanged" tone="warning">{{
            t('shardingAdmin.hints.monotonicHelp')
          }}</DsCallout>
          <DsCallout v-if="!hints.indexed" tone="info">{{ t('shardingAdmin.hints.noIndex') }}</DsCallout>
          <p class="text-small text-fg-subtle">{{ t(`shardingAdmin.hints.verdictHelp.${hints.verdict}`) }}</p>
        </div>
      </section>
      <section class="flex flex-col gap-3">
        <h3 class="text-ui font-semibold text-fg">{{ t('shardingAdmin.shard.options') }}</h3>
        <DsCheckbox
          v-model="unique"
          :disabled="hashed"
          :label="t('shardingAdmin.shard.unique')"
          :hint="hashed ? t('shardingAdmin.shard.uniqueHashed') : t('shardingAdmin.shard.uniqueHint')"
        />
        <DsCheckbox
          v-model="presplit"
          :disabled="!hashed"
          :label="t('shardingAdmin.shard.presplit')"
          :hint="t('shardingAdmin.shard.presplitHint')"
        />
        <DsInput
          v-if="presplit"
          v-model="chunks"
          class="max-w-48"
          size="sm"
          inputmode="numeric"
          :label="t('shardingAdmin.shard.chunks')"
        />
        <DsCheckbox
          v-model="zonesPresplit"
          :disabled="!hashed"
          :label="t('shardingAdmin.shard.zonesPresplit')"
          :hint="t('shardingAdmin.shard.zonesPresplitHint')"
        />
      </section>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <div class="flex justify-end gap-2">
        <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
        <DsButton variant="primary" :loading="saving" :disabled="already" data-shard-save @click="save">{{
          t('shardingAdmin.shard.save')
        }}</DsButton>
      </div>
    </template>
  </DsSheet>
</template>
