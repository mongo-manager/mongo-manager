<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Moon, Sun } from 'lucide-vue-next'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSwatch from '@/ds/DsSwatch.vue'
import { LOCALES, LOCALE_NAMES, type Locale } from '@/i18n'
import { ACCENTS, usePreferencesStore, type Accent, type Theme } from '@/stores/preferences'
import DsSelect from '@/ds/DsSelect.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { alertKeys, alertsApi } from '@/api/alerts'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'

/**
 * UI redesign R1 revision 2 §3.1: theme, accent and language, in the sidebar's footer (the density
 * choice went in the user review of 2026-10-30: it changed little and said less).
 */
const { t } = useI18n()
const preferences = usePreferencesStore()
const themes = computed(() => [
  { value: 'light' as Theme, label: t('layout.light'), icon: Sun },
  { value: 'dark' as Theme, label: t('layout.dark'), icon: Moon },
])
const accents = computed(() => ACCENTS.map((a) => ({ value: a as Accent, label: t(`accents.${a}`) })))
const theme = computed({ get: () => preferences.theme, set: (v: Theme) => preferences.setTheme(v) })
const accent = computed({ get: () => preferences.accent, set: (v: Accent) => preferences.setAccent(v) })
// W3.3: whether the bell shows alerts to this user (their own choice; off until turned on).
const queryClient = useQueryClient()
const optIn = useQuery({ queryKey: alertKeys.optIn, queryFn: alertsApi.optIn, retry: false })
const toasts = useToastStore()
async function setAlerts(on: boolean): Promise<void> {
  try {
    await alertsApi.setOptIn(on)
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    await queryClient.invalidateQueries({ queryKey: alertKeys.optIn })
    await queryClient.invalidateQueries({ queryKey: alertKeys.active })
  }
}
</script>

<template>
  <div class="flex w-72 flex-col gap-4 p-2">
    <p class="text-ui font-semibold text-fg">{{ t('layout.preferences') }}</p>
    <div class="flex flex-col gap-1.5">
      <span class="text-small font-medium text-fg-muted">{{ t('account.preferences.theme') }}</span>
      <DsSegmented v-model="theme" :label="t('account.preferences.theme')" :options="themes" />
    </div>
    <div class="flex flex-col gap-1.5">
      <span class="text-small font-medium text-fg-muted">{{ t('layout.accent') }}</span>
      <DsSwatch v-model="accent" :label="t('layout.accent')" :options="accents" />
    </div>
    <DsSelect
      data-test="language"
      :label="t('account.preferences.language')"
      :model-value="preferences.locale"
      :options="LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))"
      @update:model-value="preferences.setLocale($event as Locale)"
    />
    <DsSwitch
      v-if="optIn.data.value?.available"
      data-test="alerts-opt-in"
      :model-value="optIn.data.value.inApp"
      :label="t('alerts.mine.inApp')"
      :hint="t('alerts.mine.inAppShort')"
      @update:model-value="setAlerts"
    />
  </div>
</template>
