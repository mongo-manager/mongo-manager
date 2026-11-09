<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  parsePipeline,
  serializeValue,
  type Collation,
  type CreateCollection,
} from '@mongo-manager/shared/browser'
import { collationLocales } from './collationLocales'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsTextarea from '@/ds/DsTextarea.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { openCollectionTab } from '@/workspace/openTabs'
import { useFormErrors } from './formErrors'

type Kind = CreateCollection['kind']
type Granularity = '' | 'seconds' | 'minutes' | 'hours'

// Kept out of the messages: braces are placeholder syntax for vue-i18n.
const PIPELINE_EXAMPLE = "[{ $match: { status: 'A' } }]"

const props = defineProps<{
  connectionId: string
  db: string
  /** Phase 2a: opened from the aggregation builder, as a view of that pipeline. */
  view?: { viewOn: string; pipeline: string }
  /** User review 2026-10-09: pre-filled from a tab of a collection that is not there. */
  name?: string
}>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const tabs = useTabsStore()
const toasts = useToastStore()
const { general, reset, showError, errorFor } = useFormErrors()

const kind = ref<Kind>(props.view ? 'view' : 'collection')
const name = ref(props.name ?? '')
const clustered = ref(false)
const size = ref('1048576')
const max = ref('')
const timeField = ref('timestamp')
const metaField = ref('')
const granularity = ref<Granularity>('')
const expireAfter = ref('')
const viewOn = ref(props.view?.viewOn ?? '')
const pipeline = ref(props.view?.pipeline ?? '[]')
const pipelineError = ref('')
// W2.4 (2026-10-16): a default collation (every kind takes one) and change-stream pre/post images
// (collections and capped collections only: MongoDB has none for time series or views).
const useCollation = ref(false)
const collation = ref({
  locale: 'en',
  strength: '',
  caseFirst: '',
  alternate: '',
  maxVariable: '',
  caseLevel: false,
  numericOrdering: false,
  backwards: false,
  normalization: false,
})
const preImages = ref(false)
const takesImages = computed(() => kind.value === 'collection' || kind.value === 'capped')
const localeOptions = computed(() => collationLocales(locale.value, t('collection.collation.simple')))
const strengths = computed(() => [
  { value: '', label: t('collection.collation.strengthDefault') },
  ...['1', '2', '3', '4', '5'].map((s) => ({ value: s, label: t(`collection.collation.strengths.${s}`) })),
])
const caseFirsts = computed(() => [
  { value: '', label: t('collection.collation.default') },
  ...(['upper', 'lower', 'off'] as const).map((c) => ({
    value: c,
    label: t(`collection.collation.caseFirsts.${c}`),
  })),
])
const alternates = computed(() => [
  { value: '', label: t('collection.collation.default') },
  { value: 'non-ignorable', label: t('collection.collation.alternates.nonIgnorable') },
  { value: 'shifted', label: t('collection.collation.alternates.shifted') },
])
const maxVariables = computed(() => [
  { value: '', label: t('collection.collation.default') },
  { value: 'punct', label: t('collection.collation.maxVariables.punct') },
  { value: 'space', label: t('collection.collation.maxVariables.space') },
])
/** Only what was chosen: MongoDB fills in the locale's own defaults for the rest. */
function collationBody(): Collation | undefined {
  if (!useCollation.value) return undefined
  const c = collation.value
  return {
    locale: c.locale,
    ...(c.strength ? { strength: Number(c.strength) } : {}),
    ...(c.caseFirst ? { caseFirst: c.caseFirst as Collation['caseFirst'] } : {}),
    ...(c.alternate ? { alternate: c.alternate as Collation['alternate'] } : {}),
    ...(c.maxVariable ? { maxVariable: c.maxVariable as Collation['maxVariable'] } : {}),
    ...(c.caseLevel ? { caseLevel: true } : {}),
    ...(c.numericOrdering ? { numericOrdering: true } : {}),
    ...(c.backwards ? { backwards: true } : {}),
    ...(c.normalization ? { normalization: true } : {}),
  }
}
const extras = () => {
  const c = collationBody()
  return { ...(c ? { collation: c } : {}) }
}
const images = () => (preImages.value ? { changeStreamPreAndPostImages: true } : {})

const kinds = computed(() =>
  (['collection', 'capped', 'timeseries', 'view'] as const).map((k) => ({
    value: k,
    label: t(`collection.kinds.${k}`),
  })),
)
const granularities = computed(() => [
  { value: '' as const, label: t('collection.granularityDefault') },
  ...(['seconds', 'minutes', 'hours'] as const).map((g) => ({
    value: g,
    label: t(`collection.granularities.${g}`),
  })),
])

const { data: collections } = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connectionId, props.db)),
  queryFn: () => connectionsApi.collections(props.connectionId, props.db),
  enabled: computed(() => kind.value === 'view'),
})
const sources = computed(() => (collections.value ?? []).map((c) => ({ value: c.name, label: c.name })))
watch(sources, (list) => {
  if (!viewOn.value && list[0]) viewOn.value = list[0].value
})

/** Unparseable numbers become NaN → null in JSON, so the server names the field. */
const num = (v: string): number => Number(v.trim())

