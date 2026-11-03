<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, Lock, Plus, RefreshCw, RotateCw, Trash2 } from 'lucide-vue-next'
import {
  QE_BSON_TYPES,
  QE_EQUALITY_TYPES,
  QE_RANGE_TYPES,
  type DataKeyInfo,
  type EncryptedField,
  type KmsProvider,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import type { DsColumn } from '@/ds/table'
import { connectionsApi } from '@/api/connections'
import { describeError } from '@/api/errors'
import { reasonMessage } from '@/api/reasons'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import MasterKeyFields from './MasterKeyFields.vue'
import { emptyMasterKey, masterKeyOf } from './masterKey'

/**
 * W8 (completion): a connection's client-side encryption — its data keys (listed without their
 * key material; made, and rotated by rewrapping them under a master key) and its Queryable
 * Encryption collections (made with a key per encrypted field). For the connection's administrators.
 */
const props = defineProps<{ connectionId: string; readOnly: boolean }>()
const { t, locale } = useI18n()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()
const keysKey = computed(() => ['connections', props.connectionId, 'encryption', 'keys'] as const)

const summary = useQuery({
  queryKey: computed(() => ['connections', props.connectionId, 'encryption'] as const),
  queryFn: () => connectionsApi.encryption(props.connectionId),
})
const providers = computed(() => (summary.data.value?.providers ?? []) as KmsProvider[])
const usable = computed(() => summary.data.value?.enabled === true && summary.data.value.available)
const keys = useQuery({
  queryKey: keysKey,
  queryFn: () => connectionsApi.dataKeys(props.connectionId),
  enabled: usable,
})
const errorText = (e: unknown) => reasonMessage(e, t) ?? describeError(e, t)

const columns = computed<DsColumn[]>(() => [
  { key: 'id', label: t('encryption.keys.id'), mono: true },
  { key: 'altNames', label: t('encryption.keys.altNames') },
  { key: 'provider', label: t('encryption.provider'), width: '8rem' },
  { key: 'updated', label: t('encryption.keys.updated'), width: '11rem', hideBelow: 640 },
])
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale.value) : '—')

// A new data key.
const newKey = reactive({ open: false, masterKey: emptyMasterKey(), altNames: '' })
const createKey = useMutation({
  mutationFn: () =>
    connectionsApi.createDataKey(props.connectionId, {
      masterKey: masterKeyOf(newKey.masterKey),
      keyAltNames: newKey.altNames
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    }),
  onSuccess: (r) => {
    toasts.push({ kind: 'success', message: t('encryption.keys.created', { id: r.id }) })
    newKey.open = false
    newKey.altNames = ''
    void queryClient.invalidateQueries({ queryKey: keysKey.value })
  },
  onError: (e) => toasts.push({ kind: 'error', message: errorText(e) }),
})
function openNewKey(): void {
  newKey.masterKey = emptyMasterKey(providers.value[0] ?? 'local')
  newKey.open = true
}

// Rotation: every data key rewrapped under a master key (the same one, or a new one).
const rewrap = reactive({ open: false, masterKey: emptyMasterKey() })
const rewrapKeys = useMutation({
  mutationFn: () =>
    connectionsApi.rewrapDataKeys(props.connectionId, { masterKey: masterKeyOf(rewrap.masterKey) }),
  onSuccess: (r) => {
    toasts.push({ kind: 'success', message: t('encryption.keys.rewrapped', { n: r.rewrapped }, r.rewrapped) })
    rewrap.open = false
    void queryClient.invalidateQueries({ queryKey: keysKey.value })
  },
  onError: (e) => toasts.push({ kind: 'error', message: errorText(e) }),
})
async function confirmRewrap(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('encryption.keys.rewrapTitle'),
    message: t('encryption.keys.rewrapConfirm'),
    confirmLabel: t('encryption.keys.rewrap'),
  })
  if (ok) rewrapKeys.mutate()
}
function openRewrap(): void {
  rewrap.masterKey = emptyMasterKey(providers.value[0] ?? 'local')
  rewrap.open = true
}

