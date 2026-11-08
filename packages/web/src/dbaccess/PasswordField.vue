<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Eye, EyeOff, Wand2 } from 'lucide-vue-next'
import { MIN_DB_PASSWORD } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import { useToastStore } from '@/stores/toasts'
import { generatePassword, passwordStrength } from './password'

/**
 * W3.1: a MongoDB user's password — typed by the administrator, or generated here (in the browser,
 * from the system's random source) and shown so it can be copied. It lives in this form only: it is
 * sent once with the save and never kept by the app (nor in the browser's storage).
 */
const props = defineProps<{ label: string; maxlength?: number }>()
const model = defineModel<string>({ required: true })
const { t } = useI18n()
const toasts = useToastStore()
const shown = ref(false)
const strength = computed(() => (model.value ? passwordStrength(model.value) : null))
const hint = computed(() =>
  strength.value
    ? t(`dbAccess.password.strength.${strength.value}`, { min: MIN_DB_PASSWORD })
    : t('dbAccess.password.hint', { min: MIN_DB_PASSWORD }),
)

function generate(): void {
  model.value = generatePassword()
  // Shown, so it can be read and copied before it is saved: nowhere else will show it again.
  shown.value = true
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(model.value)
    toasts.push({ kind: 'success', message: t('dbAccess.password.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('dbAccess.password.copyFailed') })
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-end gap-2">
      <DsInput
        v-model="model"
        class="min-w-0 flex-1"
        :label="props.label"
        :type="shown ? 'text' : 'password'"
        mono
        autocomplete="new-password"
        spellcheck="false"
        :maxlength="props.maxlength"
        :hint="hint"
        data-db-password
      />
      <DsIconButton
        :label="shown ? t('dbAccess.password.hide') : t('dbAccess.password.show')"
        :icon="shown ? EyeOff : Eye"
        :aria-pressed="shown"
        class="mb-6"
        @click="shown = !shown"
      />
    </div>
    <div class="flex flex-wrap gap-2">
      <DsButton size="sm" :icon="Wand2" @click="generate">{{ t('dbAccess.password.generate') }}</DsButton>
      <DsButton size="sm" variant="ghost" :icon="Copy" :disabled="!model" @click="copy">{{
        t('dbAccess.password.copy')
      }}</DsButton>
    </div>
  </div>
</template>
