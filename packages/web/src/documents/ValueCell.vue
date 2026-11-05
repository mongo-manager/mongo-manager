<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from 'lucide-vue-next'
import { summarize, typeOf } from './values'
import { valueTone } from './valueTone'
import { useMaskedPath } from '@/masking/useMaskedPaths'

const props = defineProps<{
  value: unknown
  present: boolean
  path?: readonly string[]
  /** Strings in quotes, as the shell writes them (cards and the inspector). */
  quoted?: boolean
}>()
const { t } = useI18n()
const isMasked = useMaskedPath()
/** Phase 3c §7: "***" where the server hides a personal value, told apart from a real "***" text. */
const masked = computed(
  () => props.present && props.value === '***' && !!props.path && isMasked.value(props.path),
)
const summary = computed(() => (props.present ? summarize(props.value) : null))
const type = computed(() => (props.present ? typeOf(props.value) : null))
const scalar = computed(() => {
  const text = summary.value?.kind === 'scalar' ? summary.value.text : ''
  return props.quoted && type.value === 'string' ? JSON.stringify(text) : text
})
const tone = computed(() => valueTone(type.value))
</script>

<template>
  <span
    v-if="masked"
    data-masked
    class="inline-flex items-center gap-1 text-fg-subtle"
    :title="t('masking.hiddenValue')"
  >
    <Lock class="size-3" aria-hidden="true" />{{ t('masking.hidden') }}
  </span>
  <span v-else-if="summary?.kind === 'array'" class="text-fg-subtle">{{
    t('documents.arrayItems', { count: summary.count }, summary.count)
  }}</span>
  <span v-else-if="summary?.kind === 'object'" class="text-fg-subtle">{{
    t('documents.objectFields', { count: summary.count }, summary.count)
  }}</span>
  <span v-else-if="summary" :class="tone">{{ scalar }}</span>
</template>
