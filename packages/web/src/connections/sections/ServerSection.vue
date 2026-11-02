<script setup lang="ts">
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, X } from 'lucide-vue-next'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsButton from '@/ds/DsButton.vue'
import { useConnectionForm } from '../formContext'
import DockerLoopbackHint from '../DockerLoopbackHint.vue'

const { t } = useI18n()
const { form, errorFor } = useConnectionForm()
watch(
  () => form.scheme,
  (scheme) => {
    if (scheme !== 'mongodb+srv') return
    form.hosts = [{ host: form.hosts[0]?.host ?? '', port: '' }]
    // Hidden for SRV and refused by the server there.
    form.directConnection = false
  },
)
</script>

<template>
  <DsSelect
    v-model="form.scheme"
    :label="t('connection.scheme')"
    :options="[
      { value: 'mongodb', label: t('connection.schemeStandard') },
      { value: 'mongodb+srv', label: t('connection.schemeSrv') },
    ]"
  />
  <fieldset class="flex flex-col gap-2">
    <legend class="mb-1.5 text-small font-medium text-fg">
      {{ t('connection.hosts') }}
    </legend>
    <p v-if="errorFor('hosts')" class="text-small text-danger">{{ errorFor('hosts') }}</p>
    <div v-for="(h, i) in form.hosts" :key="i" class="flex items-start gap-2">
      <DsInput
        v-model="h.host"
        class="flex-1"
        :label="t('connection.host')"
        :error="errorFor(`hosts.${i}.host`)"
        :placeholder="form.scheme === 'mongodb+srv' ? 'cluster0.example.mongodb.net' : 'localhost'"
        required
        :data-connection-field="`host-${i}`"
        autocomplete="off"
        mono
      />
      <DsInput
        v-if="form.scheme === 'mongodb'"
        v-model="h.port"
        class="w-28"
        :label="t('connection.port')"
        :error="errorFor(`hosts.${i}.port`)"
        placeholder="27017"
        inputmode="numeric"
        autocomplete="off"
      />
      <button
        v-if="form.hosts.length > 1"
        type="button"
        class="mt-7 grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg"
        :aria-label="t('connection.removeHost', { host: h.host || i + 1 })"
        @click="form.hosts.splice(i, 1)"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <DockerLoopbackHint />
    <DsButton
      v-if="form.scheme === 'mongodb'"
      size="sm"
      variant="ghost"
      class="self-start"
      @click="form.hosts.push({ host: '', port: '' })"
    >
      <Plus class="size-4" aria-hidden="true" />
      {{ t('connection.addHost') }}
    </DsButton>
  </fieldset>
  <DsInput
    v-model="form.defaultDatabase"
    :label="t('connection.defaultDatabase')"
    :error="errorFor('defaultDatabase')"
    autocomplete="off"
  />
  <template v-if="form.scheme === 'mongodb'">
    <DsInput
      v-model="form.replicaSet"
      :label="t('connection.replicaSet')"
      :error="errorFor('replicaSet')"
      autocomplete="off"
    />
    <DsCheckbox v-model="form.directConnection" :label="t('connection.directConnection')" />
  </template>
</template>
