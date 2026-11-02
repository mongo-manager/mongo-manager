<script setup lang="ts">
import { FlaskConical, History, RotateCw, Save, ShieldCheck, Sparkles } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import MaskedBanner from '@/masking/MaskedBanner.vue'
import { provideMaskedPaths } from '@/masking/useMaskedPaths'
import { rulesEpoch } from '@/masking/rulesEpoch'
import DsCard from '@/ds/DsCard.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  ERROR_AND_LOG_SINCE,
  QueryParseError,
  deserializeValue,
  formatShell,
  parseMongoVersion,
  parseQueryObject,
  serializeValue,
  toJsonSchema,
  type ValidationState,
} from '@mongo-manager/shared/browser'
import DsCodeEditor from '@/ds/DsCodeEditor.vue'
import DocumentJsonList from '@/documents/DocumentJsonList.vue'
import { toRows } from '@/documents/rows'
import { documentsApi, type CollectionTarget, type DocumentItem } from '@/api/documents'
import { validationApi, validationKeys } from '@/api/explain'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useCollectionViewsStore, type ValidationDraft } from '@/stores/collectionViews'

/**
 * Phase 2b spec §3.2: the collection's validation rules. Test them against the documents already
 * there before saving; the rules replaced in this session can be put back. The editor is kept with
 * the tab, so leaving the section to look at a document loses nothing (final review 2b, I3).
 */
const props = defineProps<{ target: CollectionTarget; canWrite: boolean; tabId?: string }>()

// W5 (spec 3c §7): the masking hint on every data screen, and the hidden paths for the locks.
const masking = provideMaskedPaths(
  computed(() => props.target.connectionId),
  computed(() => props.target.db),
  computed(() => props.target.coll),
)
/** A code example, not language: the same in every locale. */
const RULES_EXAMPLE = '{ $jsonSchema: { bsonType: "object", required: ["name"] } }'
const { t, locale } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const tab = useCollectionViewsStore().stateFor(
  props.tabId ?? `${props.target.connectionId}/${props.target.db}/${props.target.coll}`,
)

const key = computed(() => validationKeys.state(props.target))
const {
  data,
  error: loadError,
  refetch,
} = useQuery({
  queryKey: key,
  queryFn: () => validationApi.get(props.target),
})

const shellOf = (validator: Record<string, unknown> | null) =>
  validator ? formatShell(deserializeValue(validator), { indent: 2 }) : ''
const draftOf = (s: ValidationState): ValidationDraft => ({
  text: shellOf(s.validator),
  level: s.validationLevel,
  action: s.validationAction,
  base: s.version,
  tested: null,
  testedFor: '',
})
// The draft starts from the stored rules once; later it is the user's until they save or reload.
watch(
  data,
  (s) => {
    if (s && !tab.validationDraft) tab.validationDraft = draftOf(s)
  },
  { immediate: true },
)
const draft = computed(() => tab.validationDraft)
const field = <K extends 'text' | 'level' | 'action'>(name: K) =>
  computed({
    get: () =>
      (draft.value?.[name] ??
        (name === 'text' ? '' : name === 'level' ? 'strict' : 'error')) as ValidationDraft[K],
    set: (value: ValidationDraft[K]) => {
      if (tab.validationDraft) tab.validationDraft[name] = value
    },
  })
const text = field('text')
const level = field('level')
const action = field('action')

const supportsErrorAndLog = computed(() => {
  const v = parseMongoVersion(data.value?.serverVersion ?? '')
  const [major, minor] = ERROR_AND_LOG_SINCE.split('.').map(Number) as [number, number]
  return !!v && (v.major > major || (v.major === major && v.minor >= minor))
})
const levelOptions = computed(() =>
  (['off', 'strict', 'moderate'] as const).map((l) => ({ value: l, label: t(`validation.levels.${l}`) })),
)
const actionOptions = computed(() =>
  actions.value.map((a) => ({ value: a, label: t(`validation.actions.${a}`) })),
)
const failingTone = computed(() =>
  unknownFailing.value || (tested.value?.failing ?? tested.value?.failingAtLeast ?? 0) > 0
    ? 'warning'
    : 'success',
)
const actions = computed(() =>
  supportsErrorAndLog.value ? ['error', 'warn', 'errorAndLog'] : ['error', 'warn'],
)

/** The rules as canonical EJSON; null for none; an error message when the text does not parse. */
const parsed = computed((): { validator: Record<string, unknown> | null } | { error: string } => {
  if (!text.value.trim()) return { validator: null }
  try {
    return { validator: serializeValue(parseQueryObject(text.value)) as Record<string, unknown> }
  } catch (e) {
    return {
      error:
        e instanceof QueryParseError
          ? t('aggregation.parseError', { message: e.message, line: e.line, column: e.column })
          : String((e as Error)?.message ?? e),
    }
  }
})

