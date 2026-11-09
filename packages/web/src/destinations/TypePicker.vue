<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { DESTINATION_TYPES, type DestinationType } from '@mongo-manager/shared/browser'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
/** Phase 3d-3b D2 (W4.5: and the new kinds): the kinds of destination; a saved one's kind never changes. */
defineProps<{ disabled?: boolean }>()
const model = defineModel<DestinationType>({ required: true })
const { t } = useI18n()
</script>

<template>
  <div class="grid gap-3 md:grid-cols-2" role="radiogroup" :aria-label="t('destinations.editor.steps.type')">
    <DsChoiceCard
      v-for="x in DESTINATION_TYPES"
      :key="x"
      v-model="model"
      name="type"
      :value="x"
      :title="t(`destinations.type.${x}`)"
      :help="t(`destinations.type.${x}Help`)"
      :disabled="disabled && model !== x"
    />
  </div>
</template>
