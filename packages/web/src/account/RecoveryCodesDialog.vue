<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Clipboard, Download } from 'lucide-vue-next'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import { downloadText } from '@/download'
import { useToastStore } from '@/stores/toasts'

const props = defineProps<{ codes: string[] }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toasts = useToastStore()

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.codes.join('\n'))
    toasts.push({ kind: 'success', message: t('security.recovery.copied') })
  } catch {
    toasts.push({ kind: 'error', message: t('documents.copyFailed') })
  }
}
</script>

<template>
  <DsDialog open persistent :title="t('security.recovery.dialogTitle')" size="sm">
    <p class="text-ui text-fg-muted">{{ t('security.recovery.dialogIntro') }}</p>
    <ol data-test="recovery-codes" class="mt-4 grid grid-cols-2 gap-2 font-mono text-ui">
      <li v-for="code in codes" :key="code" class="rounded bg-muted px-2 py-1 text-center select-all">
        {{ code }}
      </li>
    </ol>
    <template #footer>
      <DsButton size="sm" @click="copy">
        <Clipboard class="size-4" aria-hidden="true" />
        {{ t('security.recovery.copy') }}
      </DsButton>
      <DsButton
        size="sm"
        class="mr-auto"
        @click="downloadText(codes.join('\n') + '\n', 'mongo-manager-recovery-codes.txt')"
      >
        <Download class="size-4" aria-hidden="true" />
        {{ t('security.recovery.download') }}
      </DsButton>
      <DsButton variant="primary" @click="emit('close')">{{ t('security.recovery.saved') }}</DsButton>
    </template>
  </DsDialog>
</template>
