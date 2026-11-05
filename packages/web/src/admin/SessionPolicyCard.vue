<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Timer } from 'lucide-vue-next'
import { SESSION_IDLE_CHOICES, type SessionIdleMinutes } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { accountKeys, usersApi } from '@/api/account'
import { explainError } from '@/api/reasons'
import { ApiError } from '@/api/client'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'

/**
 * Session lifetime (2026-10-29): how long a session lasts without activity, chosen by an
 * administrator; every session ends 12 hours after its sign-in whatever is chosen. A longer time keeps
 * a forgotten or stolen session usable longer, so it asks for the administrator's password (and a
 * second factor used lately). A server without the setting (404) shows no card; any other failure
 * to read it is said on the card (review of 2026-10-29, minor 4).
 */
const { t } = useI18n()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()
const policy = useQuery({
  queryKey: accountKeys.sessionPolicy,
  queryFn: usersApi.sessionPolicy,
  retry: false,
})
const choice = ref('')
watch(
  () => policy.data.value,
  (v) => (choice.value = v ? String(v.idleMinutes) : ''),
  { immediate: true },
)
const span = (minutes: number) =>
  minutes < 60
    ? t('users.session.minutes', { n: minutes }, minutes)
    : t('users.session.hours', { n: minutes / 60 }, minutes / 60)
const options = computed(() => SESSION_IDLE_CHOICES.map((m) => ({ value: String(m), label: span(m) })))
const current = computed(() => {
  const p = policy.data.value
  return p ? t('users.session.current', { idle: span(p.idleMinutes), absolute: span(p.absoluteMinutes) }) : ''
})
/** An older server has no such route: nothing to show. */
const unknown = computed(() => policy.error.value instanceof ApiError && policy.error.value.status === 404)
const changed = computed(() => !!policy.data.value && choice.value !== String(policy.data.value.idleMinutes))
const saving = ref(false)

async function save(): Promise<void> {
  const now = policy.data.value
  if (!now) return
  const minutes = Number(choice.value) as SessionIdleMinutes
  let password: string | undefined
  if (minutes > now.idleMinutes) {
    const given = await dialogs.prompt({
      title: t('users.session.longerTitle'),
      message: t('users.session.longerMessage', { idle: span(minutes) }),
      confirmLabel: t('users.session.longerConfirm'),
      danger: true,
      input: { type: 'password', label: t('users.password'), autocomplete: 'current-password' },
    })
    if (!given) return
    password = given
  }
  saving.value = true
  try {
    if ((await withStepUp(() => usersApi.setSessionPolicy(minutes, password))) === STEP_UP_DECLINED) return
    await queryClient.invalidateQueries({ queryKey: accountKeys.sessionPolicy })
    toasts.push({ kind: 'success', message: t('users.session.saved', { idle: span(minutes) }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
    // Review (minor 3): another administrator may have changed it — read again, so the next try asks
    // for the password when it must.
    await queryClient.invalidateQueries({ queryKey: accountKeys.sessionPolicy })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    v-if="policy.data.value || (policy.isError.value && !unknown)"
    data-session-policy
    class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
  >
    <header class="flex items-center gap-2.5">
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted"
        aria-hidden="true"
      >
        <Timer class="size-4" />
      </span>
      <div class="min-w-0">
        <h3 class="text-ui font-semibold text-fg">{{ t('users.session.title') }}</h3>
        <p class="text-small text-fg-subtle">{{ current }}</p>
      </div>
    </header>
    <p
      v-if="!policy.data.value"
      data-session-policy-error
      class="rounded-lg bg-subtle px-3 py-2 text-small text-fg-muted"
    >
      {{ explainError(policy.error.value, t) }}
    </p>
    <form v-else class="flex flex-wrap items-end gap-2" @submit.prevent="save">
      <DsSelect
        v-model="choice"
        class="min-w-44 flex-1"
        :label="t('users.session.label')"
        :options="options"
        :disabled="saving"
      />
      <DsButton type="submit" :disabled="!changed" :loading="saving">{{ t('users.session.save') }}</DsButton>
    </form>
    <p class="text-small text-fg-subtle">{{ t('users.session.hint') }}</p>
  </section>
</template>
