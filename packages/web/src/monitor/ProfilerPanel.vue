<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Gauge, Pencil, RotateCw } from 'lucide-vue-next'
import { serverApi, serverKeys, type ProfilerChange, type ProfilerDatabase } from '@/api/server'
import { describeError } from '@/api/errors'
import { reasonMessage } from '@/api/reasons'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsDialog from '@/ds/DsDialog.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import type { DsColumn } from '@/ds/table'
/**
 * Phase 3b spec §3.1: the profiler of each database. Everyone who monitors sees it; a connection
 * admin changes it (not on a read-only connection). Level 2 is confirmed first: it goes back by
 * itself after 30 minutes. UI redesign R3 §4: a card with a data table; a change is a short dialog
 * on the kit (the level as a segmented control).
 */
const props = defineProps<{ connectionId: string; canOperate: boolean; readOnly: boolean }>()
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const formId = useId()
const status = useQuery({
  queryKey: serverKeys.profiler(props.connectionId),
  queryFn: () => serverApi.profiler(props.connectionId),
  refetchInterval: 30_000,
  retry: false,
})
type Level = '0' | '1' | '2'
const editing = ref<string | null>(null)
// The fields speak text; numbers are made of them on save (as v-model.number did).
const form = ref<{ level: Level; slowms: string; sampleRate: string }>({
  level: '0',
  slowms: '100',
  sampleRate: '1',
})
const saving = ref(false)
const when = (iso: string) => new Date(iso).toLocaleString(locale.value)
const levels = computed(() =>
  (['0', '1', '2'] as const).map((value) => ({ value, label: t(`profiler.levels.${value}`) })),
)
const canChange = computed(() => props.canOperate && !props.readOnly)
/** Review of the Monitoring redesign (minor): the refused databases named together, by the role asked. */
const refused = computed(() => {
  const byRole = new Map<string, string[]>()
  for (const db of status.data.value?.databases ?? [])
    if (db.refused) byRole.set(db.refused, [...(byRole.get(db.refused) ?? []), db.name])
  return [...byRole].map(([role, names]) => ({ role, dbs: names.join(', ') }))
})
// Review of the Monitoring redesign (I-1): on a narrow card the least needed columns leave first.
const columns = computed<DsColumn[]>(() => [
  { key: 'name', label: t('profiler.db'), mono: true, width: '28%' },
  { key: 'level', label: t('profiler.level') },
  { key: 'slowms', label: t('profiler.slowms'), align: 'right', width: '7rem' },
  { key: 'sampleRate', label: t('profiler.sampleRate'), align: 'right', width: '9rem', hideBelow: 560 },
])
/** Shown where there is no value (a database the profiler could not be read on). */
const NONE = '—'
const LEVEL_TONES = { 0: 'neutral', 1: 'info', 2: 'warning' } as const

function edit(db: ProfilerDatabase): void {
  editing.value = db.name
  form.value = {
    level: String(db.level ?? 0) as Level,
    slowms: String(db.slowms ?? 100),
    sampleRate: String(db.sampleRate ?? 1),
  }
}

