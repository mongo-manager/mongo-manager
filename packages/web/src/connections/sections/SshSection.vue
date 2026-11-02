<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import DsInput from '@/ds/DsInput.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import { useConnectionForm } from '../formContext'
import { isMasked } from '../formModel'

const { t } = useI18n()
const { form, errorFor, secretHint } = useConnectionForm()
</script>

<template>
  <DsCheckbox v-model="form.ssh.enabled" :label="t('connection.sshEnabled')" />
  <p v-if="errorFor('ssh')" role="alert" class="text-small text-danger">{{ errorFor('ssh') }}</p>
  <template v-if="form.ssh.enabled">
    <div class="flex items-start gap-2">
      <DsInput
        v-model="form.ssh.host"
        class="flex-1"
        :label="t('connection.sshHost')"
        :error="errorFor('ssh.host')"
        autocomplete="off"
        mono
      />
      <DsInput
        v-model="form.ssh.port"
        class="w-28"
        :label="t('connection.sshPort')"
        :error="errorFor('ssh.port')"
        inputmode="numeric"
        autocomplete="off"
      />
    </div>
    <DsInput
      v-model="form.ssh.username"
      :label="t('connection.sshUsername')"
      :error="errorFor('ssh.username')"
      autocomplete="off"
    />
    <DsSelect
      v-model="form.ssh.method"
      :label="t('connection.sshMethod')"
      :options="[
        { value: 'password', label: t('connection.sshMethodPassword') },
        { value: 'privateKey', label: t('connection.sshMethodKey') },
      ]"
    />
    <DsInput
      v-if="form.ssh.method === 'password'"
      v-model="form.ssh.password"
      type="password"
      :label="t('connection.sshPassword')"
      :hint="secretHint(form.ssh.password)"
      :select-on-focus="isMasked(form.ssh.password)"
      :error="errorFor('ssh.password')"
      autocomplete="new-password"
    />
    <template v-else>
      <DsTextarea
        v-model="form.ssh.privateKey"
        :label="t('connection.sshPrivateKey')"
        :hint="secretHint(form.ssh.privateKey)"
        :select-on-focus="isMasked(form.ssh.privateKey)"
        :error="errorFor('ssh.privateKey')"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        mono
      />
      <DsInput
        v-model="form.ssh.passphrase"
        type="password"
        :label="t('connection.sshPassphrase')"
        :hint="secretHint(form.ssh.passphrase)"
        :select-on-focus="isMasked(form.ssh.passphrase)"
        :error="errorFor('ssh.passphrase')"
        autocomplete="new-password"
      />
    </template>
    <DsInput
      v-model="form.ssh.hostFingerprint"
      :label="t('connection.sshFingerprint')"
      :hint="t('connection.sshFingerprintHint')"
      :error="errorFor('ssh.hostFingerprint')"
      placeholder="SHA256:…"
      autocomplete="off"
      mono
    />
  </template>
</template>
