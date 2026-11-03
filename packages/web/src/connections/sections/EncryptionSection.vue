<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DsInput from '@/ds/DsInput.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsButton from '@/ds/DsButton.vue'
import { useDialogStore } from '@/stores/dialogs'
import { useConnectionForm } from '../formContext'
import { isMasked } from '../formModel'
import { unavailableKey, useConnectionCapabilities } from '../capabilities'

/**
 * W8 (completion): CSFLE / Queryable Encryption on this connection — the key providers (their
 * credentials sealed with the connection, never shown again), the key vault, how queries are
 * analysed, and the encrypted-field maps when the server's own collection options are not used.
 */
const { t } = useI18n()
const { form, errorFor, secretHint } = useConnectionForm()
const capabilities = useConnectionCapabilities()
const caps = computed(() => capabilities.data.value)
const e = form.encryption
const unavailable = computed(() => caps.value !== undefined && !caps.value.encryption.available)

const modes = computed(() => [
  { value: 'auto' as const, label: t('connection.encryption.modes.auto') },
  { value: 'decryptOnly' as const, label: t('connection.encryption.modes.decryptOnly') },
])
const libraries = computed(() => [
  { value: 'cryptShared' as const, label: t('connection.encryption.libraries.cryptShared') },
  { value: 'mongocryptd' as const, label: t('connection.encryption.libraries.mongocryptd') },
])
/**
 * A new 96-byte local key, made in this browser (it is sealed on the server once saved). Security
 * review I7: replacing a key already there (the stored one, masked) asks for the word typed — data
 * keys wrapped with the old one cannot be opened with the new one — and the new key is shown here
 * once, to copy or download, before anything is saved.
 */
