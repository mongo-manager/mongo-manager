<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { KeyRound } from 'lucide-vue-next'
import AuthLayout from './AuthLayout.vue'
import DsInput from '@/ds/DsInput.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import { useSessionStore } from '@/stores/session'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import type { SecondFactorMethod } from '@/api/types'
import { passkeyErrorKey, passkeysAvailable } from '@/auth/passkeys'
import { safeNext } from '@/workspace/tabRoutes'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const session = useSessionStore()
const username = ref('')
const password = ref('')
const code = ref('')
const method = ref<SecondFactorMethod>('totp')
const error = ref('')
const busy = ref(false)

// Hide the passkey option where WebAuthn cannot work: insecure context or an IP address (Review Focus 3).
const passkeysSupported = passkeysAvailable()
const methods = computed(() =>
  (session.mfa?.methods ?? []).filter((m) => m !== 'passkey' || passkeysSupported),
)
const typedMethods = computed(() => methods.value.filter((m): m is 'totp' | 'recovery' => m !== 'passkey'))

const isExpired = (e: unknown) =>
  e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'mfa_ticket_expired'

async function run(
  action: () => Promise<void>,
  overrides: Partial<Record<string, string>>,
  clientError?: (e: unknown) => string,
): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    await action()
  } catch (e) {
    if (isExpired(e)) {
      session.resetMfa()
      code.value = ''
      error.value = t('login.expired')
    } else if (clientError && !(e instanceof ApiError)) {
      error.value = clientError(e)
    } else {
      error.value = describeError(e, t, overrides)
    }
  } finally {
    busy.value = false
  }
}

function submitPassword(): Promise<void> {
  return run(
    async () => {
      if ((await session.login(username.value.trim(), password.value)) === 'ok')
        await router.push(safeNext(route.query.next) ?? { name: 'workspace' })
      else method.value = typedMethods.value[0] ?? 'recovery'
    },
    { UNAUTHENTICATED: 'login.invalid' },
  )
}

function submitCode(): Promise<void> {
  return run(
    async () => {
      if (method.value === 'recovery') await session.verifyRecovery(code.value.trim())
      else await session.verifyTotp(code.value.trim())
      await router.push(safeNext(route.query.next) ?? { name: 'workspace' })
    },
    { UNAUTHENTICATED: 'login.invalidCode' },
  )
}

function usePasskey(): Promise<void> {
  return run(
    async () => {
      await session.verifyPasskey()
      await router.push(safeNext(route.query.next) ?? { name: 'workspace' })
    },
    { UNAUTHENTICATED: 'login.passkeyFailed' },
    (e) => t(passkeyErrorKey(e)),
  )
}

function startOver(): void {
  session.resetMfa()
  code.value = ''
  error.value = ''
}
</script>

<template>
  <AuthLayout v-if="!session.mfa" :title="t('login.title')">
    <form class="flex flex-col gap-4" @submit.prevent="submitPassword">
      <DsInput v-model="username" :label="t('login.username')" autocomplete="username" required />
      <DsInput
        v-model="password"
        :label="t('login.password')"
        type="password"
        autocomplete="current-password"
        required
      />
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
      <DsButton type="submit" variant="primary" :loading="busy">{{ t('login.submit') }}</DsButton>
    </form>
  </AuthLayout>

  <AuthLayout v-else :title="t('login.mfaTitle')" :subtitle="t('login.mfaSubtitle')">
    <div class="flex flex-col gap-4">
      <DsButton
        v-if="methods.includes('passkey')"
        data-test="use-passkey"
        variant="primary"
        :loading="busy"
        @click="usePasskey"
      >
        <KeyRound class="size-4" aria-hidden="true" />
        {{ t('login.usePasskey') }}
      </DsButton>
      <!-- UI redesign R5: the code's kind is one choice of two, a radio group (there is no tab panel). -->
      <DsSegmented
        v-if="typedMethods.length > 1"
        v-model="method"
        fill
        :label="t('login.methodLabel')"
        :options="
          typedMethods.map((m) => ({
            value: m,
            label: m === 'totp' ? t('login.methodTotp') : t('login.methodRecovery'),
          }))
        "
      />
      <form v-if="typedMethods.length > 0" class="flex flex-col gap-4" @submit.prevent="submitCode">
        <DsInput
          v-model="code"
          :label="method === 'totp' ? t('login.totpCode') : t('login.recoveryCode')"
          :inputmode="method === 'totp' ? 'numeric' : 'text'"
          autocomplete="one-time-code"
          mono
          required
        />
        <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
        <DsButton type="submit" variant="primary" :loading="busy">{{ t('login.verify') }}</DsButton>
      </form>
      <DsCallout v-else-if="error" tone="danger">{{ error }}</DsCallout>
      <DsButton variant="ghost" @click="startOver">{{ t('login.startOver') }}</DsButton>
    </div>
  </AuthLayout>
</template>
