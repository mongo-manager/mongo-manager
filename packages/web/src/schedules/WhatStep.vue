<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { BACKUP_SYSTEM_DATABASES } from '@mongo-manager/shared/browser'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import type { ScheduleDraft } from './useScheduleDraft'

/** Spec §1.2 "What": a connection the user may back up, the 3d-3a scope and its options. */
defineProps<{ locked?: boolean }>()
const draft = defineModel<ScheduleDraft>('draft', { required: true })
const { t } = useI18n()
const SCOPES = ['database', 'collection', 'server'] as const
const { data: connections } = useQuery({
  queryKey: queryKeys.connections,
  queryFn: () => connectionsApi.list(),
})
// As the dump route: export and jobs:run on the connection.
const eligible = computed(() =>
  (connections.value ?? []).filter((c) => c.export && c.permissions.includes('jobs:run')),
)
const connectionName = computed(
  () => (connections.value ?? []).find((c) => c.id === draft.value.connectionId)?.name ?? '',
)
const connectionOptions = computed(() => [
  { value: '', label: t('schedules.editor.what.pickConnection') },
  ...eligible.value.map((c) => ({ value: c.id, label: c.name })),
])
const dbs = useQuery({
  queryKey: computed(() => queryKeys.databases(draft.value.connectionId)),
  queryFn: () => connectionsApi.databases(draft.value.connectionId),
  enabled: computed(() => Boolean(draft.value.connectionId)),
})
const dbNames = computed(() =>
  (dbs.data.value?.databases ?? []).map((d) => d.name).filter((n) => !BACKUP_SYSTEM_DATABASES.includes(n)),
)
const colls = useQuery({
  queryKey: computed(() => queryKeys.collections(draft.value.connectionId, draft.value.db)),
  queryFn: () => connectionsApi.collections(draft.value.connectionId, draft.value.db),
  enabled: computed(() =>
    Boolean(draft.value.connectionId && draft.value.db && draft.value.scope !== 'server'),
  ),
})
const own = computed(() => (colls.data.value ?? []).filter((c) => !c.name.startsWith('system.')))
const dbOptions = computed(() => [
  { value: '', label: t('schedules.editor.what.pickDb') },
  ...dbNames.value.map((n) => ({ value: n, label: n })),
])
const collOptions = computed(() => [
  { value: '', label: t('schedules.editor.what.pickColl') },
  ...own.value.filter((c) => c.type !== 'view').map((c) => ({ value: c.name, label: c.name })),
])

const suggested = computed(() => {
  const d = draft.value
  const what =
    d.scope === 'server'
      ? connectionName.value
      : d.scope === 'collection'
        ? d.db && d.coll
          ? `${d.db}.${d.coll}`
          : ''
        : d.db
  return what ? t('schedules.editor.what.defaultName', { what }) : ''
})
// The name follows what is backed up until the user types one.
watch(
  suggested,
  (s) => {
    if (!draft.value.nameTouched) draft.value.name = s
  },
  { immediate: true },
)
function rename(value: string): void {
  draft.value.name = value
  draft.value.nameTouched = true
}
// Another connection or database starts its choices afresh.
watch(
  () => draft.value.connectionId,
  () => Object.assign(draft.value, { db: '', coll: '', collections: [], databases: [] }),
)
watch(
  () => draft.value.db,
  () => Object.assign(draft.value, { coll: '', collections: [] }),
)
function setScope(value: string): void {
  draft.value.scope = value as ScheduleDraft['scope']
}
/** An empty list means "all of them, including ones created later". */
function toggle(list: 'collections' | 'databases', name: string, on: boolean): void {
  const all = list === 'collections' ? own.value.map((c) => c.name) : dbNames.value
  const current = draft.value[list].length ? draft.value[list] : all
  const next = on ? [...new Set([...current, name])] : current.filter((x) => x !== name)
  draft.value[list] = next.length === all.length ? [] : next
}
const chosen = (list: 'collections' | 'databases', name: string) =>
  !draft.value[list].length || draft.value[list].includes(name)
const row = 'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-subtle cursor-pointer'
const chip = 'rounded-full bg-subtle px-1.5 text-xs text-fg-muted'
</script>

