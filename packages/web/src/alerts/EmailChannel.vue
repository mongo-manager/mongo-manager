<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { MailCheck, Save } from 'lucide-vue-next'
import type { AlertChannelsView, SmtpSettingsView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'

/**
 * W3.3: the e-mail channel — the SMTP server (TLS from the start, or STARTTLS; never in the clear),
 * its account (the password is sealed on the server and never shown again), who receives alerts,
 * and a test message.
 */
const props = defineProps<{ settings: SmtpSettingsView | null }>()
const { t } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()

const enabled = ref(false)
const host = ref('')
const port = ref('587')
const security = ref<'starttls' | 'tls'>('starttls')
const username = ref('')
const password = ref<string | null>(null)
const from = ref('')
const recipients = ref('')
/**
 * User report 2026-10-30: the switch says what is saved — off until mail is set up — and, once it is,
 * turns mail off or on by itself. Turned, it does not put back the other fields being edited.
 */
watch(
  () => props.settings?.enabled,
  (on) => (enabled.value = on ?? false),
  { immediate: true },
)
const savedFields = computed(() => {
  const { enabled: _enabled, ...rest } = props.settings ?? ({} as Partial<SmtpSettingsView>)
  void _enabled
  return props.settings ? JSON.stringify(rest) : null
})
watch(
  savedFields,
  () => {
    const s = props.settings
    host.value = s?.host ?? ''
    port.value = String(s?.port ?? 587)
    security.value = s?.security ?? 'starttls'
    username.value = s?.username ?? ''
    password.value = null
    from.value = s?.from ?? ''
    recipients.value = (s?.recipients ?? []).join('\n')
  },
  { immediate: true },
)
const securities = computed(() => [
  { value: 'starttls' as const, label: t('alerts.email.starttls') },
  { value: 'tls' as const, label: t('alerts.email.tls') },
])
watch(security, (s) => {
  if (s === 'tls' && port.value === '587') port.value = '465'
  if (s === 'starttls' && port.value === '465') port.value = '587'
})
const list = computed(() =>
  recipients.value
    .split(/[\s,;]+/)
    .map((r) => r.trim())
    .filter(Boolean),
)
const errors = ref<string[]>([])
const saving = ref(false)
const testing = ref(false)
/** W3 review (I3): the stored password belongs to the saved server and account only. */
const moved = computed(() => {
  const s = props.settings
  if (!s?.passwordSet) return false
  return (
    s.host.toLowerCase() !== host.value.trim().toLowerCase() ||
    s.port !== Number(port.value) ||
    s.security !== security.value ||
    (s.username ?? '') !== username.value.trim()
  )
})
/** M10: a test sends with what is saved; changes not saved yet are not what it tries. */
const unsaved = computed(() => {
  const s = props.settings
  if (!s) return false
  return (
    moved.value ||
    s.host !== host.value.trim() ||
    s.from !== from.value.trim() ||
    s.recipients.join(',') !== list.value.join(',') ||
    s.enabled !== enabled.value ||
    password.value !== null
  )
})

const blank = computed(
  () =>
    !host.value.trim() &&
    !username.value.trim() &&
    !password.value &&
    !from.value.trim() &&
    !list.value.length,
)
const switching = ref(false)
async function toggle(on: boolean): Promise<void> {
  enabled.value = on
  // Not set up yet: the switch is part of the form, saved with it.
  if (!props.settings) return
  errors.value = []
  switching.value = true
  try {
    const view = await alertsApi.setEmailEnabled(on)
    queryClient.setQueryData(alertKeys.channels, (old: AlertChannelsView | undefined) =>
      old ? { ...old, email: view } : old,
    )
    await queryClient.invalidateQueries({ queryKey: alertKeys.channels })
    toasts.push({ kind: 'success', message: t('alerts.email.saved') })
  } catch (e) {
    enabled.value = !on
    errors.value = [adminErrorText(e, t)]
  } finally {
    switching.value = false
  }
}

async function save(): Promise<boolean> {
  errors.value = []
  // Off and nothing typed: there is nothing to keep (and nothing is sent).
  if (!props.settings && !enabled.value && blank.value) return true
  if (!host.value.trim() || !from.value.trim() || !list.value.length)
    errors.value.push(t('alerts.email.required'))
  if (moved.value && !password.value) errors.value.push(t('alerts.email.passwordAgain'))
  if (errors.value.length) return false
  saving.value = true
  try {
    await alertsApi.setEmail({
      enabled: enabled.value,
      host: host.value.trim(),
      port: Number(port.value),
      security: security.value,
      ...(username.value.trim() ? { username: username.value.trim() } : {}),
      // null: keep the stored one; "": none any more; text: the new one.
      ...(password.value === null ? {} : { password: password.value || null }),
      from: from.value.trim(),
      recipients: list.value,
    })
    password.value = null
    await queryClient.invalidateQueries({ queryKey: alertKeys.channels })
    toasts.push({ kind: 'success', message: t('alerts.email.saved') })
    return true
  } catch (e) {
    errors.value = [adminErrorText(e, t)]
    return false
  } finally {
    saving.value = false
  }
}

async function test(): Promise<void> {
  testing.value = true
  try {
    const result = await alertsApi.testEmail()
    toasts.push(
      result.ok
        ? {
            kind: 'success',
            message: t('alerts.email.testOk', { to: props.settings?.recipients.join(', ') ?? '' }),
          }
        : {
            kind: 'error',
            message: t('alerts.email.testFailed', { why: t(`alerts.smtpErrors.${result.error ?? 'error'}`) }),
          },
    )
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <form class="flex flex-col gap-4" data-email-channel @submit.prevent="save">
    <DsFormErrors :messages="errors" />
    <DsSwitch
      :model-value="enabled"
      :disabled="switching || saving"
      :label="t('alerts.email.enabled')"
      :hint="t('alerts.email.enabledHint')"
      @update:model-value="toggle"
    />
    <div class="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <DsInput
        v-model="host"
        :label="t('alerts.email.host')"
        mono
        autocomplete="off"
        spellcheck="false"
        maxlength="253"
      />
      <DsInput v-model="port" :label="t('alerts.email.port')" inputmode="numeric" />
    </div>
    <DsSegmented v-model="security" :label="t('alerts.email.security')" :options="securities" />
    <p class="text-small text-fg-subtle">{{ t('alerts.email.securityHelp') }}</p>
    <div class="grid gap-3 sm:grid-cols-2">
      <DsInput v-model="username" :label="t('alerts.email.username')" autocomplete="off" spellcheck="false" />
      <DsSecretField
        v-model="password"
        :label="t('alerts.email.password')"
        :stored="settings?.passwordSet ?? false"
        :reenter="moved"
        autocomplete="new-password"
      />
    </div>
    <DsInput v-model="from" type="email" :label="t('alerts.email.from')" autocomplete="off" maxlength="254" />
    <DsTextarea
      v-model="recipients"
      :rows="3"
      :label="t('alerts.email.recipients')"
      :hint="t('alerts.email.recipientsHint')"
    />
    <div class="flex flex-wrap gap-2">
      <DsButton type="submit" variant="primary" size="sm" :icon="Save" :loading="saving">{{
        t('common.save')
      }}</DsButton>
      <DsButton size="sm" :icon="MailCheck" :loading="testing" :disabled="!settings" @click="test">{{
        t('alerts.email.test')
      }}</DsButton>
    </div>
    <p v-if="unsaved" class="text-small text-fg-subtle" data-test-uses-saved>
      {{ t('alerts.email.testUsesSaved') }}
    </p>
  </form>
</template>
