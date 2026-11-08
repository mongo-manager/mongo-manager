<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref, useId } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AuthLayout from './AuthLayout.vue'
import DsInput from '@/ds/DsInput.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsPasswordStrength from '@/ds/DsPasswordStrength.vue'
import { useSessionStore } from '@/stores/session'
import { explainError } from '@/api/reasons'

const { t } = useI18n()
const router = useRouter()
const session = useSessionStore()
const token = ref('')
const username = ref('')
const password = ref('')
const repeat = ref('')
const error = ref('')
const busy = ref(false)
const meterId = useId()

async function submit(): Promise<void> {
  error.value = ''
  if (password.value !== repeat.value) {
    error.value = t('setup.mismatch')
    return
  }
  busy.value = true
  try {
    await session.setup(token.value.trim(), username.value.trim(), password.value)
    await router.push({ name: 'workspace' })
  } catch (e) {
    error.value = explainError(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthLayout :title="t('setup.title')" :subtitle="t('setup.subtitle')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <DsInput v-model="token" :label="t('setup.token')" mono autocomplete="off" required />
      <DsInput v-model="username" :label="t('setup.username')" autocomplete="username" required />
      <div class="flex flex-col gap-1.5">
        <DsInput
          v-model="password"
          :label="t('setup.password')"
          type="password"
          autocomplete="new-password"
          :describedby="meterId"
          required
        />
        <DsPasswordStrength :id="meterId" :password="password" :username="username.trim()" />
      </div>
      <DsInput
        v-model="repeat"
        :label="t('setup.passwordConfirm')"
        type="password"
        autocomplete="new-password"
        required
      />
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
      <DsButton type="submit" variant="primary" :loading="busy">{{ t('setup.submit') }}</DsButton>
    </form>
  </AuthLayout>
</template>
