<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ChevronsUpDown, List } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import {
  AI_CURRENCIES,
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  AI_KEY_REQUIRED,
  AI_KINDS,
  AI_LIMITS,
  GEMINI_MODEL,
  type AiCurrency,
  type AiKind,
  type AiModel,
  type AiPrice,
  type AiProviderView,
} from '@mongo-manager/shared/browser'
import DsCombobox from '@/ds/DsCombobox.vue'
import { useAiWords } from './words'
import DsSheet from '@/ds/DsSheet.vue'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsField from '@/ds/DsField.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { aiApi } from '@/api/ai'
import { describeError } from '@/api/errors'
import { ApiError } from '@/api/client'

/** Spec §2.1: add or change a provider; the key is write-only and asked again when the address moves. */
const props = defineProps<{ provider: AiProviderView | null }>()
const emit = defineEmits<{ close: []; saved: [AiProviderView] }>()
const { t, te } = useI18n()
const before = props.provider
const form = reactive({
  name: before?.name ?? '',
  kind: (before?.kind ?? 'anthropic') as AiKind,
  baseUrl: before?.baseUrl ?? AI_DEFAULT_BASE_URL.anthropic,
  model: before?.model ?? AI_DEFAULT_MODEL,
  maxTokens: String(before?.maxTokens ?? AI_LIMITS.maxTokensDefault),
  samples: before?.samples ?? false,
  enabled: before?.enabled ?? true,
  // User review 2026-10-09: what a million tokens cost, to show each request's cost; both or neither.
  priceIn: before?.price ? String(before.price.input) : '',
  priceOut: before?.price ? String(before.price.output) : '',
  currency: (before?.price?.currency ?? 'USD') as AiCurrency,
})
/** null keeps the stored key; a string replaces it. */
const key = ref<string | null>(before ? null : '')
const error = ref<string | null>(null)
const saving = ref(false)

function chooseKind(kind: AiKind): void {
  // A new provider follows its kind's defaults; an edited one keeps what was typed.
  if (!before) {
    form.baseUrl = AI_DEFAULT_BASE_URL[kind]
    form.model = kind === 'anthropic' ? AI_DEFAULT_MODEL : ''
    form.samples = kind === 'ollama'
  }
  form.kind = kind
}
const moved = computed(
  () => !!before && (form.kind !== before.kind || form.baseUrl.trim().replace(/\/+$/, '') !== before.baseUrl),
)
const keyNeeded = computed(
  () => AI_KEY_REQUIRED.has(form.kind) && (!before || moved.value || !before.keyStored),
)
// Spec §2.7, plan ruling 12: a Gemini model name is one path segment; refused before saving.
const modelError = computed(() =>
  form.kind === 'gemini' && form.model.trim() !== '' && !GEMINI_MODEL.test(form.model.trim())
    ? t('ai.settings.refusal.model_invalid')
    : null,
)
const tokens = computed(() => Number(form.maxTokens))
/** A price as typed: a decimal comma is a point; undefined when it is not a price. */
const amount = (text: string): number | undefined => {
  const v = text.trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(v)) return undefined
  const n = Number(v)
  return n <= 100_000 ? n : undefined
}
/** null: no price; undefined: not a price yet (one side missing or not a number). */
const price = computed<AiPrice | null | undefined>(() => {
  const a = form.priceIn.trim()
  const b = form.priceOut.trim()
  if (a === '' && b === '') return null
  const input = amount(a)
  const output = amount(b)
  return input === undefined || output === undefined ? undefined : { input, output, currency: form.currency }
})
const priceError = computed(() => {
  if (price.value !== undefined) return null
  const half = form.priceIn.trim() === '' || form.priceOut.trim() === ''
  return half ? t('ai.settings.price.both') : t('ai.settings.price.invalid')
})
const samePrice = (a: AiPrice | null, b: AiPrice | null) =>
  a === b || (!!a && !!b && a.input === b.input && a.output === b.output && a.currency === b.currency)