// ---- Generate from a sample (the schema analysis of phase 1i)
const generating = ref(false)
async function generate(): Promise<void> {
  if (text.value.trim()) {
    const ok = await dialogs.confirm({
      title: t('validation.generateTitle'),
      message: t('validation.generateReplace'),
      confirmLabel: t('validation.generate'),
    })
    if (!ok) return
  }
  generating.value = true
  try {
    const analysis = await documentsApi.schema(props.target, 1000)
    text.value = formatShell({ $jsonSchema: toJsonSchema(analysis) }, { indent: 2 })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    generating.value = false
  }
}

// ---- Test against existing documents: a result is for the text it tested (final review 2b, I4)
const testing = ref(false)
const testError = ref<string | null>(null)
let controller: AbortController | null = null
onBeforeUnmount(() => controller?.abort())
// Review 2026-10-26 (I1): its sample is documents, shown only while the personal data rules it was
// asked under stand.
const tested = computed(() =>
  draft.value?.tested &&
  draft.value.testedFor === text.value &&
  (draft.value.testedEpoch ?? 0) === rulesEpoch()
    ? draft.value.tested
    : null,
)
watch(text, (now, before) => {
  if (now !== before) controller?.abort()
})
async function test(): Promise<void> {
  const p = parsed.value
  if ('error' in p || !tab.validationDraft) return
  controller?.abort()
  const mine = new AbortController()
  controller = mine
  const forText = text.value
  const rulesFrom = rulesEpoch()
  testing.value = true
  testError.value = null
  try {
    const result = await validationApi.test(props.target, p.validator ?? {}, mine.signal)
    // Answered after the personal data rules changed: its sample may show what they hide now.
    if (controller === mine && tab.validationDraft && text.value === forText && rulesEpoch() === rulesFrom) {
      tab.validationDraft.tested = result
      tab.validationDraft.testedFor = forText
      tab.validationDraft.testedEpoch = rulesFrom
    }
  } catch (e) {
    if (controller === mine && !mine.signal.aborted) testError.value = describeError(e, t)
  } finally {
    if (controller === mine) testing.value = false
  }
}
const number = (n: number) => new Intl.NumberFormat(locale.value).format(n)
const sampleRows = computed(() => toRows((tested.value?.sample ?? []) as DocumentItem[], 0))
/** Unknown when the count took too long and no lower bound came back (final review 2b, I1). */
const unknownFailing = computed(
  () => !!tested.value && tested.value.failing === null && tested.value.failingAtLeast === undefined,
)

// ---- Save, and put back the rules the first save of this tab replaced
const saving = ref(false)
const conflict = ref(false)
/** Rules to put back, read while the personal data rules stand as they do now. */
const restorable = computed(
  () => !!tab.validationPrevious && (tab.validationPreviousEpoch ?? 0) === rulesEpoch(),
)
async function apply(
  body: Pick<ValidationState, 'validator' | 'validationLevel' | 'validationAction'>,
): Promise<boolean> {
  saving.value = true
  const rulesFrom = rulesEpoch()
  try {
    const saved = await validationApi.set(props.target, { ...body, expected: tab.validationDraft?.base })
    // 2026-10-26: the personal data rules changed while it was on its way: its answer (and the rules
    // it replaced) may quote what they hide now. Saved all the same; what is kept is read again.
    if (rulesEpoch() !== rulesFrom) {
      conflict.value = false
      const fresh = await refetch()
      if (fresh.data) tab.validationDraft = draftOf(fresh.data)
      return true
    }
    const { previous, ...now } = saved
    queryClient.setQueryData(key.value, now)
    // Kept from the first save: a second save does not make the original rules unreachable — unless
    // those were read before the personal data rules changed (review 2026-10-26, I1).
    if (!restorable.value) {
      tab.validationPrevious = previous
      tab.validationPreviousEpoch = rulesFrom
    }
    tab.validationDraft = { ...draftOf(now), text: text.value.trim() ? text.value : '' }
    conflict.value = false
    return true
  } catch (e) {
    if (e instanceof ApiError && (e.details as { reason?: unknown } | undefined)?.reason === 'rules_changed')
      conflict.value = true
    else toasts.push({ kind: 'error', message: describeError(e, t) })
    return false
  } finally {
    saving.value = false
  }
}
async function save(): Promise<void> {
  const p = parsed.value
  if ('error' in p || !data.value) return
  const failing = tested.value?.failing ?? tested.value?.failingAtLeast ?? 0
  const enforced = level.value !== 'off' && action.value === 'error'
  const warning = !enforced
    ? ''
    : unknownFailing.value
      ? t('validation.locksUnknown')
      : failing > 0
        ? t('validation.locks', { n: number(failing) })
        : ''
  const ok = await dialogs.confirm({
    title: t('validation.saveTitle'),
    message: warning ? `${t('validation.saveMessage')} ${warning}` : t('validation.saveMessage'),
    confirmLabel: t('validation.save'),
    danger: !!warning,
  })
  if (!ok) return
  if (await apply({ validator: p.validator, validationLevel: level.value, validationAction: action.value }))
    toasts.push({ kind: 'success', message: t('validation.saved') })
}
async function restore(): Promise<void> {
  const before = tab.validationPrevious
  if (!before || !restorable.value) return
  if (await apply(before)) {
    tab.validationPrevious = null
    tab.validationDraft = null
    const fresh = queryClient.getQueryData<ValidationState>(key.value)
    if (fresh) tab.validationDraft = draftOf(fresh)
    toasts.push({ kind: 'success', message: t('validation.restored') })
  }
}
/** After a conflict: the rules as they are now replace the draft. */
async function reload(): Promise<void> {
  conflict.value = false
  const fresh = await refetch()
  if (fresh.data) tab.validationDraft = draftOf(fresh.data)
}
</script>

