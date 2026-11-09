<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { ShieldCheck } from 'lucide-vue-next'
import type { DestinationType, DestinationView, TestStep } from '@mongo-manager/shared/browser'
import DsSheet from '@/ds/DsSheet.vue'
import DsStepper, { type StepItem } from '@/ds/DsStepper.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { destinationKeys, destinationsApi } from '@/api/destinations'
import { extraOf, reasonOf, useDestinationError, useFixHint } from './errors'
import { useToastStore } from '@/stores/toasts'
import TypePicker from './TypePicker.vue'
import S3Fields from './S3Fields.vue'
import WebdavFields from './WebdavFields.vue'
import FolderFields from './FolderFields.vue'
import AzureFields from './AzureFields.vue'
import GcsFields from './GcsFields.vue'
import SftpFields from './SftpFields.vue'
import DriveConnect from './DriveConnect.vue'
import AccessStep from './AccessStep.vue'
import TestChecklist from './TestChecklist.vue'
import { DRAFT_KEY, useDestinationDraft, type Step } from './useDestinationDraft'
import { DRIVE_KEY, useDriveSignIn } from './useDriveSignIn'

/** Phase 3d-3b D2: Type → Provider → Connection → Access → Test and save, in a full-height sheet. */
const props = defineProps<{ existing?: DestinationView; startType?: DestinationType }>()
const emit = defineEmits<{ close: []; saved: [destination: DestinationView] }>()
const { t } = useI18n()
const destinationError = useDestinationError()
const fixHint = useFixHint()
/** Short names review 6 (I-1): a refusal, and its fix where there is one, in the editor itself. */
const refusal = (e: unknown) =>
  [destinationError(e, draft.type), fixHint(reasonOf(e), draft.type, extraOf(e))].filter(Boolean)
const toasts = useToastStore()
const queryClient = useQueryClient()
const sheet = ref<InstanceType<typeof DsSheet> | null>(null)
const controller = useDestinationDraft(props.existing)
// The step components inject the draft instead of mutating a prop.
provide(DRAFT_KEY, controller)
const { draft, setType, body, patch, identityChanged, connectionReady, connectionKey, connectionChanged } =
  controller
if (props.startType && !props.existing) setType(props.startType)
// The Drive sign-in outlives its step: stepping back and forth keeps a waiting code (final review).
provide(DRIVE_KEY, useDriveSignIn(draft, props.existing, destinationError))
/**
 * Phase 3d-3b final review: a create whose access list then failed is saved — the editor carries on
 * as an edit of it, and Save retries what is left instead of creating it twice (name_taken).
 */
const created = ref<DestinationView | null>(null)
let createdKey = ''
let createdBody = ''
const saved = computed(() => props.existing ?? created.value ?? undefined)

const STEPS: Step[] = ['type', 'provider', 'connection', 'access', 'test']
/** The kinds with a provider or a sign-in to choose first; the others start at the connection. */
const WITH_PROVIDER = new Set(['s3', 'webdav', 'gdrive'])
const step = ref<Step>(
  props.existing
    ? 'connection'
    : props.startType
      ? WITH_PROVIDER.has(props.startType)
        ? 'provider'
        : 'connection'
      : 'type',
)
const steps = computed<Step[]>(() => STEPS.filter((s) => s !== 'provider' || WITH_PROVIDER.has(draft.type)))
const test = ref<TestStep[] | null>(null)
/** The connection settings the shown result was measured with: any other settings make it stale. */
const testedKey = ref('')
const stale = computed(() => test.value !== null && testedKey.value !== connectionKey())
const testing = ref(false)
let testAbort: AbortController | null = null
const saving = ref(false)
const askUntested = ref(false)
const askBox = ref<HTMLElement | null>(null)
const askId = useId()
const errors = ref<string[]>([])
const opened = JSON.stringify(draft)
const dirty = computed(() => JSON.stringify(draft) !== opened)
// A change after a test makes the test stale.
watch(
  () => JSON.stringify([draft.config, draft.secrets]),
  () => {
    if (!testing.value) test.value = null
  },
)
// The question before an untested save takes the focus (its safe answer first).
watch(askUntested, async (on) => {
  if (!on) return
  await nextTick()
  askBox.value?.querySelector<HTMLElement>('button')?.focus()
})
onBeforeUnmount(() => testAbort?.abort())