// A Queryable Encryption collection, its fields one row each.
type QueryChoice = 'none' | 'equality' | 'range'
interface FieldRow {
  path: string
  bsonType: (typeof QE_BSON_TYPES)[number]
  query: QueryChoice
  min: string
  max: string
}
const newRow = (): FieldRow => ({ path: '', bsonType: 'string', query: 'equality', min: '', max: '' })
const collection = reactive({
  open: false,
  db: '',
  name: '',
  masterKey: emptyMasterKey(),
  fields: [newRow()] as FieldRow[],
})
const bsonTypes = QE_BSON_TYPES.map((b) => ({ value: b, label: b }))
const queryOptions = (row: FieldRow) => [
  { value: 'none' as const, label: t('encryption.collection.queries.none') },
  ...((QE_EQUALITY_TYPES as readonly string[]).includes(row.bsonType)
    ? [{ value: 'equality' as const, label: t('encryption.collection.queries.equality') }]
    : []),
  ...((QE_RANGE_TYPES as readonly string[]).includes(row.bsonType)
    ? [{ value: 'range' as const, label: t('encryption.collection.queries.range') }]
    : []),
]
const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
function fieldOf(row: FieldRow): EncryptedField {
  const queries =
    row.query === 'equality'
      ? { queryType: 'equality' as const }
      : row.query === 'range'
        ? {
            queryType: 'range' as const,
            ...(num(row.min) !== undefined ? { min: num(row.min)! } : {}),
            ...(num(row.max) !== undefined ? { max: num(row.max)! } : {}),
          }
        : undefined
  return { path: row.path.trim(), bsonType: row.bsonType, ...(queries ? { queries } : {}) }
}
const createCollection = useMutation({
  mutationFn: () =>
    connectionsApi.createEncryptedCollection(props.connectionId, collection.db.trim(), {
      name: collection.name.trim(),
      masterKey: masterKeyOf(collection.masterKey),
      fields: collection.fields.map(fieldOf),
    }),
  onSuccess: (r) => {
    toasts.push({
      kind: 'success',
      message: t('encryption.collection.created', { name: r.name, n: r.fields.length }, r.fields.length),
    })
    collection.open = false
    void queryClient.invalidateQueries({ queryKey: ['connections', props.connectionId, 'databases'] })
  },
  onError: (e) => toasts.push({ kind: 'error', message: errorText(e) }),
})
function openCollection(): void {
  collection.masterKey = emptyMasterKey(providers.value[0] ?? 'local')
  collection.fields = [newRow()]
  collection.open = true
}
</script>

