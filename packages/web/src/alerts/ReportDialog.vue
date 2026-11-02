<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Plus, X } from 'lucide-vue-next'
import { MAX_REPORT_MEASURES, type ReportView } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import { ApiError } from '@/api/client'
import WhenStep from '@/schedules/WhenStep.vue'
import { cadenceOf, newDraft, type ScheduleDraft } from '@/schedules/useScheduleDraft'

/**
 * Design 2026-10-25 (C7): a scheduled report — its name, its connection, the counts it says (a label,
 * a collection, an optional filter as JSON), when (as a backup schedule's cadence and zone) and where
 * it is said (the bell, e-mail, webhooks). Numbers only: never a value.
 */
const props = defineProps<{ existing?: ReportView }>()
const emit = defineEmits<{ close: [] }>()
const { t, te } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()
const channels = useQuery({ queryKey: alertKeys.channels, queryFn: alertsApi.channels })
const connections = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })

interface Row {
  key: number
  label: string
  db: string
  coll: string
  filter: string
}
let seq = 0
const rowOf = (m?: ReportView['measures'][number]): Row => ({
  key: seq++,
  label: m?.label ?? '',
  db: m?.db ?? '',
  coll: m?.coll ?? '',
  filter: m?.filter ? JSON.stringify(m.filter) : '',
})
const name = ref(props.existing?.name ?? '')
const connectionId = ref(props.existing?.connectionId ?? '')
const rows = ref<Row[]>(props.existing ? props.existing.measures.map(rowOf) : [rowOf()])
/** The cadence as the schedule editor holds one (the rest of its draft is not used). */
const when = ref<ScheduleDraft>(draftOf(props.existing))
const inApp = ref(props.existing?.channels.inApp ?? true)
const email = ref(props.existing?.channels.email ?? false)
const webhooks = ref<string[]>([...(props.existing?.channels.webhooks ?? [])])
const errors = ref<string[]>([])
const saving = ref(false)

function draftOf(r?: ReportView): ScheduleDraft {
  const d = newDraft()
  d.times = ['09:00']
  d.weeklyTime = '09:00'
  d.monthlyTime = '09:00'
  d.expression = '0 9 * * *'
  if (!r) return d
  d.timeZone = r.timeZone
  const c = r.cadence
  d.kind = c.kind
  if (c.kind === 'hourly') {
    d.every = c.every
    d.minute = c.minute
  } else if (c.kind === 'daily') d.times = [...c.times]
  else if (c.kind === 'weekly') {
    d.days = [...c.days]
    d.weeklyTime = c.time
  } else if (c.kind === 'monthly') {
    d.monthDay = c.day
    d.monthlyTime = c.time
  } else d.expression = c.expression
  return d
}

const title = computed(() => (props.existing ? t('alerts.reports.editTitle') : t('alerts.reports.newTitle')))
const connectionOptions = computed(() => [
  ...(connectionId.value ? [] : [{ value: '', label: t('alerts.reports.pickConnection') }]),
  ...(connections.data.value ?? []).map((c) => ({ value: c.id, label: c.name })),
])
const smtpReady = computed(() => !!channels.data.value?.email?.enabled)
function toggleHook(id: string, on: boolean): void {
  webhooks.value = on ? [...webhooks.value, id] : webhooks.value.filter((w) => w !== id)
}
const addRow = () => rows.value.length < MAX_REPORT_MEASURES && rows.value.push(rowOf())
const removeRow = (key: number) => (rows.value = rows.value.filter((r) => r.key !== key))

