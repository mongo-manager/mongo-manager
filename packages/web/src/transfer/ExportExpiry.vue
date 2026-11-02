<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock } from 'lucide-vue-next'
import { formatRelative } from '@/format'

/**
 * W4.2 (phase 3d-1 spec §9): until when an export's file can be downloaded — the server deletes it
 * at its expiry (MM_TRANSFER_TTL_HOURS), and then the export has to run again.
 */
const props = defineProps<{ expiresAt: number }>()
const { t, locale } = useI18n()
const expired = computed(() => props.expiresAt <= Date.now())
const when = computed(() => new Date(props.expiresAt).toLocaleString(locale.value))
const rel = computed(() => formatRelative(props.expiresAt - Date.now(), locale.value))
const iso = computed(() => new Date(props.expiresAt).toISOString())
defineExpose({ expired })
</script>

<template>
  <p
    class="inline-flex items-center gap-1 text-small"
    :class="expired ? 'text-warning' : 'text-fg-subtle'"
    data-test="export-expiry"
  >
    <Clock class="size-3.5 shrink-0" aria-hidden="true" />
    <template v-if="expired">{{ t('dataTransfer.expiry.expired') }}</template>
    <time v-else :datetime="iso">{{ t('dataTransfer.expiry.until', { when, rel }) }}</time>
  </p>
</template>
