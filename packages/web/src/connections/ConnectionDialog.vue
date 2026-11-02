<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { ChevronRight } from 'lucide-vue-next'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { connectionsApi, queryKeys, type ConnectionDto, type TestResult } from '@/api/connections'
import { forgetAnswer } from '@/connections/reachability'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { isRenderedConnectionField } from './fieldPaths'
import {
  SECTIONS,
  emptyForm,
  formFromDto,
  inputFromForm,
  isMasked,
  patchFromForm,
  sectionOf,
  settingsFromForm,
  type Section,
} from './formModel'
import { provideConnectionForm } from './formContext'
import { useConnectionString } from './connectionString'
import { useFormErrors } from './formErrors'
import TestResultView from './TestResultView.vue'
import DockerLoopbackHint from './DockerLoopbackHint.vue'
import { unreachableKind } from './dockerHost'
import ConnectionQuickFields from './ConnectionQuickFields.vue'
import GeneralSection from './sections/GeneralSection.vue'
import ServerSection from './sections/ServerSection.vue'
import AuthSection from './sections/AuthSection.vue'
import TlsSection from './sections/TlsSection.vue'
import SshSection from './sections/SshSection.vue'
import AdvancedSection from './sections/AdvancedSection.vue'
import EncryptionSection from './sections/EncryptionSection.vue'

const props = defineProps<{ connection?: ConnectionDto; duplicate?: boolean }>()
const emit = defineEmits<{ close: []; saved: [connection: ConnectionDto, created: boolean] }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const toasts = useToastStore()
const dialogs = useDialogStore()

const SECTION_VIEWS = {
  general: GeneralSection,
  server: ServerSection,
  auth: AuthSection,
  tls: TlsSection,
  ssh: SshSection,
  encryption: EncryptionSection,
  advanced: AdvancedSection,
}

const editing = computed(() => props.connection !== undefined && !props.duplicate)
const form = reactive(
  props.connection
    ? formFromDto(
        props.connection,
        props.duplicate ? { duplicateName: (name) => t('connection.copyName', { name }) } : {},
      )
    : emptyForm(),
)
const section = ref<Section>('server')
/**
 * User request 2026-10-16: a new connection is its string, name and colour; the sections wait under
 * Advanced options, open when an existing connection is edited or when what is missing is in there.
 */
const advanced = ref(editing.value)
const advancedId = useId()
const testResult = ref<TestResult | null>(null)
const {
  fields,
  general,
  reset,
  showError: showFormError,
  errorFor,
} = useFormErrors({
  isRendered: isRenderedConnectionField,
})
const initial = JSON.stringify(form)

// A pinned SSH host key belongs to one SSH host and port: drop it while they differ, restore it when they match.
const pinned = { host: form.ssh.host, port: form.ssh.port, fingerprint: form.ssh.hostFingerprint }
watch(
  () => [form.ssh.host.trim(), form.ssh.port.trim()] as const,
  ([host, port]) => {
    if (!pinned.fingerprint) return
    const same = host === pinned.host && port === pinned.port
    if (!same && form.ssh.hostFingerprint === pinned.fingerprint) form.ssh.hostFingerprint = ''
    else if (same && !form.ssh.hostFingerprint) form.ssh.hostFingerprint = pinned.fingerprint
  },
)

// Section tabs follow the WAI-ARIA tabs pattern (roving tabindex, arrow keys).
const tabsId = useId()
const tabId = (s: Section) => `${tabsId}-tab-${s}`
function onTabKeydown(event: KeyboardEvent, index: number): void {
  const moves: Record<string, number> = {
    ArrowDown: index + 1,
    ArrowRight: index + 1,
    ArrowUp: index - 1,
    ArrowLeft: index - 1,
    Home: 0,
    End: SECTIONS.length - 1,
  }
  const next = moves[event.key]
  if (next === undefined) return
  event.preventDefault()
  const target = SECTIONS[(next + SECTIONS.length) % SECTIONS.length]!
  section.value = target
  void nextTick(() => document.getElementById(tabId(target))?.focus())
}

/** Closing with unsaved edits asks first: a long form is easy to lose with one Escape. */
async function requestClose(): Promise<void> {
  if (JSON.stringify(form) === initial && !connectionString.unread()) return emit('close')
  const discard = await dialogs.confirm({
    title: t('connection.discardTitle'),
    message: t('connection.discardMessage'),
    confirmLabel: t('connection.discard'),
    danger: true,
  })
  if (discard) emit('close')
}

const connectionString = useConnectionString(form, editing.value, t)
onBeforeUnmount(connectionString.dispose)
function openSection(target: Section, field?: string): void {
  advanced.value = true
  section.value = target
  if (field)
    void nextTick(() =>
      formEl.value?.querySelector<HTMLInputElement>(`[data-connection-field="${field}"]`)?.focus(),
    )
}
provideConnectionForm({
  form,
  connectionString,
  editing: editing.value,
  focusName: editing.value || props.duplicate === true,
  openSection,
  errorFor,
  secretHint: (value) => (isMasked(value) ? t('connection.secretKept') : undefined),
})