async function save(): Promise<void> {
  errors.value = []
  if (!name.value.trim()) errors.value.push(t('alerts.reports.nameRequired'))
  if (!connectionId.value) errors.value.push(t('alerts.reports.connectionRequired'))
  const measures: Array<{ label: string; db: string; coll: string; filter?: Record<string, unknown> }> = []
  rows.value.forEach((r, i) => {
    const filter = r.filter.trim()
    let parsed: unknown
    if (filter) {
      try {
        parsed = JSON.parse(filter)
      } catch {
        parsed = undefined
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.value.push(t('alerts.reports.filterInvalid', { n: i + 1 }))
        return
      }
    }
    if (!r.label.trim() || !r.db.trim() || !r.coll.trim()) {
      errors.value.push(t('alerts.reports.measureIncomplete', { n: i + 1 }))
      return
    }
    // Review of C7a (M8): labels checked here, as the server checks them.
    if (['report', 'reportId'].includes(r.label.trim())) {
      errors.value.push(t('alerts.reports.labelReserved', { n: i + 1 }))
      return
    }
    if (measures.some((m) => m.label === r.label.trim())) {
      errors.value.push(t('alerts.reports.labelTwice', { n: i + 1 }))
      return
    }
    measures.push({
      label: r.label.trim(),
      db: r.db.trim(),
      coll: r.coll.trim(),
      ...(parsed ? { filter: parsed as Record<string, unknown> } : {}),
    })
  })
  if (errors.value.length || saving.value) return
  saving.value = true
  const body = {
    name: name.value.trim(),
    measures,
    cadence: cadenceOf(when.value),
    timeZone: when.value.timeZone,
    channels: { inApp: inApp.value, email: email.value, webhooks: webhooks.value },
  }
  try {
    if (props.existing) await alertsApi.patchReport(props.existing.id, body)
    else await alertsApi.createReport({ ...body, connectionId: connectionId.value, enabled: true })
    await queryClient.invalidateQueries({ queryKey: alertKeys.reports })
    toasts.push({ kind: 'success', message: t('alerts.reports.saved') })
    emit('close')
  } catch (e) {
    // The server's own check, said by its reason (and the count it is about).
    const d =
      e instanceof ApiError ? (e.details as { reason?: unknown; measure?: unknown } | undefined) : undefined
    const reason = typeof d?.reason === 'string' && te(`alerts.reports.reasons.${d.reason}`) ? d.reason : null
    errors.value = [
      reason
        ? typeof d?.measure === 'number'
          ? t('alerts.reports.refusedAt', { n: d.measure + 1, reason: t(`alerts.reports.reasons.${reason}`) })
          : t('alerts.reports.refused', { reason: t(`alerts.reports.reasons.${reason}`) })
        : adminErrorText(e, t),
    ]
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DsDialog open :title="title" size="lg" @close="emit('close')">
    <form class="flex flex-col gap-5" data-report-dialog @submit.prevent="save">
      <DsFormErrors :messages="errors" />
      <div class="grid gap-3 sm:grid-cols-2">
        <DsInput v-model="name" :label="t('alerts.reports.name')" maxlength="80" data-report-name />
        <DsSelect
          v-model="connectionId"
          :label="t('alerts.reports.connection')"
          :options="connectionOptions"
          :disabled="!!existing"
          data-report-connection
        />
      </div>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-small font-medium text-fg-muted">{{ t('alerts.reports.measures') }}</legend>
        <p class="-mt-1 text-small text-fg-subtle">{{ t('alerts.reports.measuresHint') }}</p>
        <div
          v-for="(r, i) in rows"
          :key="r.key"
          class="grid items-end gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[1fr_1fr_1fr_auto]"
          data-report-measure
        >
          <DsInput v-model="r.label" :label="t('alerts.reports.label', { n: i + 1 })" maxlength="60" />
          <!-- User report 2026-10-30: the connection's names offered (never a view: a count is of a collection). -->
          <NamespaceNameInput
            v-model="r.db"
            kind="database"
            :connection-id="connectionId"
            mono
            :label="t('alerts.reports.db', { n: i + 1 })"
          />
          <NamespaceNameInput
            v-model="r.coll"
            kind="collection"
            :connection-id="connectionId"
            :db="r.db"
            mono
            :label="t('alerts.reports.coll', { n: i + 1 })"
          />
          <DsIconButton
            :icon="X"
            :label="t('alerts.reports.removeMeasure', { n: i + 1 })"
            :disabled="rows.length === 1"
            @click="removeRow(r.key)"
          />
          <DsInput
            v-model="r.filter"
            mono
            class="sm:col-span-4"
            :label="t('alerts.reports.filter', { n: i + 1 })"
            placeholder='{"status": "shipping"}'
            :hint="t('alerts.reports.filterHint')"
          />
        </div>
        <div>
          <DsButton
            size="sm"
            :icon="Plus"
            :disabled="rows.length >= MAX_REPORT_MEASURES"
            data-report-add-measure
            @click="addRow"
            >{{ t('alerts.reports.addMeasure') }}</DsButton
          >
        </div>
      </fieldset>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-small font-medium text-fg-muted">{{ t('alerts.reports.when') }}</legend>
        <WhenStep v-model:draft="when" />
      </fieldset>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-small font-medium text-fg-muted">{{ t('alerts.rules.channels') }}</legend>
        <DsCheckbox
          v-model="inApp"
          :label="t('alerts.channels.inApp')"
          :hint="t('alerts.reports.inAppHint')"
        />
        <DsCheckbox
          v-model="email"
          :label="t('alerts.channels.email')"
          :disabled="!smtpReady && !email"
          :hint="
            smtpReady ? channels.data.value?.email?.recipients.join(', ') : t('alerts.channels.emailOff')
          "
        />
        <DsCheckbox
          v-for="w in channels.data.value?.webhooks ?? []"
          :key="w.id"
          :model-value="webhooks.includes(w.id)"
          :label="t('alerts.channels.webhook', { name: w.name })"
          :hint="w.enabled ? w.url : t('alerts.channels.webhookOff')"
          @update:model-value="toggleHook(w.id, $event)"
        />
      </fieldset>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="saving" data-save-report @click="save">{{
        t('common.save')
      }}</DsButton>
    </template>
  </DsDialog>
</template>