async function save(): Promise<void> {
  const db = editing.value
  if (!db) return
  const level = Number(form.value.level) as 0 | 1 | 2
  const change: ProfilerChange = {
    level,
    slowms: Number(form.value.slowms),
    sampleRate: Number(form.value.sampleRate),
  }
  if (level === 2) {
    const ok = await dialogs.confirm({
      title: t('profiler.level2Title'),
      message: t('profiler.level2Warning', { db }),
      confirmLabel: t('profiler.level2Confirm'),
      danger: true,
    })
    if (!ok) return
    change.confirm = true
  }
  saving.value = true
  try {
    await serverApi.setProfiler(props.connectionId, db, change)
    editing.value = null
    toasts.push({ kind: 'success', message: t('profiler.saved', { db }) })
    await queryClient.invalidateQueries({ queryKey: serverKeys.profiler(props.connectionId) })
  } catch (e) {
    // Seventh review of the open's stop (minor 3): a refusal with words of its own (level 1 instead);
    // anything else as before, in the reader's language (eighth review, nit 4).
    toasts.push({ kind: 'error', message: reasonMessage(e, t) ?? describeError(e, t) })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DsCard :title="t('profiler.title')" :count="status.data.value?.databases.length" data-profiler>
    <div class="flex flex-col gap-3">
      <p v-if="status.data.value" class="text-small text-fg-subtle">
        {{
          status.data.value.scope === 'mongos'
            ? t('profiler.mongos')
            : t('profiler.scope', { member: status.data.value.member ?? '' })
        }}
      </p>
      <DsCallout v-if="refused.length" tone="warning" data-profiler-refused>
        <p v-for="r in refused" :key="r.role">{{ t('profiler.refused', { dbs: r.dbs, role: r.role }) }}</p>
      </DsCallout>
      <DsDataTable
        :label="t('profiler.title')"
        :columns="columns"
        :rows="status.data.value?.databases ?? []"
        :row-key="(db: ProfilerDatabase) => db.name"
        :loading="status.isPending.value"
        :loading-label="t('app.loading')"
        :error="status.isError.value ? describeError(status.error.value, t) : undefined"
        :actions-label="t('profiler.actions')"
      >
        <template #cell-name="{ row: db }">
          <span :title="db.name">{{ db.name }}</span>
        </template>
        <template #cell-level="{ row: db }">
          <DsBadge v-if="db.refused" tone="warning">{{ t('profiler.noAccess') }}</DsBadge>
          <span v-else class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1">
            <DsBadge :tone="LEVEL_TONES[db.level ?? 0]">{{ t(`profiler.levels.${db.level ?? 0}`) }}</DsBadge>
            <span
              v-if="db.revertAt"
              class="min-w-0 truncate text-small text-warning"
              :data-profiler-revert="db.name"
              :title="
                db.revertFailed
                  ? t('profiler.revertPending')
                  : t('profiler.revertAt', { at: when(db.revertAt) })
              "
            >
              {{
                db.revertFailed
                  ? t('profiler.revertPending')
                  : t('profiler.revertAt', { at: when(db.revertAt) })
              }}
            </span>
          </span>
        </template>
        <template #cell-slowms="{ row: db }">
          <span class="font-mono text-[12.5px] text-fg-muted">{{ db.refused ? NONE : db.slowms }}</span>
        </template>
        <template #cell-sampleRate="{ row: db }">
          <span class="font-mono text-[12.5px] text-fg-muted">{{ db.refused ? NONE : db.sampleRate }}</span>
        </template>
        <template v-if="canChange" #actions="{ row: db }">
          <DsIconButton
            v-if="!db.refused"
            size="sm"
            :icon="Pencil"
            :label="t('profiler.changeOf', { db: db.name })"
            :data-profiler-edit="db.name"
            @click="edit(db)"
          />
        </template>
        <template #retry>
          <DsButton size="sm" :icon="RotateCw" @click="status.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
        <template #empty>
          <DsEmptyState :icon="Gauge" :title="t('profiler.noDatabases')" />
        </template>
      </DsDataTable>
    </div>
    <DsDialog
      :open="editing !== null"
      :title="t('profiler.editing', { db: editing ?? '' })"
      :description="t('profiler.processWide')"
      @close="editing = null"
    >
      <form :id="formId" class="flex flex-col gap-4" data-profiler-form @submit.prevent="save">
        <div class="flex flex-col gap-1.5">
          <span class="text-small font-medium text-fg-muted">{{ t('profiler.level') }}</span>
          <DsSegmented v-model="form.level" fill :label="t('profiler.level')" :options="levels" />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <DsInput
            v-model="form.slowms"
            type="number"
            min="0"
            max="3600000"
            step="1"
            inputmode="numeric"
            :label="t('profiler.slowms')"
            :hint="t('profiler.slowmsHint')"
            data-profiler-slowms
          />
          <DsInput
            v-model="form.sampleRate"
            type="number"
            min="0"
            max="1"
            step="0.01"
            inputmode="decimal"
            :label="t('profiler.sampleRate')"
            :hint="t('profiler.sampleRateHint')"
            data-profiler-rate
          />
        </div>
      </form>
      <template #footer>
        <DsButton variant="ghost" @click="editing = null">{{ t('profiler.cancel') }}</DsButton>
        <DsButton type="submit" variant="primary" :form="formId" :loading="saving" data-profiler-save>
          {{ t('profiler.save') }}
        </DsButton>
      </template>
    </DsDialog>
  </DsCard>
</template>