const title = computed(() =>
  t(editing.value ? 'connection.edit' : props.duplicate ? 'connection.duplicate' : 'connection.new'),
)
// The name is at the head of the form, in no section (review I1).
const errorSections = computed(
  () =>
    new Set(
      Object.keys(fields.value)
        .filter((key) => key !== 'name')
        .map(sectionOf),
    ),
)

/**
 * User report 2026-10-16: Test needs a host and Save a name too (and, editing, a change); until then
 * they are off and a line under them says what is missing.
 */
const emptyHost = computed(() => form.hosts.findIndex((h) => h.host.trim() === ''))
const hasHost = computed(() => form.hosts.length > 0 && emptyHost.value === -1)
const named = computed(() => form.name.trim() !== '')
const changed = computed(() => JSON.stringify(form) !== initial)
// A string typed but not read yet is read by Test and Save themselves (it may name the host and the name).
const unread = computed(() => connectionString.text.value.trim() !== '' && connectionString.unread())
const canTest = computed(() => unread.value || hasHost.value)
const canSave = computed(
  () => unread.value || (named.value && hasHost.value && (!editing.value || changed.value)),
)
const needsId = useId()
// Closed, Advanced options hide the host: the head of the form asks for a connection string (review I2).
const needs = computed(() =>
  unread.value
    ? ''
    : !hasHost.value
      ? advanced.value
        ? t(named.value ? 'connection.needs.host' : 'connection.needs.nameAndHost')
        : t(named.value ? 'connection.needs.string' : 'connection.needs.nameAndString')
      : !named.value
        ? t('connection.needs.name')
        : editing.value && !changed.value
          ? t('connection.needs.change')
          : '',
)
/** The form's own fields only: a page cell behind the dialog can carry the same name (review). */
const formEl = ref<HTMLFormElement | null>(null)
const resultEl = ref<HTMLElement | null>(null)
/** Enter, or a click on Test or Save, with something missing goes to what is missing. */
function goToMissing(forTest = false): void {
  // Save asks for the name first (it leads the form); Test needs only a host.
  const field =
    !forTest && !named.value ? 'name' : !hasHost.value ? `host-${Math.max(emptyHost.value, 0)}` : null
  if (!field) return
  if (field !== 'name' && !advanced.value) {
    // Nothing to connect to, and the host is hidden: the string is asked for where it is typed.
    connectionString.require(t('connection.needs.stringField'))
    void nextTick(() =>
      formEl.value?.querySelector<HTMLInputElement>('[data-connection-field="uri"]')?.focus(),
    )
    return
  }
  if (field !== 'name') section.value = 'server'
  void nextTick(() =>
    formEl.value?.querySelector<HTMLInputElement>(`[data-connection-field="${field}"]`)?.focus(),
  )
}
/** A connection string typed but not read yet is read first; refused, nothing is sent. */
async function readStringFirst(): Promise<boolean> {
  if (!connectionString.unread()) return true
  const ok = await connectionString.flush()
  if (!ok) {
    void nextTick(() =>
      formEl.value?.querySelector<HTMLInputElement>('[data-connection-field="uri"]')?.focus(),
    )
  }
  return ok
}
async function trySave(): Promise<void> {
  if (saving.value) return
  if (!(await readStringFirst())) return
  if (canSave.value) save()
  else goToMissing()
}
async function tryTest(): Promise<void> {
  if (testing.value) return
  if (!(await readStringFirst())) return
  if (canTest.value) runTest()
  else goToMissing(true)
}

