<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { cspImageSource, type PluginAdminView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsDialog from '@/ds/DsDialog.vue'
import DsInput from '@/ds/DsInput.vue'
import { localized } from '@/plugins/store'

/**
 * Phase 4b §2: a plugin's settings, as its manifest declares them; a tile server is one https
 * address — plain http only for this computer (security audit 2026-10-16, M1).
 */
const props = defineProps<{ plugin: PluginAdminView | null }>()
/** The tile template's own placeholders, shown as written (a message's braces are its parameters). */
const TILE_PLACEHOLDERS = { s: '{s}', z: '{z}', x: '{x}', y: '{y}' }
const emit = defineEmits<{ close: []; save: [values: Record<string, string | boolean>] }>()
const { t, locale } = useI18n()
const declared = computed(() => Object.entries(props.plugin?.manifest?.settings ?? {}))
const values = reactive<Record<string, string | boolean>>({})
watch(
  () => props.plugin,
  (p) => {
    for (const key of Object.keys(values)) delete values[key]
    for (const [key, s] of Object.entries(p?.manifest?.settings ?? {}))
      values[key] = p?.settings[key] ?? (s.type === 'boolean' ? false : '')
  },
  { immediate: true },
)
const errorOf = (key: string, type: string) =>
  type === 'url' && typeof values[key] === 'string' && values[key] && !cspImageSource(values[key] as string)
    ? t('plugins.badUrl')
    : undefined
const valid = computed(() => declared.value.every(([key, s]) => !errorOf(key, s.type)))
function submit(): void {
  if (valid.value) emit('save', { ...values })
}
</script>

<template>
  <DsDialog
    :open="!!plugin"
    :title="
      t('plugins.settingsTitle', { name: plugin?.manifest ? localized(plugin.manifest.name, locale) : '' })
    "
    @close="emit('close')"
  >
    <p class="mb-4 text-small text-fg-muted">{{ t('plugins.settingsPublic') }}</p>
    <form id="plugin-settings" class="flex flex-col gap-4" @submit.prevent="submit">
      <template v-for="[key, s] in declared" :key="key">
        <label v-if="s.type === 'boolean'" class="flex items-center gap-2 text-ui text-fg">
          <input v-model="values[key]" type="checkbox" class="size-4 accent-[var(--color-accent)]" />
          {{ localized(s.title, locale) }}
        </label>
        <DsInput
          v-else
          :model-value="String(values[key] ?? '')"
          :label="localized(s.title, locale)"
          :type="s.type === 'url' ? 'url' : 'text'"
          :mono="s.type === 'url'"
          :hint="s.type === 'url' ? t('plugins.urlHint', TILE_PLACEHOLDERS) : undefined"
          :error="errorOf(key, s.type)"
          @update:model-value="values[key] = $event"
        />
      </template>
    </form>
    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :disabled="!valid" @click="submit">{{ t('plugins.save') }}</DsButton>
    </template>
  </DsDialog>
</template>
