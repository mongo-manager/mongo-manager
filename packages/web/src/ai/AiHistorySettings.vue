<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { History, RotateCw } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsField from '@/ds/DsField.vue'
import { aiHistoryApi, aiHistoryKeys } from '@/api/aiHistory'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * User review 2026-10-09 ("Kayıtlar 90 gün tutulsun, ayarlardan değiştirilebilir olsun"): how long
 * the AI history keeps each request, and whether it keeps what was asked and answered.
 */
const { t } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()
const current = useQuery({ queryKey: aiHistoryKeys.settings, queryFn: aiHistoryApi.settings })
const days = ref('')
const keepContent = ref(true)
watch(
  () => current.data.value,
  (s) => {
    if (!s) return
    days.value = String(s.days)
    keepContent.value = s.keepContent
  },
  { immediate: true },
)
const n = computed(() => Number(days.value))
const daysError = computed(() =>
  Number.isInteger(n.value) && n.value >= 1 && n.value <= 3650 ? null : t('aiHistory.settings.daysInvalid'),
)
const changed = computed(
  () =>
    !!current.data.value &&
    (n.value !== current.data.value.days || keepContent.value !== current.data.value.keepContent),
)
const saving = ref(false)
async function save(): Promise<void> {
  if (daysError.value || !changed.value || saving.value) return
  saving.value = true
  try {
    const saved = await aiHistoryApi.saveSettings({ days: n.value, keepContent: keepContent.value })
    queryClient.setQueryData(aiHistoryKeys.settings, saved)
    await queryClient.invalidateQueries({ queryKey: aiHistoryKeys.all })
    toasts.push({ kind: 'success', message: t('aiHistory.settings.saved') })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section
    data-ai-history-settings
    aria-labelledby="ai-history-settings"
    class="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-xs"
  >
    <header class="flex items-start gap-3">
      <span
        class="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
        aria-hidden="true"
      >
        <History class="size-5" />
      </span>
      <div class="min-w-0">
        <h3 id="ai-history-settings" class="text-title-s font-semibold text-fg">
          {{ t('aiHistory.settings.title') }}
        </h3>
        <p class="max-w-3xl text-ui text-fg-muted">{{ t('aiHistory.settings.intro') }}</p>
      </div>
    </header>
    <DsCallout v-if="current.isError.value" tone="danger">
      {{ describeError(current.error.value, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="current.refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <form v-else class="grid max-w-3xl gap-x-5 gap-y-4 sm:grid-cols-[12rem_1fr]" @submit.prevent="save">
      <DsField
        v-model="days"
        :label="t('aiHistory.settings.days')"
        :error="days !== '' ? daysError : null"
        type="number"
        inputmode="numeric"
      />
      <DsCheckbox
        v-model="keepContent"
        class="self-end"
        :label="t('aiHistory.settings.keepContent')"
        :hint="t('aiHistory.settings.keepContentHint')"
      />
      <div class="sm:col-span-2">
        <DsButton
          variant="primary"
          size="sm"
          :loading="saving"
          :disabled="!!daysError || !changed"
          @click="save"
        >
          {{ t('aiHistory.settings.save') }}
        </DsButton>
      </div>
    </form>
  </section>
</template>