<template>
  <div class="h-full overflow-auto p-4">
    <MaskedBanner v-if="masking.hidden.value" class="mb-3" />
    <DsCallout v-if="loadError" tone="danger">
      {{ describeError(loadError, t) }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="refetch()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <div v-else-if="!data" class="flex max-w-5xl flex-col gap-3" role="status" :aria-label="t('app.loading')">
      <DsSkeleton class="h-11" />
      <DsSkeleton class="h-64" />
    </div>
    <DsEmptyState
      v-else-if="data?.kind === 'view' || data?.kind === 'timeseries'"
      :icon="ShieldCheck"
      :title="t('validation.unavailableTitle')"
      :description="data.kind === 'view' ? t('validation.view') : t('validation.timeseries')"
    />
    <div v-else-if="data && draft" class="flex max-w-5xl flex-col gap-4">
      <DsCard :title="t('validation.title')" actions-shown>
        <template #actions>
          <DsButton size="sm" variant="ghost" :icon="Sparkles" :disabled="generating" @click="generate">
            {{ t('validation.generate') }}
          </DsButton>
          <DsButton size="sm" :icon="FlaskConical" :disabled="testing || 'error' in parsed" @click="test">
            {{ t('validation.test') }}
          </DsButton>
          <DsButton
            v-if="canWrite"
            size="sm"
            variant="primary"
            :icon="Save"
            :disabled="saving || 'error' in parsed"
            @click="save"
          >
            {{ t('validation.save') }}
          </DsButton>
        </template>
        <div class="flex flex-col gap-4">
          <p class="text-ui text-fg-muted">{{ t('validation.intro') }}</p>
          <DsCallout v-if="conflict" data-conflict tone="warning">
            {{ t('validation.conflict') }}
            <template #action>
              <DsButton size="sm" :icon="RotateCw" @click="reload">{{ t('validation.reload') }}</DsButton>
            </template>
          </DsCallout>
          <DsCodeEditor
            v-model="text"
            :label="t('validation.rules')"
            multiline
            :rows="12"
            :placeholder="RULES_EXAMPLE"
            :error="'error' in parsed ? parsed.error : undefined"
          />
          <div class="grid gap-4 sm:grid-cols-2">
            <DsSelect
              v-model="level"
              :label="t('validation.level')"
              :options="levelOptions"
              :disabled="!canWrite"
              :hint="t(`validation.levelHelp.${level}`)"
            />
            <DsSelect
              v-model="action"
              :label="t('validation.action')"
              :options="actionOptions"
              :disabled="!canWrite"
              :hint="t(`validation.actionHelp.${action}`)"
            />
          </div>
          <div v-if="canWrite && restorable" class="flex justify-end border-t border-line pt-3">
            <DsButton size="sm" variant="ghost" :icon="History" :disabled="saving" @click="restore">
              {{ t('validation.restore') }}
            </DsButton>
          </div>
        </div>
      </DsCard>
      <DsCallout v-if="testError" tone="danger">{{ testError }}</DsCallout>
      <DsCard v-if="tested" data-validation-test :title="t('validation.testTitle')">
        <div class="flex flex-col gap-3">
          <DsCallout :tone="failingTone">
            {{
              unknownFailing
                ? t('validation.failingUnknown', { total: number(tested.total) })
                : tested.failing === null
                  ? t('validation.failingAtLeast', {
                      n: number(tested.failingAtLeast ?? 0),
                      total: number(tested.total),
                    })
                  : t('validation.failing', { n: number(tested.failing), total: number(tested.total) })
            }}
          </DsCallout>
          <div v-if="sampleRows.length" class="max-h-96 overflow-auto rounded-lg border border-line">
            <DocumentJsonList :rows="sampleRows" :can-write="false" />
          </div>
        </div>
      </DsCard>
    </div>
  </div>
</template>
