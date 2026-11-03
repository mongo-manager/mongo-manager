<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import DsInput from '@/ds/DsInput.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import { useConnectionForm } from '../formContext'
import { isMasked } from '../formModel'

const { t } = useI18n()
const { form, errorFor, secretHint } = useConnectionForm()
</script>

<template>
  <DsCheckbox v-model="form.tls.enabled" :label="t('connection.tlsEnabled')" />
  <template v-if="form.tls.enabled">
    <DsTextarea
      v-model="form.tls.caPem"
      :label="t('connection.caPem')"
      :hint="t('connection.pemHint')"
      :error="errorFor('tls.caPem')"
      placeholder="-----BEGIN CERTIFICATE-----"
      mono
    />
    <DsTextarea
      v-model="form.tls.certificateKeyPem"
      :label="t('connection.certificateKeyPem')"
      :hint="secretHint(form.tls.certificateKeyPem) ?? t('connection.pemHint')"
      :select-on-focus="isMasked(form.tls.certificateKeyPem)"
      :error="errorFor('tls.certificateKeyPem')"
      mono
    />
    <DsInput
      v-model="form.tls.certificateKeyPassword"
      type="password"
      :label="t('connection.certificateKeyPassword')"
      :hint="secretHint(form.tls.certificateKeyPassword)"
      :select-on-focus="isMasked(form.tls.certificateKeyPassword)"
      :error="errorFor('tls.certificateKeyPassword')"
      autocomplete="new-password"
    />
    <DsCheckbox v-model="form.tls.allowInvalidHostnames" :label="t('connection.allowInvalidHostnames')" />
    <DsCheckbox
      v-model="form.tls.allowInvalidCertificates"
      :label="t('connection.allowInvalidCertificates')"
    />
    <p
      v-if="form.tls.allowInvalidHostnames || form.tls.allowInvalidCertificates"
      data-test="tls-insecure"
      role="alert"
      class="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-ui text-warning"
    >
      {{ t('connection.tlsInsecure') }}
    </p>
  </template>
</template>