const stepItems = computed<StepItem[]>(() =>
  steps.value.map((id, i) => ({
    id,
    label: t(`destinations.editor.steps.${id}`),
    state:
      id === step.value ? 'current' : saved.value || i < steps.value.indexOf(step.value) ? 'done' : 'todo',
  })),
)
const go = (d: number) => {
  const i = steps.value.indexOf(step.value) + d
  step.value = steps.value[Math.max(0, Math.min(steps.value.length - 1, i))]!
}
const canNext = computed(() => step.value !== 'connection' || connectionReady.value)
const passed = computed(() => (!stale.value && test.value?.every((s) => s.ok)) ?? false)

/** W4.5: trusting the host key an SFTP test showed pins it; the test runs again with it. */
function trustHostKey(key: string): void {
  draft.config.hostFingerprint = key
  void runTest()
}
async function runTest(): Promise<void> {
  testAbort?.abort()
  const abort = (testAbort = new AbortController())
  const key = connectionKey()
  testing.value = true
  errors.value = []
  test.value = null
  try {
    // C1: a saved destination is tested with its stored secrets — as stored (and its status recorded)
    // when only its name, access or policy changed, else with the changed settings merged over them.
    const base = saved.value
    const result = base
      ? await destinationsApi.testSaved(
          base.id,
          created.value ? connectionSinceCreate() : connectionChanged.value ? patch.value : undefined,
          { signal: abort.signal },
        )
      : await destinationsApi.test(body.value, { signal: abort.signal })
    test.value = result.steps
    testedKey.value = key
  } catch (e) {
    if (!abort.signal.aborted) errors.value = refusal(e)
  } finally {
    if (testAbort === abort) {
      testing.value = false
      testAbort = null
    }
  }
}
const connectionSinceCreate = () => (connectionKey() !== createdKey ? patch.value : undefined)

async function save(force = false): Promise<void> {
  if (!connectionReady.value) {
    step.value = 'connection'
    return
  }
  if (test.value && !passed.value && !force) {
    askUntested.value = true
    return
  }
  saving.value = true
  errors.value = []
  try {
    const base = saved.value
    let result: DestinationView
    if (props.existing) result = await destinationsApi.update(props.existing.id, patch.value)
    else if (created.value)
      // Created already: only what changed since is sent again.
      result =
        JSON.stringify(body.value) !== createdBody
          ? await destinationsApi.update(created.value.id, patch.value)
          : created.value
    else {
      result = await destinationsApi.create(body.value)
      created.value = result
      createdKey = connectionKey()
      createdBody = JSON.stringify(body.value)
    }
    const grants = draft.grants.map((g) => ({ userId: g.userId, level: g.level }))
    const before = JSON.stringify(
      ((base ?? result).grants ?? []).map((g) => ({ userId: g.userId, level: g.level })),
    )
    if (JSON.stringify(grants) !== before)
      result = { ...result, grants: await destinationsApi.grants(result.id, grants) }
    await queryClient.invalidateQueries({ queryKey: destinationKeys.all })
    toasts.push({ kind: 'success', message: t('destinations.savedToast', { name: result.name }) })
    emit('saved', result)
    emit('close')
  } catch (e) {
    errors.value = refusal(e)
    // A destination created before the failure is in the list already.
    if (created.value) void queryClient.invalidateQueries({ queryKey: destinationKeys.all })
  } finally {
    saving.value = false
    askUntested.value = false
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault()
    // C13: the shortcut follows Next: an incomplete step is not skipped.
    if (e.key === 'ArrowLeft') go(-1)
    else if (step.value !== 'test' && canNext.value) go(1)
  }
}
const title = computed(() =>
  saved.value
    ? t('destinations.editor.titleEdit', { name: saved.value.name })
    : t('destinations.editor.titleNew'),
)
</script>

