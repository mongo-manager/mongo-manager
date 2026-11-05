<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AUTH_MECHANISMS, KERBEROS_CANONICALIZE, OIDC_ENVIRONMENTS } from '@mongo-manager/shared/browser'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import { useConnectionForm } from '../formContext'
import { isMasked } from '../formModel'
import { unavailableKey, useConnectionCapabilities } from '../capabilities'

const { t } = useI18n()
const { form, errorFor, secretHint } = useConnectionForm()
const capabilities = useConnectionCapabilities()
const caps = computed(() => capabilities.data.value)

const mechanisms = computed(() =>
  AUTH_MECHANISMS.map((m) => ({
    value: m,
    label:
      m === 'none' ? t('connection.mechanismNone') : m === 'DEFAULT' ? t('connection.mechanismDefault') : m,
  })),
)
const needsPassword = computed(() => !['none', 'MONGODB-X509', 'MONGODB-OIDC'].includes(form.auth.mechanism))
const hasProperties = computed(() => form.auth.mechanism === 'MONGODB-AWS')
// MONGODB-AWS signs in with the connection's own access key, never the server's AWS identity.
const aws = computed(() => form.auth.mechanism === 'MONGODB-AWS')
// W7: OIDC signs each person in through their identity provider (no password here).
const oidc = computed(() => form.auth.mechanism === 'MONGODB-OIDC')
/**
 * Security review I3: the token resource is the audience this server's own cloud identity mints a
 * token for, sent to the connection's hosts. A pasted connection string fills it; it is used only
 * once confirmed here, for the value as it stands (editing it clears the tick).
 */
const tokenResourceConfirmed = computed({
  get: () =>
    form.auth.oidc.tokenResource.trim() !== '' &&
    form.auth.oidc.tokenResourceConfirmed.trim() === form.auth.oidc.tokenResource.trim(),
  set: (on: boolean) => {
    form.auth.oidc.tokenResourceConfirmed = on ? form.auth.oidc.tokenResource.trim() : ''
  },
})
/** W7 re-review: the workload identity itself is confirmed the same way (for its environment). */
const environmentConfirmed = computed({
  get: () =>
    form.auth.oidc.environment !== '' && form.auth.oidc.environmentConfirmed === form.auth.oidc.environment,
  set: (on: boolean) => {
    form.auth.oidc.environmentConfirmed = on ? form.auth.oidc.environment : ''
  },
})
const hostList = computed(() =>
  form.hosts
    .map((h) => h.host.trim())
    .filter(Boolean)
    .join(', '),
)
// W8: Kerberos signs in with the ticket of the account the Mongo Manager server runs as.
const kerberos = computed(() => form.auth.mechanism === 'GSSAPI')
const kerberosUnavailable = computed(() => kerberos.value && caps.value && !caps.value.kerberos.available)
const kerberosRefused = computed(
  () => kerberos.value && caps.value?.kerberos.available && !caps.value.kerberos.allowed,
)

const environments = computed(() => [
  { value: '' as const, label: t('connection.oidc.environmentNone') },
  ...OIDC_ENVIRONMENTS.map((e) => ({ value: e, label: t(`connection.oidc.environments.${e}`) })),
])
const canonicalize = computed(() => [
  { value: '' as const, label: t('connection.kerberos.canonicalizeDefault') },
  ...KERBEROS_CANONICALIZE.map((c) => ({ value: c, label: t(`connection.kerberos.canonicalize.${c}`) })),
])
</script>

