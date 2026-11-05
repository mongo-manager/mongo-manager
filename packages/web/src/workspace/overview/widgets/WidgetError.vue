<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RotateCw } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'

/** A widget's own error, with Retry (spec §Errors; final review 3, 4). */
defineProps<{ text: string; retry?: () => void }>()
const { t } = useI18n()
</script>

<template>
  <!-- UI redesign R3 leftovers: a widget's error is the kit's callout, its Retry inside it. -->
  <DsCallout tone="danger">
    {{ text }}
    <template v-if="retry" #action>
      <DsButton
        size="sm"
        variant="secondary"
        :icon="RotateCw"
        data-widget-retry
        class="pointer-coarse:h-11"
        @click="retry()"
      >
        {{ t('common.retry') }}
      </DsButton>
    </template>
  </DsCallout>
</template>
