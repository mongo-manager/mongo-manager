<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import { accountApi } from '@/api/account'
import { STEP_UP_DECLINED, withStepUp } from './stepUp'
import { explainError } from '@/api/reasons'
import { useDialogStore } from '@/stores/dialogs'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import QrCode from './QrCode.vue'

const emit = defineEmits<{ recoveryCodes: [codes: string[]] }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const session = useSessionStore()
const toasts = useToastStore()

const enabled = computed(() => session.me?.twoFactor.totp ?? false)
const setup = ref<{ secret: string; uri: string } | null>(null)
const code = ref('')
const error = ref('')
const busy = ref(false)
const groupedSecret = computed(() => setup.value?.secret.replace(/(.{4})/g, '$1 ').trim() ?? '')

const explain = (e: unknown) => explainError(e, t)

const askPassword = (title: string) =>
  dialogs.prompt({
    title,
    message: t('security.passwordPrompt'),
    confirmLabel: t('common.continue'),
    input: { type: 'password', label: t('transfer.password') },
  })

async function start(): Promise<void> {
  const password = await askPassword(t('security.totp.title'))
  if (!password) return
  busy.value = true
  try {
    const result = await withStepUp(() => accountApi.totpEnroll(password))
    if (result === STEP_UP_DECLINED) return
    setup.value = { secret: result.secret, uri: result.otpauthUri }
    code.value = ''
    error.value = ''
  } catch (e) {
    toasts.push({ kind: 'error', message: explain(e) })
  } finally {
    busy.value = false
  }
}

async function confirm(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await accountApi.totpConfirm(code.value.trim())
    setup.value = null
    await session.refresh()
    toasts.push({ kind: 'success', message: t('security.totp.enabledToast') })
    if (result.recoveryCodes) emit('recoveryCodes', result.recoveryCodes)
  } catch (e) {
    error.value = explain(e)
  } finally {
    busy.value = false
  }
}

async function disable(): Promise<void> {
  const password = await askPassword(t('security.totp.disableTitle'))
  if (!password) return
  const current = await dialogs.prompt({
    title: t('security.totp.disableTitle'),
    message: t('security.totp.codePrompt'),
    confirmLabel: t('security.totp.disable'),
    danger: true,
    input: { type: 'text', label: t('security.totp.code') },
  })
  if (!current) return
  try {
    await accountApi.totpDisable(password, current.trim())
    await session.refresh()
    toasts.push({ kind: 'success', message: t('security.totp.disabledToast') })
  } catch (e) {
    toasts.push({ kind: 'error', message: explain(e) })
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p class="font-medium">{{ t('security.totp.title') }}</p>
        <p class="text-ui text-fg-subtle">
          {{ enabled ? t('security.totp.enabled') : t('security.totp.notEnabled') }}
        </p>
      </div>
      <DsButton v-if="enabled" size="sm" variant="danger" @click="disable">{{
        t('security.totp.disable')
      }}</DsButton>
      <DsButton v-else-if="!setup" size="sm" :loading="busy" @click="start">{{
        t('security.totp.setup')
      }}</DsButton>
    </div>
    <div v-if="setup" class="flex flex-wrap gap-6 rounded-lg border border-line p-4">
      <QrCode :value="setup.uri" :label="t('security.totp.qr')" />
      <form class="flex min-w-60 flex-1 flex-col gap-3" novalidate @submit.prevent="confirm">
        <p class="text-ui">{{ t('security.totp.scan') }}</p>
        <div>
          <p class="text-small text-fg-subtle">{{ t('security.totp.secret') }}</p>
          <p data-test="totp-secret" class="font-mono text-ui break-all select-all">{{ groupedSecret }}</p>
        </div>
        <DsInput
          v-model="code"
          :label="t('security.totp.code')"
          inputmode="numeric"
          autocomplete="one-time-code"
          :error="error || undefined"
          mono
        />
        <div class="flex gap-2">
          <DsButton type="submit" variant="primary" :loading="busy">{{
            t('security.totp.confirm')
          }}</DsButton>
          <DsButton @click="setup = null">{{ t('security.totp.cancel') }}</DsButton>
        </div>
      </form>
    </div>
  </div>
</template>