const valid = computed(
  () =>
    form.name.trim() !== '' &&
    form.baseUrl.trim() !== '' &&
    form.model.trim() !== '' &&
    Number.isInteger(tokens.value) &&
    tokens.value >= AI_LIMITS.maxTokensMin &&
    tokens.value <= AI_LIMITS.maxTokensMax &&
    (!keyNeeded.value || (key.value ?? '') !== '') &&
    !modelError.value &&
    price.value !== undefined,
)

// User review 2026-10-09: the models the provider offers, read from it, to choose from (typing stays).
const words = useAiWords()
const models = ref<AiModel[]>([])
const listing = ref(false)
const modelsError = ref<string | null>(null)
const modelOptions = computed(() =>
  models.value.map((m) => ({ value: m.id, label: m.label ?? m.id, ...(m.label ? { hint: m.id } : {}) })),
)
async function fetchModels(): Promise<void> {
  listing.value = true
  modelsError.value = null
  try {
    const typedKey = key.value ? key.value : undefined
    const r = await aiApi.models({
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      // A key typed here travels; a saved one never leaves the server (it is named by the provider).
      ...(typedKey ? { apiKey: typedKey } : before && !moved.value ? { providerId: before.id } : {}),
    })
    models.value = r.models
    if (r.outcome !== 'ok') modelsError.value = words.reason(r.outcome)
    else if (r.models.length === 0) modelsError.value = t('ai.settings.models.none')
  } catch (e) {
    models.value = []
    modelsError.value = describeError(e, t)
  } finally {
    listing.value = false
  }
}
// Another kind or address offers other models.
watch(
  () => [form.kind, form.baseUrl] as const,
  () => {
    models.value = []
    modelsError.value = null
  },
)

