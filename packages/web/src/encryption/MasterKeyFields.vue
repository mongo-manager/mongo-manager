<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { KmsProvider } from '@mongo-manager/shared/browser'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { MASTER_KEY_FIELDS, type MasterKeyForm } from './masterKey'

/** W8: the master key of a data key — its provider (one of the connection's) and its fields. */
const props = defineProps<{ providers: KmsProvider[] }>()
const model = defineModel<MasterKeyForm>({ required: true })
const { t } = useI18n()
const options = computed(() =>
  props.providers.map((p) => ({ value: p, label: t(`connection.encryption.kms.${p}`) })),
)
const fields = computed(() => MASTER_KEY_FIELDS[model.value.provider])
function set(key: keyof MasterKeyForm, value: string): void {
  if (key !== 'provider') model.value = { ...model.value, [key]: value }
}
</script>

<template>
  <DsSelect v-model="model.provider" :label="t('encryption.provider')" :options="options" />
  <DsInput
    v-for="f in fields"
    :key="f.key"
    :model-value="String(model[f.key])"
    :label="
      f.optional
        ? t('encryption.optionalField', { name: t(`encryption.masterKey.${f.key}`) })
        : t(`encryption.masterKey.${f.key}`)
    "
    autocomplete="off"
    mono
    @update:model-value="(v: string) => set(f.key, v)"
  />
</template>