<template>
  <DsSelect
    v-model="form.auth.mechanism"
    :label="t('connection.mechanism')"
    :options="mechanisms"
    :error="errorFor('auth.mechanism')"
  />
  <template v-if="form.auth.mechanism !== 'none'">
    <DsCallout v-if="kerberosUnavailable" tone="warning" data-test="kerberos-unavailable">
      {{ t(unavailableKey(caps?.kerberos.status), { feature: 'Kerberos (GSSAPI)', pkg: 'kerberos' }) }}
    </DsCallout>
    <DsCallout v-else-if="kerberosRefused" tone="danger" data-test="kerberos-refused">
      {{ t('connection.kerberos.teamRefused') }}
    </DsCallout>
    <DsCallout v-else-if="kerberos" tone="warning" data-test="kerberos-warning">
      {{ t('connection.kerberos.warning') }}
    </DsCallout>
    <DsInput
      v-model="form.auth.username"
      :label="
        aws
          ? t('connection.awsAccessKeyId')
          : oidc
            ? t('connection.oidc.username')
            : kerberos
              ? t('connection.kerberos.principal')
              : t('connection.username')
      "
      :hint="aws ? t('connection.awsKeysHint') : oidc ? t('connection.oidc.usernameHint') : undefined"
      :error="errorFor('auth.username')"
      autocomplete="off"
    />
    <DsInput
      v-if="needsPassword"
      v-model="form.auth.password"
      type="password"
      :label="aws ? t('connection.awsSecretAccessKey') : t('connection.password')"
      :hint="secretHint(form.auth.password) ?? (kerberos ? t('connection.kerberos.passwordHint') : undefined)"
      :select-on-focus="isMasked(form.auth.password)"
      :error="errorFor('auth.password')"
      autocomplete="new-password"
    />
    <DsInput
      v-if="!oidc"
      v-model="form.auth.authSource"
      :label="t('connection.authSource')"
      :placeholder="kerberos ? '$external' : 'admin'"
      :error="errorFor('auth.authSource')"
      autocomplete="off"
    />
    <DsInput
      v-if="hasProperties"
      v-model="form.auth.mechanismProperties"
      :label="t('connection.mechanismProperties')"
      :hint="aws ? t('connection.awsPropertiesHint') : t('connection.mechanismPropertiesHint')"
      :error="errorFor('auth.mechanismProperties')"
      autocomplete="off"
      mono
    />
    <template v-if="kerberos">
      <DsInput
        v-model="form.auth.kerberos.serviceName"
        :label="t('connection.kerberos.serviceName')"
        placeholder="mongodb"
        :error="errorFor('auth.kerberos.serviceName')"
        autocomplete="off"
      />
      <DsInput
        v-model="form.auth.kerberos.serviceRealm"
        :label="t('connection.kerberos.serviceRealm')"
        :error="errorFor('auth.kerberos.serviceRealm')"
        autocomplete="off"
      />
      <DsSelect
        v-model="form.auth.kerberos.canonicalizeHostName"
        :label="t('connection.kerberos.canonicalizeLabel')"
        :options="canonicalize"
        :error="errorFor('auth.kerberos.canonicalizeHostName')"
      />
      <!-- Security review Minor 10: whoever answers reverse DNS picks the service ticket's host. -->
      <DsCallout
        v-if="form.auth.kerberos.canonicalizeHostName === 'forwardAndReverse'"
        tone="warning"
        data-test="kerberos-reverse-dns"
      >
        {{ t('connection.kerberos.reverseDnsWarning') }}
      </DsCallout>
    </template>
    <template v-if="oidc">
      <DsCallout tone="info" data-test="oidc-info">{{ t('connection.oidc.info') }}</DsCallout>
      <DsInput
        v-model="form.auth.oidc.redirectUri"
        :label="t('connection.oidc.redirectUri')"
        :placeholder="caps?.oidc.redirectUri"
        :hint="t('connection.oidc.redirectUriHint')"
        :error="errorFor('auth.oidc.redirectUri')"
        autocomplete="off"
        mono
      />
      <DsInput
        v-if="!form.auth.oidc.environment"
        v-model="form.auth.oidc.expectedIssuer"
        :label="t('connection.oidc.expectedIssuer')"
        placeholder="https://login.example.com"
        :hint="t('connection.oidc.expectedIssuerHint')"
        :error="errorFor('auth.oidc.expectedIssuer')"
        autocomplete="off"
        mono
      />
      <DsInput
        v-model="form.auth.oidc.allowedHosts"
        :label="t('connection.oidc.allowedHosts')"
        placeholder="*.mongodb.net, localhost"
        :hint="t('connection.oidc.allowedHostsHint')"
        :error="errorFor('auth.oidc.allowedHosts')"
        autocomplete="off"
        mono
      />
      <DsSelect
        v-model="form.auth.oidc.environment"
        :label="t('connection.oidc.environment')"
        :options="environments"
        :disabled="caps !== undefined && !caps.oidc.workloadIdentity && !form.auth.oidc.environment"
        :hint="caps && !caps.oidc.workloadIdentity ? t('connection.oidc.environmentTeamRefused') : undefined"
        :error="errorFor('auth.oidc.environment')"
      />
      <template v-if="form.auth.oidc.environment">
        <DsCallout tone="warning" data-test="oidc-workload-warning">
          {{ t('connection.oidc.environmentWarning') }}
        </DsCallout>
        <DsCheckbox
          v-model="environmentConfirmed"
          data-test="oidc-environment-confirm"
          :label="
            t('connection.oidc.environmentConfirm', {
              environment: form.auth.oidc.environment,
              hosts: hostList,
            })
          "
        />
        <DsInput
          v-model="form.auth.oidc.tokenResource"
          :label="t('connection.oidc.tokenResource')"
          :error="errorFor('auth.oidc.tokenResource')"
          autocomplete="off"
          mono
        />
        <DsCheckbox
          v-if="form.auth.oidc.tokenResource.trim()"
          v-model="tokenResourceConfirmed"
          data-test="oidc-token-resource-confirm"
          :label="
            t('connection.oidc.tokenResourceConfirm', {
              resource: form.auth.oidc.tokenResource.trim(),
              hosts: hostList,
            })
          "
        />
      </template>
    </template>
  </template>
</template>
