<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Keyboard } from 'lucide-vue-next'
import type { RebindableAction } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsKbd from '@/ds/DsKbd.vue'
import DsButton from '@/ds/DsButton.vue'
import { useShortcutsStore } from '@/stores/shortcuts'
import { useTabsStore } from '@/stores/tabs'
import { SHORTCUT_GROUPS, keyLabel, type Shortcut } from './shortcuts'
import { openAccountTab } from './openTabs'

/**
 * UI redesign R1 spec §3: every shortcut, grouped, in two columns. W5: with the keys this user bound
 * (marked changed), and a way to the Shortcuts settings.
 */
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const shortcuts = useShortcutsStore()
const tabs = useTabsStore()
const keysOf = (item: Shortcut) =>
  item.rebindable ? shortcuts.keysOf(item.action as RebindableAction) : item.keys
const changed = (item: Shortcut) =>
  !!item.rebindable && shortcuts.bindings[item.action as RebindableAction] !== undefined
function customize(): void {
  emit('close')
  openAccountTab(tabs)
}
</script>

<template>
  <DsDialog open :title="t('shortcuts.title')" size="lg" @close="emit('close')">
    <div class="columns-1 gap-8 sm:columns-2">
      <section v-for="group in SHORTCUT_GROUPS" :key="group.id" class="mb-6 break-inside-avoid">
        <h3 class="mb-2 text-small font-semibold text-fg-muted">{{ t(`shortcuts.groups.${group.id}`) }}</h3>
        <dl class="flex flex-col">
          <div
            v-for="item in group.items"
            :key="item.action"
            class="flex items-start justify-between gap-3 border-b border-line py-1.5 text-ui last:border-0"
          >
            <dt class="text-fg-muted">
              {{ t(`shortcuts.actions.${item.action}`) }}
              <span v-if="changed(item)" class="ml-1 text-caption text-accent-fg">{{
                t('shortcuts.changed')
              }}</span>
            </dt>
            <dd class="flex shrink-0 flex-wrap justify-end gap-1.5">
              <span v-for="(combo, i) in keysOf(item)" :key="i" class="flex items-center gap-0.5">
                <DsKbd v-for="key in combo" :key="key">{{ keyLabel(key) }}</DsKbd>
              </span>
            </dd>
          </div>
        </dl>
      </section>
    </div>
    <template #footer>
      <DsButton :icon="Keyboard" @click="customize">{{ t('shortcuts.customize') }}</DsButton>
    </template>
  </DsDialog>
</template>
