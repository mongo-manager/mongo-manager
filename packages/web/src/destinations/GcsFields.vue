<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { GCS_STORAGE_CLASSES, type DestinationView } from '@mongo-manager/shared/browser'
import DsField from '@/ds/DsField.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { DRAFT_KEY } from './useDestinationDraft'
import { serviceAccountEmail } from './serviceAccount'

/**
 * W4.5: a Google Cloud Storage bucket, written as a service account (its JSON key is sealed on the
 * server and never shown again; here only the account it names is said back).
 */
defineProps<{ existing?: DestinationView }>()
const { draft, identityChanged } = inject(DRAFT_KEY)!
const { t } = useI18n()
const c = computed(() => draft.config as Record<string, unknown>)
const str = (k: string) => String(c.value[k] ?? '')
const set = (k: string, v: unknown) => (draft.config[k] = v)
const key = computed(() => draft.secrets.serviceAccountKey ?? null)
const email = computed(() => (key.value ? serviceAccountEmail(key.value) : null))
const classOptions = computed(() =>
  GCS_STORAGE_CLASSES.map((v) => ({ value: v, label: t(`destinations.gcs.class.${v}`) })),
)
const section = 'flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5'
</script>

<template>
  <section :class="section">
    <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
    <div class="grid gap-4 sm:grid-cols-2">
      <DsField
        :model-value="str('bucket')"
        :label="t('destinations.editor.bucket')"
        mono
        @update:model-value="(v) => set('bucket', v)"
      />
      <DsField
        :model-value="str('prefix')"
        :label="t('destinations.editor.prefix')"
        mono
        @update:model-value="(v) => set('prefix', v)"
      />
    </div>
    <DsSelect
      :model-value="str('storageClass') || 'STANDARD'"
      :label="t('destinations.editor.storageClass')"
      :options="classOptions"
      :hint="t('destinations.gcs.classHelp')"
      @update:model-value="(v) => set('storageClass', v)"
    />
    <DsSecretField
      :label="t('destinations.gcs.key')"
      :stored="Boolean(existing?.secrets.serviceAccountKey)"
      :reenter="identityChanged"
      :model-value="key"
      @update:model-value="(v) => (draft.secrets.serviceAccountKey = v)"
    />
    <p v-if="email" class="text-small text-fg-muted" data-test="gcs-account">
      {{ t('destinations.drive.keyFor', { email }) }}
    </p>
    <p v-else-if="key" role="alert" class="text-small text-danger">
      {{ t('destinations.drive.keyInvalid') }}
    </p>
    <p class="text-small text-fg-subtle">{{ t('destinations.gcs.keyHelp') }}</p>
  </section>
</template>