const dialogs = useDialogStore()
const fresh = ref<string | null>(null)
async function generateLocalKey(): Promise<void> {
  if (e.local.key.trim()) {
    const word = t('connection.encryption.replaceKeyWord')
    const ok = await dialogs.confirm({
      title: t('connection.encryption.replaceKeyTitle'),
      message: t('connection.encryption.replaceKeyBody', { word }),
      confirmLabel: t('connection.encryption.replaceKey'),
      danger: true,
      requireText: word,
    })
    if (!ok) return
  }
  const bytes = crypto.getRandomValues(new Uint8Array(96))
  e.local.key = btoa(String.fromCharCode(...bytes))
  fresh.value = e.local.key
}
async function copyFresh(): Promise<void> {
  if (fresh.value) await navigator.clipboard?.writeText(fresh.value)
}
function downloadFresh(): void {
  if (!fresh.value) return
  const url = URL.createObjectURL(new Blob([`${fresh.value}\n`], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'mongo-manager-local-master-key.txt'
  a.click()
  // Re-review item 4: revoked once the browser has surely started the download, not at once.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
</script>

<template>
  <DsCallout v-if="unavailable" tone="warning" data-test="encryption-unavailable">
    {{
      t(unavailableKey(caps?.encryption.status), {
        feature: t('connection.encryption.feature'),
        pkg: 'mongodb-client-encryption',
      })
    }}
  </DsCallout>
  <DsCheckbox
    v-model="e.enabled"
    :label="t('connection.encryption.enabled')"
    :hint="t('connection.encryption.enabledHint')"
    :disabled="unavailable && !e.enabled"
  />
  <template v-if="e.enabled">
    <DsSegmented v-model="e.mode" :label="t('connection.encryption.mode')" :options="modes" />
    <p class="text-small text-fg-muted">{{ t(`connection.encryption.modeHints.${e.mode}`) }}</p>
    <DsInput
      v-model="e.keyVaultNamespace"
      :label="t('connection.encryption.keyVault')"
      placeholder="encryption.__keyVault"
      :error="errorFor('encryption.keyVaultNamespace')"
      autocomplete="off"
      mono
    />
    <fieldset class="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend class="px-1 text-small font-medium text-fg-muted">
        {{ t('connection.encryption.providers') }}
      </legend>
      <p v-if="errorFor('encryption.kms')" class="text-small text-danger">{{ errorFor('encryption.kms') }}</p>
      <DsCheckbox v-model="e.local.on" :label="t('connection.encryption.kms.local')" />
      <template v-if="e.local.on">
        <DsInput
          v-model="e.local.key"
          type="password"
          :label="t('connection.encryption.localKey')"
          :hint="secretHint(e.local.key) ?? t('connection.encryption.localKeyHint')"
          :select-on-focus="isMasked(e.local.key)"
          :error="errorFor('encryption.kms.local.key')"
          autocomplete="new-password"
          mono
        />
        <button
          type="button"
          class="self-start text-small text-accent-fg underline"
          data-test="generate-local-key"
          @click="generateLocalKey"
        >
          {{ t('connection.encryption.generateKey') }}
        </button>
        <DsCallout v-if="fresh && fresh === e.local.key" tone="warning" data-test="fresh-local-key">
          <p>{{ t('connection.encryption.freshKeyBody') }}</p>
          <code class="mt-1 block font-mono text-small break-all select-all">{{ fresh }}</code>
          <div class="mt-2 flex flex-wrap gap-2">
            <DsButton size="sm" data-test="copy-local-key" @click="copyFresh">{{
              t('connection.encryption.copyKey')
            }}</DsButton>
            <DsButton size="sm" data-test="download-local-key" @click="downloadFresh">{{
              t('connection.encryption.downloadKey')
            }}</DsButton>
          </div>
        </DsCallout>
      </template>
      <DsCheckbox v-model="e.aws.on" :label="t('connection.encryption.kms.aws')" />
      <template v-if="e.aws.on">
        <DsInput
          v-model="e.aws.accessKeyId"
          :label="t('connection.awsAccessKeyId')"
          :error="errorFor('encryption.kms.aws.accessKeyId')"
          autocomplete="off"
        />
        <DsInput
          v-model="e.aws.secretAccessKey"
          type="password"
          :label="t('connection.awsSecretAccessKey')"
          :hint="secretHint(e.aws.secretAccessKey)"
          :select-on-focus="isMasked(e.aws.secretAccessKey)"
          :error="errorFor('encryption.kms.aws.secretAccessKey')"
          autocomplete="new-password"
        />
        <DsInput
          v-model="e.aws.sessionToken"
          type="password"
          :label="t('connection.encryption.awsSessionToken')"
          :hint="secretHint(e.aws.sessionToken)"
          :select-on-focus="isMasked(e.aws.sessionToken)"
          autocomplete="new-password"
        />
      </template>
      <DsCheckbox v-model="e.azure.on" :label="t('connection.encryption.kms.azure')" />
      <template v-if="e.azure.on">
        <DsInput
          v-model="e.azure.tenantId"
          :label="t('connection.encryption.azureTenant')"
          autocomplete="off"
        />
        <DsInput
          v-model="e.azure.clientId"
          :label="t('connection.encryption.azureClient')"
          autocomplete="off"
        />
        <DsInput
          v-model="e.azure.clientSecret"
          type="password"
          :label="t('connection.encryption.azureSecret')"
          :hint="secretHint(e.azure.clientSecret)"
          :select-on-focus="isMasked(e.azure.clientSecret)"
          :error="errorFor('encryption.kms.azure.clientSecret')"
          autocomplete="new-password"
        />
        <DsInput
          v-model="e.azure.identityPlatformEndpoint"
          :label="t('connection.encryption.endpointOptional')"
          placeholder="login.microsoftonline.com"
          :error="errorFor('encryption.kms.azure.identityPlatformEndpoint')"
          autocomplete="off"
          mono
        />
      </template>
      <DsCheckbox v-model="e.gcp.on" :label="t('connection.encryption.kms.gcp')" />
      <template v-if="e.gcp.on">
        <DsInput v-model="e.gcp.email" :label="t('connection.encryption.gcpEmail')" autocomplete="off" />
        <DsTextarea
          v-model="e.gcp.privateKey"
          :label="t('connection.encryption.gcpKey')"
          :hint="secretHint(e.gcp.privateKey)"
          :select-on-focus="isMasked(e.gcp.privateKey)"
          :error="errorFor('encryption.kms.gcp.privateKey')"
          mono
        />
        <DsInput
          v-model="e.gcp.endpoint"
          :label="t('connection.encryption.endpointOptional')"
          placeholder="oauth2.googleapis.com"
          :error="errorFor('encryption.kms.gcp.endpoint')"
          autocomplete="off"
          mono
        />
      </template>
      <DsCheckbox v-model="e.kmip.on" :label="t('connection.encryption.kms.kmip')" />
      <template v-if="e.kmip.on">
        <DsInput
          v-model="e.kmip.endpoint"
          :label="t('connection.encryption.kmipEndpoint')"
          placeholder="kmip.example.com:5696"
          :error="errorFor('encryption.kms.kmip.endpoint')"
          autocomplete="off"
          mono
        />
        <DsTextarea
          v-model="e.kmip.caPem"
          :label="t('connection.caPem')"
          :hint="t('connection.pemHint')"
          mono
        />
        <DsTextarea
          v-model="e.kmip.certificateKeyPem"
          :label="t('connection.certificateKeyPem')"
          :hint="secretHint(e.kmip.certificateKeyPem) ?? t('connection.pemHint')"
          :select-on-focus="isMasked(e.kmip.certificateKeyPem)"
          mono
        />
      </template>
      <p class="text-small text-fg-muted">{{ t('connection.encryption.providersHint') }}</p>
    </fieldset>
    <DsSegmented v-model="e.library" :label="t('connection.encryption.library')" :options="libraries" />
    <template v-if="e.library === 'cryptShared'">
      <DsInput
        v-if="caps?.encryption.ownCryptSharedPath !== false"
        v-model="e.cryptSharedLibPath"
        :label="t('connection.encryption.cryptSharedPath')"
        :placeholder="
          caps?.encryption.serverCryptShared
            ? t('connection.encryption.serverLibrary')
            : '/opt/mongo_crypt_v1.so'
        "
        :hint="t('connection.encryption.cryptSharedHint')"
        :error="errorFor('encryption.cryptSharedLibPath')"
        autocomplete="off"
        mono
      />
      <DsCallout v-else :tone="caps?.encryption.serverCryptShared ? 'info' : 'warning'">
        {{
          caps?.encryption.serverCryptShared
            ? t('connection.encryption.teamLibrary')
            : t('connection.encryption.teamNoLibrary')
        }}
      </DsCallout>
    </template>
    <DsInput
      v-else
      v-model="e.mongocryptdUri"
      :label="t('connection.encryption.mongocryptdUri')"
      placeholder="mongodb://localhost:27020"
      :hint="t('connection.encryption.mongocryptdHint')"
      :error="errorFor('encryption.mongocryptdUri')"
      autocomplete="off"
      mono
    />
    <DsTextarea
      v-model="e.encryptedFieldsMap"
      :label="t('connection.encryption.encryptedFieldsMap')"
      :hint="t('connection.encryption.mapHint')"
      :error="errorFor('encryption.encryptedFieldsMap')"
      placeholder='{ "db.coll": { "fields": [ … ] } }'
      mono
    />
    <DsTextarea
      v-model="e.schemaMap"
      :label="t('connection.encryption.schemaMap')"
      :hint="t('connection.encryption.mapHint')"
      :error="errorFor('encryption.schemaMap')"
      placeholder='{ "db.coll": { "bsonType": "object", "properties": { … } } }'
      mono
    />
    <DsCallout tone="info">{{ t('connection.encryption.maskingNote') }}</DsCallout>
  </template>
</template>
