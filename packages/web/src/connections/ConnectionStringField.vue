<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import DsInput from '@/ds/DsInput.vue'
import { useConnectionForm } from './formContext'

/**
 * The connection string, the form's first field (user report 2026-10-16); its reading lives in the
 * dialog (connectionString.ts). The line under it is a status always in place, so what was read is
 * announced; a refusal is the field's own error (review M4).
 */
const { t } = useI18n()
const { connectionString: cs } = useConnectionForm()
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <DsInput
      v-model="cs.text.value"
      :label="t('connection.uri')"
      :hint="t('connection.uriHint')"
      :error="cs.error.value || undefined"
      placeholder="localhost:27017"
      autocomplete="off"
      spellcheck="false"
      mono
      data-connection-field="uri"
      @input="cs.onInput"
      @paste="cs.onPaste"
      @blur="cs.onLeave"
      @keydown.enter="cs.onEnter"
    />
    <p
      data-uri-status
      role="status"
      class="text-small break-words text-success empty:hidden"
      v-text="cs.read.value"
    />
  </div>
</template>