/** Shows the error and jumps to the section of the first invalid field. */
function showError(e: unknown): void {
  showFormError(e)
  // The name is at the head of the form, not in a section.
  const first = Object.keys(fields.value).find((key) => key !== 'name')
  if (first) {
    section.value = sectionOf(first)
    advanced.value = true
  }
  // The field said to be wrong takes the focus (review M6).
  void nextTick(() => formEl.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
}

const { mutate: runTest, isPending: testing } = useMutation({
  mutationFn: () =>
    connectionsApi.test(settingsFromForm(form), editing.value ? props.connection!.id : undefined),
  onMutate: () => {
    reset()
    testResult.value = null
  },
  onSuccess: (result) => {
    testResult.value = result
    // Below an open Advanced options it may be out of the dialog's view (review I4).
    void nextTick(() => resultEl.value?.scrollIntoView?.({ block: 'nearest' }))
    // Trust on first use: remember the SSH host key seen now; a later change is refused (spec §4.3).
    if (result.ok && result.sshFingerprint && form.ssh.enabled && !form.ssh.hostFingerprint) {
      form.ssh.hostFingerprint = result.sshFingerprint
    }
  },
  onError: showError,
})

const { mutate: save, isPending: saving } = useMutation({
  mutationFn: () =>
    editing.value
      ? connectionsApi.update(props.connection!.id, patchFromForm(form))
      : connectionsApi.create(inputFromForm(form)),
  onMutate: reset,
  onSuccess: async (saved) => {
    // Its old settings' answer is not this one's: not connected until read again (fourth review, I2).
    if (editing.value) forgetAnswer(queryClient, saved.id)
    await queryClient.invalidateQueries({ queryKey: queryKeys.connections })
    toasts.push({ kind: 'success', message: t(editing.value ? 'connection.updated' : 'connection.created') })
    emit('saved', saved, !editing.value)
    emit('close')
  },
  onError: showError,
})

function trustKey(fingerprint: string): void {
  form.ssh.hostFingerprint = fingerprint
  testResult.value = null
}
</script>

<template>
  <DsDialog open :title="title" size="lg" align="top" @close="requestClose">
    <form ref="formEl" class="flex flex-col gap-5" novalidate @submit.prevent="trySave()">
      <ConnectionQuickFields />
      <div class="border-t border-line pt-3">
        <button
          :id="`${advancedId}-toggle`"
          type="button"
          data-advanced-toggle
          class="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 text-left text-ui font-medium text-fg transition-colors duration-120 hover:text-accent-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          :aria-expanded="advanced ? 'true' : 'false'"
          :aria-controls="advanced ? advancedId : undefined"
          @click="advanced = !advanced"
        >
          <ChevronRight
            class="size-4 shrink-0 text-fg-subtle transition-transform duration-120 motion-reduce:transition-none"
            :class="advanced ? 'rotate-90' : ''"
            aria-hidden="true"
          />
          <span>{{ t('connection.advancedOptions') }}</span>
          <span class="min-w-0 truncate text-small font-normal text-fg-subtle">{{
            t('connection.advancedSummary')
          }}</span>
          <span v-if="!advanced && errorSections.size" class="ml-auto flex shrink-0 items-center">
            <span class="size-2 rounded-full bg-danger" aria-hidden="true" />
            <span class="sr-only">{{ t('connection.advancedHasErrors') }}</span>
          </span>
        </button>
      </div>
      <div
        v-if="advanced"
        :id="advancedId"
        class="grid gap-6 sm:min-h-[22rem] sm:grid-cols-[11rem_minmax(0,1fr)]"
      >
        <div
          role="tablist"
          aria-orientation="vertical"
          :aria-labelledby="`${advancedId}-toggle`"
          class="flex gap-1 overflow-x-auto sm:flex-col"
        >
          <button
            v-for="(s, i) in SECTIONS"
            :id="tabId(s)"
            :key="s"
            type="button"
            role="tab"
            :aria-selected="section === s"
            :aria-controls="`${tabsId}-panel`"
            :tabindex="section === s ? 0 : -1"
            class="flex h-8 shrink-0 cursor-pointer items-center justify-between gap-2 rounded-lg px-3 text-left text-ui transition-colors duration-120"
            :class="
              section === s
                ? 'bg-accent-soft font-medium text-accent-fg'
                : 'text-fg-muted hover:bg-subtle hover:text-fg'
            "
            @click="section = s"
            @keydown="onTabKeydown($event, i)"
          >
            {{ t(`connection.sections.${s}`) }}
            <span
              v-if="errorSections.has(s)"
              class="size-2 shrink-0 rounded-full bg-danger"
              aria-hidden="true"
            />
          </button>
        </div>
        <div
          :id="`${tabsId}-panel`"
          role="tabpanel"
          :aria-labelledby="tabId(section)"
          class="flex min-w-0 flex-col gap-4"
        >
          <component :is="SECTION_VIEWS[section]" />
        </div>
      </div>
      <!-- Enables Enter-to-save in any field. -->
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <DsFormErrors class="mt-4" :messages="general" />
    <div ref="resultEl">
      <TestResultView v-if="testResult" class="mt-4" :result="testResult" @trust="trustKey" />
      <!-- User report 2026-11-02: a failed test in Docker, its host localhost (the Server section,
           when open, says it already). -->
      <DockerLoopbackHint
        v-if="
          testResult &&
          !testResult.ok &&
          unreachableKind(testResult.error.kind) &&
          !(advanced && section === 'server')
        "
        class="mt-3"
      />
    </div>
    <template #footer>
      <div class="mr-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <DsButton
          :loading="testing"
          :aria-disabled="canTest ? undefined : 'true'"
          :aria-describedby="canTest ? undefined : needsId"
          @click="tryTest()"
          >{{ t('connection.test') }}</DsButton
        >
        <p :id="needsId" role="status" class="text-small text-fg-subtle">{{ needs }}</p>
      </div>
      <DsButton @click="requestClose">{{ t('common.cancel') }}</DsButton>
      <DsButton
        variant="primary"
        :loading="saving"
        :aria-disabled="canSave ? undefined : 'true'"
        :aria-describedby="canSave ? undefined : needsId"
        @click="trySave()"
        >{{ editing ? t('connection.save') : t('connection.saveAndConnect') }}</DsButton
      >
    </template>
  </DsDialog>
</template>