<template>
  <section class="flex max-w-6xl flex-col gap-4 p-4" data-test="encryption-view">
    <DsCallout v-if="summary.isError.value" tone="danger">{{ errorText(summary.error.value) }}</DsCallout>
    <DsCallout v-else-if="summary.data.value && !summary.data.value.available" tone="warning">
      {{ t('encryption.unavailable') }}
    </DsCallout>
    <DsCallout v-else-if="summary.data.value && !summary.data.value.enabled" tone="info">
      {{ t('encryption.notSetUp') }}
    </DsCallout>
    <template v-if="usable">
      <DsCard :title="t('encryption.summary')">
        <dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-ui sm:grid-cols-2">
          <div>
            <dt class="text-small text-fg-muted">{{ t('connection.encryption.keyVault') }}</dt>
            <dd class="font-mono break-all">{{ summary.data.value?.keyVaultNamespace }}</dd>
          </div>
          <div>
            <dt class="text-small text-fg-muted">{{ t('connection.encryption.providers') }}</dt>
            <dd>{{ providers.map((p) => t(`connection.encryption.kms.${p}`)).join(', ') }}</dd>
          </div>
          <div>
            <dt class="text-small text-fg-muted">{{ t('connection.encryption.mode') }}</dt>
            <dd>{{ t(`connection.encryption.modes.${summary.data.value?.mode ?? 'auto'}`) }}</dd>
          </div>
          <div>
            <dt class="text-small text-fg-muted">{{ t('connection.encryption.library') }}</dt>
            <dd>
              {{ t(`connection.encryption.libraries.${summary.data.value?.library ?? 'cryptShared'}`) }}
            </dd>
          </div>
        </dl>
      </DsCard>

      <DsCard :title="t('encryption.keys.title')" :count="keys.data.value?.length">
        <template #actions>
          <DsButton
            size="sm"
            :icon="RotateCw"
            :disabled="readOnly || !keys.data.value?.length"
            @click="openRewrap"
          >
            {{ t('encryption.keys.rewrap') }}
          </DsButton>
          <DsButton size="sm" variant="primary" :icon="Plus" :disabled="readOnly" @click="openNewKey">
            {{ t('encryption.keys.new') }}
          </DsButton>
        </template>
        <form
          v-if="newKey.open"
          class="mb-4 flex flex-col gap-3 rounded-lg border border-border p-3"
          @submit.prevent="createKey.mutate()"
        >
          <MasterKeyFields v-model="newKey.masterKey" :providers="providers" />
          <DsInput
            v-model="newKey.altNames"
            :label="t('encryption.keys.altNamesInput')"
            :hint="t('encryption.keys.altNamesHint')"
            autocomplete="off"
          />
          <div class="flex justify-end gap-2">
            <DsButton variant="ghost" @click="newKey.open = false">{{ t('common.cancel') }}</DsButton>
            <DsButton type="submit" variant="primary" :icon="KeyRound" :loading="createKey.isPending.value">
              {{ t('encryption.keys.create') }}
            </DsButton>
          </div>
        </form>
        <form
          v-if="rewrap.open"
          class="mb-4 flex flex-col gap-3 rounded-lg border border-border p-3"
          @submit.prevent="confirmRewrap"
        >
          <p class="text-ui text-fg-muted">{{ t('encryption.keys.rewrapHint') }}</p>
          <MasterKeyFields v-model="rewrap.masterKey" :providers="providers" />
          <div class="flex justify-end gap-2">
            <DsButton variant="ghost" @click="rewrap.open = false">{{ t('common.cancel') }}</DsButton>
            <DsButton type="submit" variant="primary" :icon="RefreshCw" :loading="rewrapKeys.isPending.value">
              {{ t('encryption.keys.rewrap') }}
            </DsButton>
          </div>
        </form>
        <DsDataTable
          :label="t('encryption.keys.title')"
          :columns="columns"
          :rows="keys.data.value ?? []"
          :row-key="(k: DataKeyInfo) => k.id"
          :loading="keys.isPending.value"
          :loading-label="t('app.loading')"
          :error="keys.isError.value ? errorText(keys.error.value) : undefined"
          dense
        >
          <template #cell-id="{ row: k }">
            <span class="font-mono text-small break-all">{{ k.id }}</span>
          </template>
          <template #cell-altNames="{ row: k }">
            <span v-if="k.keyAltNamesHidden" class="text-fg-muted">{{
              t('encryption.keys.altNamesHidden', { n: k.keyAltNamesHidden }, k.keyAltNamesHidden)
            }}</span>
            <span v-else class="break-all">{{ k.keyAltNames.join(', ') || '—' }}</span>
          </template>
          <template #cell-provider="{ row: k }">{{ k.provider }}</template>
          <template #cell-updated="{ row: k }">
            <span class="text-fg-muted">{{ date(k.updatedAt) }}</span>
          </template>
          <template #retry>
            <DsButton size="sm" :icon="RotateCw" @click="keys.refetch()">{{ t('common.retry') }}</DsButton>
          </template>
          <template #empty>
            <DsEmptyState
              :icon="KeyRound"
              :title="t('encryption.keys.none')"
              :description="t('encryption.keys.noneHint')"
            />
          </template>
        </DsDataTable>
      </DsCard>

      <DsCard :title="t('encryption.collection.title')">
        <template #actions>
          <DsButton size="sm" variant="primary" :icon="Lock" :disabled="readOnly" @click="openCollection">
            {{ t('encryption.collection.new') }}
          </DsButton>
        </template>
        <p v-if="!collection.open" class="text-ui text-fg-muted">{{ t('encryption.collection.hint') }}</p>
        <form v-else class="flex flex-col gap-3" @submit.prevent="createCollection.mutate()">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <!-- User report 2026-10-30: the connection's databases offered; the collection is a new one. -->
            <NamespaceNameInput
              v-model="collection.db"
              kind="database"
              :connection-id="connectionId"
              :label="t('encryption.collection.db')"
              mono
            />
            <DsInput
              v-model="collection.name"
              :label="t('encryption.collection.name')"
              autocomplete="off"
              mono
            />
          </div>
          <MasterKeyFields v-model="collection.masterKey" :providers="providers" />
          <fieldset class="flex flex-col gap-2">
            <legend class="mb-1 text-small font-medium text-fg-muted">
              {{ t('encryption.collection.fields') }}
            </legend>
            <div
              v-for="(row, i) in collection.fields"
              :key="i"
              class="grid grid-cols-1 items-end gap-2 rounded-lg border border-border p-2 sm:grid-cols-[2fr_1fr_1fr_auto]"
            >
              <DsInput
                v-model="row.path"
                :label="t('encryption.collection.path')"
                placeholder="ssn"
                autocomplete="off"
                mono
              />
              <DsSelect
                v-model="row.bsonType"
                :label="t('encryption.collection.bsonType')"
                :options="bsonTypes"
              />
              <DsSelect
                v-model="row.query"
                :label="t('encryption.collection.query')"
                :options="queryOptions(row)"
              />
              <DsIconButton
                :icon="Trash2"
                :label="t('encryption.collection.removeField', { path: row.path || i + 1 })"
                :disabled="collection.fields.length === 1"
                @click="collection.fields.splice(i, 1)"
              />
              <div v-if="row.query === 'range'" class="grid grid-cols-2 gap-2 sm:col-span-4">
                <DsInput v-model="row.min" :label="t('encryption.collection.min')" inputmode="decimal" />
                <DsInput v-model="row.max" :label="t('encryption.collection.max')" inputmode="decimal" />
              </div>
            </div>
            <DsButton
              size="sm"
              variant="ghost"
              :icon="Plus"
              class="self-start"
              @click="collection.fields.push(newRow())"
            >
              {{ t('encryption.collection.addField') }}
            </DsButton>
          </fieldset>
          <p class="text-small text-fg-muted">{{ t('encryption.collection.keysNote') }}</p>
          <div class="flex justify-end gap-2">
            <DsButton variant="ghost" @click="collection.open = false">{{ t('common.cancel') }}</DsButton>
            <DsButton
              type="submit"
              variant="primary"
              :icon="Lock"
              :loading="createCollection.isPending.value"
            >
              {{ t('encryption.collection.create') }}
            </DsButton>
          </div>
        </form>
      </DsCard>
    </template>
  </section>
</template>
