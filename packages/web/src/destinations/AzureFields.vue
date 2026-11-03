<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { AZURE_ACCESS_TIERS, sasFields, type DestinationView } from '@mongo-manager/shared/browser'
import DsField from '@/ds/DsField.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { DRAFT_KEY } from './useDestinationDraft'

/**
 * W4.5: an Azure Blob Storage container, signed with a SAS token (the narrowest grant: a container,
 * a few permissions, an end date) or the storage account's key. Either is sealed on the server and
 * never shown again.
 */
defineProps<{ existing?: DestinationView }>()
const { draft, identityChanged } = inject(DRAFT_KEY)!
const { t } = useI18n()
const c = computed(() => draft.config as Record<string, unknown>)
const str = (k: string) => String(c.value[k] ?? '')
const set = (k: string, v: unknown) => (draft.config[k] = v)
const auth = computed({
  get: () => (str('auth') === 'sharedKey' ? 'sharedKey' : 'sas'),
  set: (v: 'sas' | 'sharedKey') => set('auth', v),
})
const sasBad = computed(
  () => Boolean(draft.secrets.sasToken) && sasFields(String(draft.secrets.sasToken)) === null,
)
const tierOptions = computed(() =>
  AZURE_ACCESS_TIERS.map((v) => ({ value: v, label: t(`destinations.azure.tier.${v}`) })),
)
const section = 'flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5'
</script>

<template>
  <section :class="section">
    <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
    <div class="grid gap-4 sm:grid-cols-2">
      <DsField
        :model-value="str('account')"
        :label="t('destinations.azure.account')"
        mono
        @update:model-value="(v) => set('account', v.trim().toLowerCase())"
      />
      <DsField
        :model-value="str('container')"
        :label="t('destinations.azure.container')"
        mono
        @update:model-value="(v) => set('container', v.trim().toLowerCase())"
      />
    </div>
    <DsField
      :model-value="str('prefix')"
      :label="t('destinations.editor.prefix')"
      mono
      @update:model-value="(v) => set('prefix', v)"
    />
    <div class="flex flex-col gap-1.5">
      <DsSelect
        :model-value="str('accessTier') || 'default'"
        :label="t('destinations.azure.accessTier')"
        :options="tierOptions"
        @update:model-value="(v) => set('accessTier', v)"
      />
      <span v-if="str('accessTier') === 'Archive'" class="text-small text-warning">
        {{ t('destinations.azure.archiveHelp') }}
      </span>
    </div>
    <DsSegmented
      v-model="auth"
      :label="t('destinations.azure.auth')"
      :options="[
        { value: 'sas', label: t('destinations.azure.sas') },
        { value: 'sharedKey', label: t('destinations.azure.sharedKey') },
      ]"
    />
    <template v-if="auth === 'sas'">
      <DsSecretField
        :label="t('destinations.azure.sasToken')"
        :stored="Boolean(existing?.secrets.sasToken)"
        :reenter="identityChanged"
        :model-value="draft.secrets.sasToken ?? null"
        @update:model-value="(v) => (draft.secrets.sasToken = v)"
      />
      <p v-if="sasBad" role="alert" class="text-small text-danger">
        {{ t('destinations.azure.sasInvalid') }}
      </p>
      <p class="text-small text-fg-subtle">{{ t('destinations.azure.sasHelp') }}</p>
    </template>
    <template v-else>
      <DsSecretField
        :label="t('destinations.azure.accountKey')"
        :stored="Boolean(existing?.secrets.accountKey)"
        :reenter="identityChanged"
        :model-value="draft.secrets.accountKey ?? null"
        @update:model-value="(v) => (draft.secrets.accountKey = v)"
      />
      <p class="text-small text-fg-subtle">{{ t('destinations.azure.keyHelp') }}</p>
    </template>
  </section>
  <details :class="section" class="group">
    <summary class="cursor-pointer text-ui font-medium text-fg">
      {{ t('destinations.editor.advanced') }}
    </summary>
    <div class="mt-4 flex flex-col gap-4">
      <DsField
        :model-value="str('endpoint')"
        :label="t('destinations.azure.endpoint')"
        :help="t('destinations.azure.endpointHelp')"
        placeholder="https://<account>.blob.core.windows.net"
        mono
        @update:model-value="
          (v) => {
            if (v.trim()) set('endpoint', v.trim())
            else delete draft.config.endpoint
          }
        "
      />
      <label class="flex flex-col gap-1.5 text-ui">
        <span class="font-medium text-fg">{{ t('destinations.editor.ca') }}</span>
        <textarea
          :value="str('caPem')"
          rows="4"
          spellcheck="false"
          placeholder="-----BEGIN CERTIFICATE-----"
          class="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-small focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
          @input="
            (e) => {
              const v = (e.target as HTMLTextAreaElement).value.trim()
              if (v) set('caPem', v)
              else delete draft.config.caPem
            }
          "
        />
      </label>
    </div>
  </details>
</template>
