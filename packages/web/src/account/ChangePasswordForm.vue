<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import DsInput from '@/ds/DsInput.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsPasswordStrength from '@/ds/DsPasswordStrength.vue'
import { accountApi } from '@/api/account'
import { setCsrfToken } from '@/api/client'
import { useFormErrors } from '@/connections/formErrors'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'

const { t } = useI18n()
const session = useSessionStore()
const toasts = useToastStore()
const current = ref('')
const next = ref('')
const repeat = ref('')
const mismatch = ref(false)
const meterId = useId()
const { general, reset, showError } = useFormErrors({ flatten: true })

const { mutate: change, isPending } = useMutation({
  mutationFn: () => accountApi.changePassword(current.value, next.value),
  onMutate: reset,
  onSuccess: async ({ csrfToken }) => {
    // The server rotated the session: continue with the new token (Review Focus 3).
    setCsrfToken(csrfToken)
    await session.refresh()
    current.value = ''
    next.value = ''
    repeat.value = ''
    toasts.push({ kind: 'success', message: t('account.password.changed') })
  },
  onError: showError,
})

function submit(): void {
  mismatch.value = next.value !== repeat.value
  if (mismatch.value || isPending.value) return
  change()
}
</script>

<template>
  <form class="flex max-w-md flex-col gap-4" novalidate @submit.prevent="submit">
    <DsInput
      v-model="current"
      type="password"
      :label="t('account.password.current')"
      autocomplete="current-password"
      required
    />
    <div class="flex flex-col gap-1.5">
      <DsInput
        v-model="next"
        type="password"
        :label="t('account.password.new')"
        autocomplete="new-password"
        :describedby="meterId"
        required
      />
      <DsPasswordStrength :id="meterId" :password="next" :username="session.me?.user.username ?? ''" />
    </div>
    <DsInput
      v-model="repeat"
      type="password"
      :label="t('account.password.repeat')"
      :error="mismatch ? t('account.password.mismatch') : undefined"
      autocomplete="new-password"
      required
    />
    <DsFormErrors :messages="general" />
    <DsButton type="submit" variant="primary" class="self-start" :loading="isPending">{{
      t('account.password.submit')
    }}</DsButton>
  </form>
</template>
