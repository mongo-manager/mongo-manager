<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Archive } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { accountKeys, auditApi } from '@/api/account'
import { explainError } from '@/api/reasons'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'

/**
 * Phase 4c §2: how long the audit log is kept — for ever by default; an administrator sets days, and
 * older entries are removed hourly (each removal itself logged).
 */
const { t, locale } = useI18n()
const session = useSessionStore()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const admin = computed(() => session.can('settings:manage'))
const retention = useQuery({ queryKey: accountKeys.auditSettings, queryFn: () => auditApi.settings() })
const choice = ref('')
watch(
  () => retention.data.value,
  (v) => (choice.value = v?.days ? String(v.days) : ''),
  { immediate: true },
)
const options = computed(() => [
  { value: '', label: t('audit.retention.forever') },
  ...[30, 90, 180, 365, 730].map((n) => ({ value: String(n), label: t('audit.retention.days', { n }) })),
])
const current = computed(() => {
  const r = retention.data.value
  if (!r?.days) return t('audit.retention.forever')
  // Fewer days wait a day before they take effect (4c review I4): said, with when.
  if (r.effectiveAt !== null && r.effectiveAt > Date.now())
    return t('audit.retention.pending', {
      n: r.days,
      date: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
        r.effectiveAt,
      ),
    })
  return t('audit.retention.days', { n: r.days })
})
const changed = computed(
  () => choice.value !== (retention.data.value?.days ? String(retention.data.value.days) : ''),
)
const saving = ref(false)
/**
 * 4c review I4: fewer days remove history — first how many entries go and that it waits a day, and
 * in team mode the administrator's password.
 */
async function save(): Promise<void> {
  const days = choice.value ? Number(choice.value) : null
  const now = retention.data.value?.days ?? null
  let password: string | undefined
  if (days !== null && (now === null || days < now)) {
    let count = 0
    try {
      count = (await auditApi.settings(days)).wouldRemove ?? 0
    } catch {
      // Not known: the confirmation says the rest.
    }
    const ask = {
      title: t('audit.retention.confirmTitle'),
      message: t('audit.retention.confirm', {
        count: new Intl.NumberFormat(locale.value).format(count),
        n: days,
      }),
      confirmLabel: t('audit.retention.confirmLabel'),
      danger: true,
    }
    if (session.status?.mode === 'team') {
      const given = await dialogs.prompt({
        ...ask,
        input: { type: 'password', label: t('users.password'), autocomplete: 'current-password' },
      })
      if (!given) return
      password = given
    } else if (!(await dialogs.confirm(ask))) return
  }
  saving.value = true
  try {
    // Security audit 2026-10-16: shortening it takes a second factor proved lately, when there is one.
    if ((await withStepUp(() => auditApi.saveSettings(days, password))) === STEP_UP_DECLINED) return
    // The log is read again too (4c review M4): entries may go.
    await queryClient.invalidateQueries({ queryKey: ['audit'] })
    toasts.push({ kind: 'success', message: t('audit.retention.saved') })
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    data-audit-retention
    class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
  >
    <header class="flex items-center gap-2.5">
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted"
        aria-hidden="true"
      >
        <Archive class="size-4" />
      </span>
      <div class="min-w-0">
        <h3 class="text-ui font-semibold text-fg">{{ t('audit.retention.title') }}</h3>
        <p class="text-small text-fg-subtle">{{ current }}</p>
      </div>
    </header>
    <form v-if="admin" class="flex flex-wrap items-end gap-2" @submit.prevent="save">
      <DsSelect
        v-model="choice"
        class="min-w-44 flex-1"
        :label="t('audit.retention.label')"
        :options="options"
      />
      <DsButton type="submit" :disabled="!changed" :loading="saving">{{
        t('audit.retention.save')
      }}</DsButton>
    </form>
    <p class="text-small text-fg-subtle">{{ t('audit.retention.hint') }}</p>
  </section>
</template>