<template>
  <div class="flex flex-col gap-5">
    <DsInput
      :model-value="draft.name"
      :label="t('schedules.editor.what.name')"
      :maxlength="80"
      required
      @update:model-value="rename"
    />
    <DsSelect
      v-if="!locked"
      v-model="draft.connectionId"
      :label="t('schedules.editor.what.connection')"
      :options="connectionOptions"
    />
    <p v-else class="text-ui">
      <span class="text-fg-subtle">{{ t('schedules.editor.what.connection') }}:</span>
      <span class="font-medium text-fg">{{ connectionName }}</span>
    </p>

    <div
      v-if="draft.connectionId"
      class="grid gap-3 lg:grid-cols-3"
      role="radiogroup"
      :aria-label="t('schedules.editor.what.scope')"
    >
      <DsChoiceCard
        v-for="k in SCOPES"
        :key="k"
        :model-value="draft.scope"
        name="scope"
        :value="k"
        :title="t(`schedules.editor.what.${k}`)"
        :help="t(`schedules.editor.what.${k}Help`)"
        @update:model-value="setScope"
      />
    </div>

    <div v-if="draft.connectionId && draft.scope !== 'server'" class="grid gap-3 sm:grid-cols-2">
      <DsSelect v-model="draft.db" :label="t('schedules.editor.what.db')" :options="dbOptions" />
      <DsSelect
        v-if="draft.scope === 'collection'"
        v-model="draft.coll"
        :label="t('schedules.editor.what.coll')"
        :options="collOptions"
      />
    </div>

    <fieldset v-if="draft.scope === 'database' && draft.db && own.length" class="flex flex-col gap-2">
      <legend class="text-ui font-medium text-fg">
        {{ t('schedules.editor.what.collections') }}
      </legend>
      <p class="text-small text-fg-subtle">
        {{
          draft.collections.length
            ? t(
                'schedules.editor.what.someChosen',
                { count: draft.collections.length },
                draft.collections.length,
              )
            : t('schedules.editor.what.allCollections')
        }}
      </p>
      <ul class="grid max-h-64 gap-1 overflow-auto sm:grid-cols-2">
        <li v-for="c in own" :key="c.name">
          <label :class="row">
            <input
              type="checkbox"
              class="size-4 accent-accent"
              :checked="chosen('collections', c.name)"
              @change="toggle('collections', c.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="truncate font-mono">{{ c.name }}</span>
            <span v-if="c.type === 'view'" :class="chip">{{ t('schedules.editor.what.view') }}</span>
          </label>
        </li>
      </ul>
    </fieldset>

    <fieldset
      v-if="draft.connectionId && draft.scope === 'server' && dbNames.length"
      class="flex flex-col gap-2"
    >
      <legend class="text-ui font-medium text-fg">
        {{ t('schedules.editor.what.databases') }}
      </legend>
      <p v-if="!draft.databases.length" class="text-small text-fg-subtle">
        {{ t('schedules.editor.what.allDatabases') }}
      </p>
      <ul class="grid gap-1 sm:grid-cols-3">
        <li v-for="d in dbNames" :key="d">
          <label :class="row">
            <input
              type="checkbox"
              class="size-4 accent-accent"
              :checked="chosen('databases', d)"
              @change="toggle('databases', d, ($event.target as HTMLInputElement).checked)"
            />
            <span class="font-mono">{{ d }}</span>
          </label>
        </li>
      </ul>
    </fieldset>

    <fieldset class="flex flex-col gap-1">
      <legend class="mb-1 text-ui font-medium text-fg">
        {{ t('schedules.editor.what.content') }}
      </legend>
      <label :class="row"
        ><input v-model="draft.indexes" type="checkbox" class="size-4 accent-accent" />{{
          t('schedules.editor.what.indexes')
        }}</label
      >
      <label :class="row"
        ><input v-model="draft.options" type="checkbox" class="size-4 accent-accent" />{{
          t('schedules.editor.what.options')
        }}</label
      >
      <label :class="[row, 'items-start']">
        <input
          v-model="draft.anonymous"
          type="checkbox"
          class="mt-0.5 size-4 accent-accent"
          :aria-describedby="'anon-help'"
        />
        <span>{{ t('schedules.editor.what.anonymous') }}</span>
      </label>
      <p id="anon-help" class="ml-8 text-small text-fg-subtle">
        {{ t('schedules.editor.what.anonymousHelp') }}
      </p>
    </fieldset>
  </div>
</template>