function body(): CreateCollection | null {
  const n = name.value.trim()
  switch (kind.value) {
    case 'collection':
      return { kind: 'collection', name: n, clustered: clustered.value, ...extras(), ...images() }
    case 'capped':
      return {
        kind: 'capped',
        name: n,
        size: num(size.value),
        ...(max.value.trim() ? { max: num(max.value) } : {}),
        ...extras(),
        ...images(),
      }
    case 'timeseries':
      return {
        kind: 'timeseries',
        name: n,
        timeField: timeField.value.trim(),
        ...(metaField.value.trim() ? { metaField: metaField.value.trim() } : {}),
        ...(granularity.value ? { granularity: granularity.value } : {}),
        ...(expireAfter.value.trim() ? { expireAfterSeconds: num(expireAfter.value) } : {}),
        ...extras(),
      }
    case 'view':
      try {
        // The query bar's parser: no eval, only BSON constructors (spec §5 S7).
        const stages = parsePipeline(pipeline.value)
        pipelineError.value = ''
        return {
          kind: 'view',
          name: n,
          viewOn: viewOn.value,
          pipeline: stages.map((stage) => serializeValue(stage) as Record<string, unknown>),
          ...extras(),
        }
      } catch (e) {
        pipelineError.value = t('collection.pipelineInvalid', {
          message: e instanceof Error ? e.message : String(e),
        })
        return null
      }
  }
}

const { mutate: create, isPending } = useMutation({
  mutationFn: (payload: CreateCollection) =>
    connectionsApi.createCollection(props.connectionId, props.db, payload),
  onMutate: reset,
  onSuccess: async (_result, payload) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections(props.connectionId, props.db),
        exact: true,
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.databaseStats(props.connectionId, props.db) }),
    ])
    toasts.push({ kind: 'success', message: t('collection.created', { name: payload.name }) })
    openCollectionTab(tabs, props.connectionId, props.db, payload.name)
    emit('close')
  },
  onError: showError,
})

function submit(): void {
  const payload = body()
  if (payload) create(payload)
}
</script>

<template>
  <DsDialog open :title="t('collection.new')" size="md" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <DsInput
        v-model="name"
        :label="t('collection.name')"
        :error="errorFor('name')"
        autocomplete="off"
        required
      />
      <DsSelect v-model="kind" :label="t('collection.kind')" :options="kinds" />
      <DsCheckbox v-if="kind === 'collection'" v-model="clustered" :label="t('collection.clustered')" />
      <template v-else-if="kind === 'capped'">
        <DsInput
          v-model="size"
          :label="t('collection.size')"
          :error="errorFor('size')"
          inputmode="numeric"
          autocomplete="off"
        />
        <DsInput
          v-model="max"
          :label="t('collection.max')"
          :error="errorFor('max')"
          inputmode="numeric"
          autocomplete="off"
        />
      </template>
      <template v-else-if="kind === 'timeseries'">
        <DsInput
          v-model="timeField"
          :label="t('collection.timeField')"
          :error="errorFor('timeField')"
          autocomplete="off"
          mono
        />
        <DsInput
          v-model="metaField"
          :label="t('collection.metaField')"
          :error="errorFor('metaField')"
          autocomplete="off"
          mono
        />
        <DsSelect v-model="granularity" :label="t('collection.granularity')" :options="granularities" />
        <DsInput
          v-model="expireAfter"
          :label="t('collection.expireAfterSeconds')"
          :error="errorFor('expireAfterSeconds')"
          inputmode="numeric"
          autocomplete="off"
        />
      </template>
      <template v-else>
        <DsSelect
          v-model="viewOn"
          :label="t('collection.viewOn')"
          :options="sources"
          :error="errorFor('viewOn')"
        />
        <DsTextarea
          v-model="pipeline"
          :label="t('collection.pipeline')"
          :hint="t('collection.pipelineHint', { example: PIPELINE_EXAMPLE })"
          :error="pipelineError || errorFor('pipeline')"
          :rows="6"
          mono
        />
      </template>
      <DsCheckbox
        v-if="takesImages"
        v-model="preImages"
        :label="t('collection.preImages')"
        :hint="t('collection.preImagesHint')"
      />
      <DsCheckbox
        v-model="useCollation"
        :label="t('collection.collation.use')"
        :hint="t('collection.collation.hint')"
      />
      <fieldset
        v-if="useCollation"
        data-collation
        class="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2"
      >
        <legend class="px-1 text-small font-medium text-fg-muted">
          {{ t('collection.collation.title') }}
        </legend>
        <DsSelect
          v-model="collation.locale"
          :label="t('collection.collation.locale')"
          :options="localeOptions"
          :error="errorFor('collation')"
        />
        <DsSelect
          v-model="collation.strength"
          :label="t('collection.collation.strength')"
          :options="strengths"
        />
        <DsSelect
          v-model="collation.caseFirst"
          :label="t('collection.collation.caseFirst')"
          :options="caseFirsts"
        />
        <DsSelect
          v-model="collation.alternate"
          :label="t('collection.collation.alternate')"
          :options="alternates"
        />
        <DsSelect
          v-if="collation.alternate === 'shifted'"
          v-model="collation.maxVariable"
          :label="t('collection.collation.maxVariable')"
          :options="maxVariables"
        />
        <div class="flex flex-col gap-2 sm:col-span-2">
          <DsCheckbox
            v-model="collation.numericOrdering"
            :label="t('collection.collation.numericOrdering')"
          />
          <DsCheckbox v-model="collation.caseLevel" :label="t('collection.collation.caseLevel')" />
          <DsCheckbox v-model="collation.backwards" :label="t('collection.collation.backwards')" />
          <DsCheckbox v-model="collation.normalization" :label="t('collection.collation.normalization')" />
        </div>
      </fieldset>
      <DsFormErrors :messages="general" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="submit">{{ t('collection.create') }}</DsButton>
    </template>
  </DsDialog>
</template>