async function save(): Promise<void> {
  if (!valid.value) return
  saving.value = true
  error.value = null
  try {
    let saved: AiProviderView
    if (!before) {
      saved = await aiApi.create({
        name: form.name.trim(),
        kind: form.kind,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        maxTokens: tokens.value,
        samples: form.samples,
        enabled: form.enabled,
        ...(key.value ? { apiKey: key.value } : {}),
        ...(price.value ? { price: price.value } : {}),
      })
    } else {
      // Only what changed is sent; the key only when it was replaced (or must be, after a move).
      const patch: Record<string, unknown> = {}
      if (form.name.trim() !== before.name) patch.name = form.name.trim()
      if (form.kind !== before.kind) patch.kind = form.kind
      if (moved.value) patch.baseUrl = form.baseUrl.trim()
      if (form.model.trim() !== before.model) patch.model = form.model.trim()
      if (tokens.value !== before.maxTokens) patch.maxTokens = tokens.value
      if (form.samples !== before.samples) patch.samples = form.samples
      if (form.enabled !== before.enabled) patch.enabled = form.enabled
      if (!samePrice(price.value ?? null, before.price)) patch.price = price.value ?? null
      if (key.value !== null) patch.apiKey = key.value === '' ? null : key.value
      saved = Object.keys(patch).length ? await aiApi.update(before.id, patch) : before
    }
    emit('saved', saved)
    emit('close')
  } catch (e) {
    // The server's reasons (a key asked again, a name taken, an address refused) in words.
    const reason = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : undefined
    error.value =
      typeof reason === 'string' && te(`ai.settings.refusal.${reason}`)
        ? t(`ai.settings.refusal.${reason}`)
        : describeError(e, t)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DsSheet
    open
    :title="before ? t('ai.settings.editTitle', { name: before.name }) : t('ai.settings.addTitle')"
    :subtitle="t('ai.settings.editorSubtitle')"
    @close="emit('close')"
  >
    <form
      data-ai-editor
      class="mx-auto grid w-full max-w-3xl content-start gap-x-5 gap-y-4 sm:grid-cols-2"
      @submit.prevent="save"
    >
      <DsField v-model="form.name" :label="t('ai.settings.name')" />
      <DsSelect
        :model-value="form.kind"
        :label="t('ai.settings.kind')"
        :options="AI_KINDS.map((k) => ({ value: k, label: t(`ai.kind.${k}`) }))"
        @update:model-value="chooseKind"
      />
      <DsField
        v-model="form.baseUrl"
        class="sm:col-span-2"
        :label="t('ai.settings.address')"
        :help="t(`ai.settings.addressHelp.${form.kind}`)"
        mono
      />
      <div class="flex flex-col gap-1.5">
        <DsField
          v-model="form.model"
          :label="t('ai.settings.model')"
          :help="t(`ai.settings.modelHelp.${form.kind}`)"
          :error="modelError"
          mono
        />
        <div class="flex flex-wrap items-center gap-2 text-small">
          <DsButton size="sm" :loading="listing" @click="fetchModels">
            <List class="size-3.5" aria-hidden="true" />{{ t('ai.settings.models.fetch') }}
          </DsButton>
          <DsCombobox
            v-if="models.length"
            :label="t('ai.settings.models.choose')"
            :items="modelOptions"
            :current="form.model"
            :placeholder="t('ai.settings.models.find')"
            :empty-text="t('layout.noMatch')"
            search-hints
            trigger-class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-small text-fg hover:bg-subtle"
            @select="form.model = $event"
          >
            <template #trigger>
              {{ t('ai.settings.models.count', { n: models.length }, models.length) }}
              <ChevronsUpDown class="size-3.5 text-fg-subtle" aria-hidden="true" />
            </template>
          </DsCombobox>
          <span v-if="modelsError" data-models-error role="alert" class="text-danger">{{ modelsError }}</span>
        </div>
      </div>
      <DsField
        v-model="form.maxTokens"
        :label="t('ai.settings.maxTokens')"
        :help="t('ai.settings.maxTokensHelp')"
        type="number"
      />
      <fieldset data-price class="grid items-end gap-x-5 gap-y-2 sm:col-span-2 sm:grid-cols-[1fr_1fr_8rem]">
        <legend class="mb-1.5 text-ui font-medium text-fg">{{ t('ai.settings.price.title') }}</legend>
        <DsField
          v-model="form.priceIn"
          :invalid="!!priceError"
          describedby="ai-price-error"
          :label="t('ai.settings.price.input')"
          inputmode="decimal"
          placeholder="0.00"
        />
        <DsField
          v-model="form.priceOut"
          :invalid="!!priceError"
          describedby="ai-price-error"
          :label="t('ai.settings.price.output')"
          inputmode="decimal"
          placeholder="0.00"
        />
        <DsSelect
          v-model="form.currency"
          :label="t('ai.settings.price.currency')"
          :options="AI_CURRENCIES.map((c) => ({ value: c, label: c }))"
        />
        <p class="text-small text-fg-subtle sm:col-span-3">{{ t('ai.settings.price.help') }}</p>
        <p
          v-if="priceError"
          id="ai-price-error"
          data-price-error
          role="alert"
          class="text-small text-danger sm:col-span-3"
        >
          {{ priceError }}
        </p>
      </fieldset>
      <DsSecretField
        v-if="form.kind !== 'ollama' || before?.keyStored"
        v-model="key"
        class="sm:col-span-2"
        :label="t('ai.settings.apiKey')"
        :stored="!!before?.keyStored"
        :reenter="moved"
        autocomplete="off"
      />
      <p v-if="moved && before?.keyStored" class="text-ui text-warning sm:col-span-2">
        {{ t('ai.settings.keyAgain') }}
      </p>
      <DsCheckbox
        v-model="form.samples"
        class="sm:col-span-2"
        :label="t('ai.settings.samplesLabel')"
        :hint="t('ai.settings.samplesHint')"
      />
      <DsCheckbox v-model="form.enabled" class="sm:col-span-2" :label="t('ai.settings.enabled')" />
      <p v-if="error" role="alert" class="text-ui text-danger sm:col-span-2">{{ error }}</p>
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="saving" :disabled="!valid" @click="save">{{
        t('common.save')
      }}</DsButton>
    </template>
  </DsSheet>
</template>
