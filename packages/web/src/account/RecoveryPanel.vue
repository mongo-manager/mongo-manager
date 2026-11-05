<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsButton from '@/ds/DsButton.vue'
import { accountApi } from '@/api/account'
import { STEP_UP_DECLINED, withStepUp } from './stepUp'
import { explainError } from '@/api/reasons'
import { useDialogStore } from '@/stores/dialogs'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'

const emit = defineEmits<{ recoveryCodes: [codes: string[]] }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const session = useSessionStore()
const toasts = useToastStore()
const enabled = computed(() => session.me?.twoFactor.enabled ?? false)
const remaining = computed(() => session.me?.twoFactor.recoveryCodesRemaining ?? 0)

async function regenerate(): Promise<void> {
  const password = await dialogs.prompt({
    title: t('security.recovery.regenerate'),
    message: t('security.recovery.regenerateMessage'),
    confirmLabel: t('common.continue'),
    input: { type: 'password', label: t('transfer.password') },
  })
  if (!password) return
  try {
    const result = await withStepUp(() => accountApi.regenerateRecoveryCodes(password))
    if (result === STEP_UP_DECLINED) return
    await session.refresh()
    emit('recoveryCodes', result.recoveryCodes)
  } catch (e) {
    toasts.push({
      kind: 'error',
      message: explainError(e, t),
    })
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <p class="font-medium">{{ t('security.recovery.title') }}</p>
      <p class="text-ui text-fg-subtle">
        {{
          enabled
            ? t('security.recovery.remaining', { count: remaining }, remaining)
            : t('security.recovery.none')
        }}
      </p>
    </div>
    <DsButton v-if="enabled" size="sm" @click="regenerate">{{ t('security.recovery.regenerate') }}</DsButton>
  </div>
</template>
