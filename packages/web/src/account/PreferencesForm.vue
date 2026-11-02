<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsSelect from '@/ds/DsSelect.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import { LOCALES, LOCALE_NAMES, type Locale } from '@/i18n'
import { usePreferencesStore, type Theme } from '@/stores/preferences'
import AgentModeSetting from './AgentModeSetting.vue'

const { t } = useI18n()
const preferences = usePreferencesStore()

const themes = computed(() =>
  (['light', 'dark'] as const).map((v) => ({ value: v, label: t(`header.theme.${v}`) })),
)
const languages = LOCALES.map((v) => ({ value: v, label: LOCALE_NAMES[v] }))

const theme = computed({ get: () => preferences.theme, set: (v: Theme) => preferences.setTheme(v) })
const locale = computed({ get: () => preferences.locale, set: (v: Locale) => preferences.setLocale(v) })
// W5 (spec 3a-1 §10.6): the shell terminal's screen-reader mode, on by default.
const screenReader = computed({
  get: () => preferences.screenReader,
  set: (v: boolean) => preferences.setScreenReader(v),
})
</script>

<template>
  <div class="flex max-w-2xl flex-col gap-4">
    <div class="grid gap-4 sm:grid-cols-2">
      <DsSelect v-model="theme" :label="t('account.preferences.theme')" :options="themes" />
      <DsSelect v-model="locale" :label="t('account.preferences.language')" :options="languages" />
    </div>
    <DsSwitch
      v-model="screenReader"
      data-test="screen-reader"
      :label="t('account.preferences.screenReader')"
      :hint="t('account.preferences.screenReaderHint')"
    />
    <AgentModeSetting />
  </div>
</template>
