<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from 'lucide-vue-next'
import { summarize, typeOf } from './values'
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
// UI redesign R1: each BSON type has its value colour in both themes.
const tone = computed(() => {
  switch (type.value) {
    case 'string':
      return 'text-v-string'
    case 'int32':
    case 'double':
    case 'long':
    case 'decimal128':
      return 'text-v-number'
    case 'objectId':
      return 'text-v-oid'
    case 'date':
    case 'uuid':
      return 'text-v-date'
    case 'boolean':
      return 'text-v-boolean'
    case 'null':
    case 'undefined':
      return 'text-v-null'
    default:
      return 'text-fg-muted'
  }
})
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