<template>
  <DsSheet ref="sheet" open :title="title" :dirty="dirty" @close="emit('close')" @keydown="onKeydown">
    <template #stepper>
      <DsStepper :steps="stepItems" :label="t('backup.steps.label')" @select="(id) => (step = id as Step)" />
    </template>

    <div class="flex flex-col gap-5">
      <DsFormErrors :messages="errors" />
      <TypePicker
        v-if="step === 'type'"
        :model-value="draft.type"
        :disabled="Boolean(saved)"
        @update:model-value="setType"
      />
      <template v-else-if="step === 'provider'">
        <S3Fields v-if="draft.type === 's3'" part="provider" />
        <WebdavFields v-else-if="draft.type === 'webdav'" part="provider" />
        <DriveConnect v-else-if="draft.type === 'gdrive'" part="auth" />
      </template>
      <template v-else-if="step === 'connection'">
        <p
          v-if="identityChanged"
          role="status"
          class="rounded-xl bg-warning-soft px-4 py-3 text-ui text-warning"
        >
          {{ t('destinations.editor.identityChanged') }}
        </p>
        <FolderFields v-if="draft.type === 'folder'" />
        <S3Fields v-else-if="draft.type === 's3'" :existing="existing" part="connection" />
        <WebdavFields v-else-if="draft.type === 'webdav'" :existing="existing" part="connection" />
        <GcsFields v-else-if="draft.type === 'gcs'" :existing="existing" />
        <AzureFields v-else-if="draft.type === 'azure'" :existing="existing" />
        <SftpFields v-else-if="draft.type === 'sftp'" :existing="existing" />
        <DriveConnect v-else :existing="existing" part="connection" />
      </template>
      <AccessStep v-else-if="step === 'access'" />
      <section v-else class="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
        <TestChecklist
          :steps="test"
          :running="testing"
          :stale="stale"
          :type="draft.type"
          trustable
          @trust="trustHostKey"
        />
        <p v-if="stale" role="status" class="rounded-lg bg-warning-soft px-3 py-2 text-ui text-warning">
          {{ t('destinations.test.stale') }}
        </p>
        <DsButton class="self-start" :loading="testing" @click="runTest"
          ><ShieldCheck class="size-4" aria-hidden="true" />{{
            test ? t('destinations.test.again') : t('destinations.test.run')
          }}</DsButton
        >
        <div
          v-if="askUntested"
          ref="askBox"
          role="alertdialog"
          :aria-labelledby="`${askId}-title`"
          :aria-describedby="`${askId}-help`"
          class="flex flex-col gap-2 rounded-xl bg-warning-soft p-4 text-ui"
        >
          <p :id="`${askId}-title`" class="font-medium text-warning">
            {{ t('destinations.editor.saveUntested') }}
          </p>
          <p :id="`${askId}-help`" class="text-warning/80">
            {{ t('destinations.editor.saveUntestedHelp') }}
          </p>
          <div class="flex gap-2">
            <DsButton size="sm" variant="ghost" @click="askUntested = false">{{
              t('dataTransfer.cancel')
            }}</DsButton>
            <DsButton size="sm" variant="primary" @click="save(true)">{{
              t('destinations.editor.saveAnyway')
            }}</DsButton>
          </div>
        </div>
      </section>
    </div>

    <template #summary>
      <div class="flex flex-col gap-3 text-ui">
        <label class="flex items-start gap-3">
          <input v-model="draft.policy.encryptedOnly" type="checkbox" class="mt-0.5 size-4 accent-accent" />
          <span>
            <span class="font-medium text-fg">{{ t('destinations.editor.encryptedOnly') }}</span>
            <span class="block text-fg-subtle">{{ t('destinations.editor.encryptedOnlyHelp') }}</span>
          </span>
        </label>
        <TestChecklist
          v-if="step !== 'test' && test"
          :steps="test"
          :running="false"
          :stale="stale"
          :type="draft.type"
        />
      </div>
    </template>

    <template #footer>
      <DsButton v-if="steps.indexOf(step) > 0" variant="ghost" class="mr-auto" @click="go(-1)">{{
        t('dataTransfer.back')
      }}</DsButton>
      <DsButton variant="ghost" @click="sheet?.requestClose()">{{ t('dataTransfer.cancel') }}</DsButton>
      <DsButton v-if="step !== 'test'" variant="secondary" :disabled="!canNext" @click="go(1)">{{
        t('dataTransfer.next')
      }}</DsButton>
      <DsButton variant="primary" :loading="saving" :disabled="!connectionReady" @click="save()">{{
        t('destinations.editor.save')
      }}</DsButton>
    </template>
  </DsSheet>
</template>
