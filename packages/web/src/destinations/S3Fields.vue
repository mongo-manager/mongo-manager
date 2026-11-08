<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ARCHIVE_STORAGE_CLASSES,
  S3_PRESETS,
  S3_STORAGE_CLASSES,
  type DestinationView,
  type S3Preset,
} from '@mongo-manager/shared/browser'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsField from '@/ds/DsField.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { S3_PRESET_INFO } from './presets'
import { DRAFT_KEY } from './useDestinationDraft'
import { addressHints } from './hints'
import DsSelect from '@/ds/DsSelect.vue'

/** Phase 3d-3b §2.3, D2: the provider's preset, then where and how to reach the bucket. */
const props = defineProps<{ part: 'provider' | 'connection'; existing?: DestinationView }>()
const { draft, setPreset, identityChanged } = inject(DRAFT_KEY)!
const { t } = useI18n()

const preset = computed(() => draft.preset as S3Preset)
const info = computed(() => S3_PRESET_INFO[preset.value])
const editableEndpoint = computed(() => preset.value === 'minio' || preset.value === 'custom')
const c = computed(() => draft.config as Record<string, unknown>)
const str = (k: string) => String(c.value[k] ?? '')
const set = (k: string, v: unknown) => (draft.config[k] = v)
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const bucketError = computed(() =>
  str('bucket') && !BUCKET.test(str('bucket')) ? t('destinations.editor.bucketRule') : null,
)
function recompute(): void {
  if (!editableEndpoint.value) set('endpoint', info.value.endpoint(str('region'), draft.account))
}
function setRegion(v: string): void {
  set('region', v)
  recompute()
}
function setAccount(v: string): void {
  draft.account = v
  recompute()
}
const hints = computed(() => addressHints(str('endpoint'), t))
const presetHelp = (p: S3Preset) => {
  const i = S3_PRESET_INFO[p]
  return p === 'minio' || p === 'custom'
    ? t('destinations.editor.endpointYours')
    : i.endpoint(i.region, i.account ? '<account>' : '')
}
const section = 'flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5'
const keyHint = computed(() => props.existing?.keyHint ?? null)
</script>

<template>
  <template v-if="part === 'provider'">
    <div
      class="grid gap-3 md:grid-cols-2"
      role="radiogroup"
      :aria-label="t('destinations.editor.steps.provider')"
    >
      <DsChoiceCard
        v-for="p in S3_PRESETS"
        :key="p"
        :model-value="draft.preset"
        name="preset"
        :value="p"
        :title="t(`destinations.preset.${p}`)"
        :help="presetHelp(p)"
        @update:model-value="(v: string) => setPreset(v as S3Preset)"
      />
    </div>
    <p v-if="info.note" role="note" class="rounded-xl bg-warning-soft px-4 py-3 text-ui text-warning">
      {{ t(`destinations.preset.${preset}Note`) }}
    </p>
  </template>

  <template v-else>
    <section :class="section">
      <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
      <div class="grid gap-4 sm:grid-cols-2">
        <DsSelect
          v-if="info.regions"
          :label="t('destinations.editor.region')"
          :model-value="str('region')"
          :options="info.regions.map((r) => ({ value: r, label: r }))"
          @update:model-value="setRegion"
        />
        <DsField
          v-else
          :model-value="str('region')"
          :label="t('destinations.editor.region')"
          mono
          @update:model-value="setRegion"
        />
        <DsField
          v-if="info.account"
          :model-value="draft.account"
          :label="t('destinations.editor.account')"
          mono
          @update:model-value="setAccount"
        />
      </div>
      <DsField
        :model-value="str('endpoint')"
        :label="t('destinations.editor.endpoint')"
        :readonly="!editableEndpoint"
        :help="hints"
        placeholder="https://minio.example.com:9000"
        mono
        @update:model-value="(v) => set('endpoint', v)"
      />
      <div class="grid gap-4 sm:grid-cols-2">
        <DsField
          :model-value="str('bucket')"
          :label="t('destinations.editor.bucket')"
          :error="bucketError"
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
    </section>
    <section :class="section">
      <DsSecretField
        :label="t('destinations.editor.accessKey')"
        :stored="Boolean(existing?.secrets.accessKeyId)"
        :reenter="identityChanged"
        :model-value="draft.secrets.accessKeyId ?? null"
        autocomplete="off"
        @update:model-value="(v) => (draft.secrets.accessKeyId = v)"
      />
      <p
        v-if="keyHint && draft.secrets.accessKeyId === null && !identityChanged"
        class="-mt-2 text-small text-fg-subtle"
      >
        {{ t('destinations.editor.keyHint', { hint: keyHint }) }}
      </p>
      <DsSecretField
        :label="t('destinations.editor.secretKey')"
        :stored="Boolean(existing?.secrets.secretAccessKey)"
        :reenter="identityChanged"
        :model-value="draft.secrets.secretAccessKey ?? null"
        @update:model-value="(v) => (draft.secrets.secretAccessKey = v)"
      />
    </section>
    <details :class="section" class="group">
      <summary class="cursor-pointer text-ui font-medium text-fg">
        {{ t('destinations.editor.advanced') }}
      </summary>
      <div class="mt-4 flex flex-col gap-4">
        <label class="flex items-center gap-3 text-ui">
          <input
            type="checkbox"
            class="size-4 accent-accent"
            :checked="Boolean(c.pathStyle)"
            @change="set('pathStyle', ($event.target as HTMLInputElement).checked)"
          />
          {{ t('destinations.editor.pathStyle') }}
        </label>
        <div class="flex flex-col gap-1.5 text-ui">
          <DsSelect
            :label="t('destinations.editor.storageClass')"
            :model-value="str('storageClass') || 'STANDARD'"
            :options="S3_STORAGE_CLASSES.map((s) => ({ value: s, label: s }))"
            @update:model-value="set('storageClass', $event)"
          />
          <span v-if="ARCHIVE_STORAGE_CLASSES.includes(str('storageClass'))" class="text-small text-warning">
            {{ t('destinations.editor.archiveClass') }}
          </span>
        </div>
        <div class="flex flex-col gap-1.5 text-ui">
          <DsSelect
            :label="t('destinations.editor.sse')"
            :model-value="(c.sse as { kind?: string } | undefined)?.kind ?? 'none'"
            :options="[
              { value: 'none', label: t('destinations.editor.sseNone') },
              { value: 'AES256', label: t('destinations.editor.sseAes') },
              { value: 'aws:kms', label: t('destinations.editor.sseKms') },
            ]"
            @update:model-value="set('sse', { kind: $event })"
          />
        </div>
        <DsField
          v-if="(c.sse as { kind?: string } | undefined)?.kind === 'aws:kms'"
          :model-value="String((c.sse as { keyId?: string }).keyId ?? '')"
          :label="t('destinations.editor.kmsKey')"
          mono
          @update:model-value="(v) => set('sse', v ? { kind: 'aws:kms', keyId: v } : { kind: 'aws:kms' })"
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
</template>
