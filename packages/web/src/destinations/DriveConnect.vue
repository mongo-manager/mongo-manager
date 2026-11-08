<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CircleCheck,
  Copy,
  ExternalLink,
  FileJson,
  KeyRound,
  RotateCcw,
  TriangleAlert,
} from 'lucide-vue-next'
import type { DestinationView } from '@mongo-manager/shared/browser'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DsButton from '@/ds/DsButton.vue'
import { useDestinationError } from './errors'
import { useToastStore } from '@/stores/toasts'
import DsField from '@/ds/DsField.vue'
import DsSecretField from '@/ds/DsSecretField.vue'
import { DRAFT_KEY } from './useDestinationDraft'
import { DRIVE_KEY, useDriveSignIn } from './useDriveSignIn'
import DsCallout from '@/ds/DsCallout.vue'
import { docsPage } from '@/workspace/docs'

/**
 * Phase 3d-3b §2.4, D3: connect a Google account by device code (no redirect address needed) or use
 * a service account in a Shared Drive. The refresh token stays on the server; the page only learns
 * that the account is connected, and as whom. The sign-in itself lives in the editor (useDriveSignIn).
 */
const props = defineProps<{ part: 'auth' | 'connection'; existing?: DestinationView }>()
const { draft, identityChanged } = inject(DRAFT_KEY)!
const { t, locale } = useI18n()
const destinationError = useDestinationError()
const toasts = useToastStore()
const c = computed(() => draft.config as Record<string, unknown>)
const str = (k: string) => String(c.value[k] ?? '')
const set = (k: string, v: unknown) => (draft.config[k] = v)
const oauth = computed(() => str('auth') !== 'serviceAccount')
// Mounted on its own (no editor), the step keeps its own sign-in.
const signIn = inject(DRIVE_KEY, null) ?? useDriveSignIn(draft, props.existing, destinationError)
const { flow, flowStart, state, error, canConnect, connect, cancel } = signIn

const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 1000)
onBeforeUnmount(() => clearInterval(tick))

/** The shipped guide's Google Drive section, in the current language (offline docs, spec §3.6). */
const guideUrl = computed(
  () => new URL(docsPage(locale.value, 'backup.html#google-drive'), document.baseURI).href,
)
// Review 2026-10-13 (web): linked only when it is an https address (it comes from Google).
const signInUrl = computed(() => {
  const url = flow.value?.verificationUrl ?? ''
  return /^https:\/\//i.test(url) ? url : null
})
const left = computed(() => Math.max(0, (flow.value?.expiresAt ?? 0) - now.value))
const total = computed(() => Math.max(1, (flow.value?.expiresAt ?? 0) - flowStart.value))
const RADIUS = 18
const CIRC = 2 * Math.PI * RADIUS
const ring = computed(() => CIRC * (1 - Math.min(1, left.value / total.value)))
const leftText = computed(() => {
  const s = Math.ceil(left.value / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(flow.value!.userCode)
    toasts.push({ kind: 'success', message: t('destinations.drive.copied') })
  } catch {
    // The code stays on screen: nothing to say when the clipboard refuses.
  }
}

/**
 * Spec D3, final review: the JSON key is read in the browser only to name the account back; it is
 * never kept on screen (it holds a private key) — what was pasted, dropped or chosen is cleared at
 * once, and only "Key for <client_email>" stays, with Replace.
 */
const MAX_KEY = 16_384
const keyId = useId()
const keyInput = ref<HTMLInputElement | null>(null)
const keyProblem = ref<'invalid' | 'tooLarge' | null>(null)
const dragging = ref(false)
const emailOf = (text: string): string | null => {
  try {
    const parsed = JSON.parse(text) as { type?: string; client_email?: string; private_key?: string }
    return parsed.type === 'service_account' && parsed.client_email && typeof parsed.client_email === 'string'
      ? parsed.client_email
      : null
  } catch {
    return null
  }
}
const keyEmail = computed(() =>
  draft.secrets.serviceAccountKey ? emailOf(draft.secrets.serviceAccountKey) : null,
)
const storedKey = computed(
  () =>
    Boolean(props.existing?.secrets.serviceAccountKey) &&
    draft.secrets.serviceAccountKey === null &&
    !identityChanged.value,
)
function takeKey(text: string): void {
  keyProblem.value = null
  if (text.length > MAX_KEY) keyProblem.value = 'tooLarge'
  else if (!emailOf(text)) keyProblem.value = text.trim() ? 'invalid' : null
  else draft.secrets.serviceAccountKey = text
}
function onKeyInput(e: Event): void {
  const el = e.target as HTMLInputElement
  const text = el.value
  el.value = ''
  takeKey(text)
}
function readFile(file: File | undefined): void {
  if (!file) return
  if (file.size > MAX_KEY) {
    keyProblem.value = 'tooLarge'
    return
  }
  void file.text().then(takeKey)
}
function onKeyFile(e: Event): void {
  const el = e.target as HTMLInputElement
  readFile(el.files?.[0])
  el.value = ''
}
function onDrop(e: DragEvent): void {
  dragging.value = false
  readFile(e.dataTransfer?.files?.[0])
}
async function replaceKey(): Promise<void> {
  draft.secrets.serviceAccountKey = ''
  keyProblem.value = null
  await nextTick()
  keyInput.value?.focus()
}
const fileInput = ref<HTMLInputElement | null>(null)
const section = 'flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5'
const linkBtn =
  'cursor-pointer rounded-md px-2 py-0.5 text-xs font-medium text-accent-fg hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none'
</script>

<template>
  <div
    v-if="part === 'auth'"
    class="grid gap-3 md:grid-cols-2"
    role="radiogroup"
    :aria-label="t('destinations.drive.auth')"
  >
    <DsChoiceCard
      :model-value="str('auth') || 'oauth'"
      name="drive-auth"
      value="oauth"
      :title="t('destinations.drive.oauth')"
      :help="t('destinations.drive.oauthHelp')"
      @update:model-value="(v: string) => set('auth', v)"
    />
    <DsChoiceCard
      :model-value="str('auth') || 'oauth'"
      name="drive-auth"
      value="serviceAccount"
      :title="t('destinations.drive.serviceAccount')"
      :help="t('destinations.drive.serviceAccountHelp')"
      @update:model-value="(v: string) => set('auth', v)"
    />
  </div>

  <template v-else>
    <section :class="section">
      <DsField v-model="draft.name" :label="t('destinations.editor.name')" />
      <DsField
        :model-value="str('folderName')"
        :label="t('destinations.drive.folderName')"
        @update:model-value="(v) => set('folderName', v)"
      />
    </section>

    <section v-if="oauth" :class="section">
      <DsField
        :model-value="str('clientId')"
        :label="t('destinations.drive.clientId')"
        :help="t('destinations.drive.clientHelp')"
        mono
        @update:model-value="(v) => set('clientId', v)"
      />
      <DsSecretField
        :label="t('destinations.drive.clientSecret')"
        :stored="Boolean(existing?.secrets.clientSecret)"
        :reenter="identityChanged"
        :model-value="draft.secrets.clientSecret ?? null"
        @update:model-value="(v) => (draft.secrets.clientSecret = v)"
      />
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>

      <div
        v-if="state === 'approved'"
        role="status"
        class="flex flex-wrap items-center gap-3 rounded-xl bg-success-soft px-4 py-3 text-ui text-success"
      >
        <CircleCheck class="size-5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 break-words">{{
          t('destinations.drive.connected', { account: draft.driveAccount ?? '' })
        }}</span>
        <DsButton size="sm" variant="ghost" :disabled="!canConnect" @click="connect">
          <RotateCcw class="size-4" aria-hidden="true" />{{ t('destinations.drive.again') }}
        </DsButton>
      </div>

      <div
        v-else-if="state === 'reconnect'"
        role="status"
        class="flex flex-wrap items-center gap-3 rounded-xl bg-warning-soft px-4 py-3 text-ui text-warning"
      >
        <TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 break-words">{{
          t('destinations.drive.reconnectNeeded', { account: draft.driveAccount ?? '' })
        }}</span>
        <DsButton size="sm" variant="primary" :disabled="!canConnect" @click="connect">
          <RotateCcw class="size-4" aria-hidden="true" />{{ t('destinations.drive.reconnect') }}
        </DsButton>
      </div>

      <Transition
        v-else-if="flow && state === 'waiting'"
        appear
        enter-active-class="transition duration-200 motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
      >
        <div
          class="flex flex-col items-center gap-4 rounded-2xl border border-accent bg-accent-soft/50 p-6 text-center"
        >
          <p class="text-ui text-fg-muted">
            {{ t('destinations.drive.goTo', { url: flow.verificationUrl }) }}
          </p>
          <div class="flex items-center gap-3">
            <code
              class="rounded-xl bg-surface px-5 py-3 font-mono text-3xl font-semibold tracking-[0.3em] text-fg shadow-xs"
              >{{ flow.userCode }}</code
            >
            <DsButton size="sm" variant="ghost" :aria-label="t('destinations.drive.copy')" @click="copyCode">
              <Copy class="size-4" aria-hidden="true" />
            </DsButton>
          </div>
          <a
            v-if="signInUrl"
            :href="signInUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-ui font-medium text-accent-fg hover:underline"
          >
            {{ flow.verificationUrl }}<ExternalLink class="size-3.5" aria-hidden="true" />
          </a>
          <div class="flex flex-wrap items-center justify-center gap-3 text-ui text-fg-muted">
            <svg
              class="size-11 -rotate-90"
              viewBox="0 0 44 44"
              role="img"
              :aria-label="t('destinations.drive.expiresIn', { time: leftText })"
            >
              <circle cx="22" cy="22" :r="RADIUS" fill="none" class="stroke-line" stroke-width="4" />
              <circle
                cx="22"
                cy="22"
                :r="RADIUS"
                fill="none"
                class="stroke-accent transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
                stroke-width="4"
                stroke-linecap="round"
                :stroke-dasharray="CIRC"
                :stroke-dashoffset="ring"
              />
            </svg>
            <span class="flex items-center gap-2">
              <span class="relative flex size-2">
                <span
                  class="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75 motion-reduce:animate-none"
                />
                <span class="relative inline-flex size-2 rounded-full bg-accent" />
              </span>
              {{ t('destinations.drive.waiting') }}
            </span>
            <DsButton size="sm" variant="ghost" @click="cancel">{{
              t('destinations.drive.cancel')
            }}</DsButton>
          </div>
        </div>
      </Transition>

      <div
        v-else-if="state === 'denied' || state === 'expired'"
        role="alert"
        class="flex items-center gap-3 text-ui text-danger"
      >
        <span class="flex-1">{{ t(`destinations.drive.${state}`) }}</span>
        <DsButton size="sm" :disabled="!canConnect" @click="connect">{{
          t('destinations.drive.again')
        }}</DsButton>
      </div>

      <DsButton
        v-else
        class="self-start"
        variant="primary"
        :disabled="!canConnect"
        :loading="state === 'starting'"
        @click="connect"
      >
        <KeyRound class="size-4" aria-hidden="true" />{{ t('destinations.drive.connect') }}
      </DsButton>
      <p
        v-if="!canConnect && state !== 'waiting' && state !== 'starting'"
        class="-mt-2 text-small text-fg-subtle"
      >
        {{ t('destinations.drive.needsClient') }}
      </p>
      <a
        :href="guideUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 self-start text-ui font-medium text-accent-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        {{ t('destinations.drive.guide') }}<ExternalLink class="size-3.5" aria-hidden="true" />
      </a>
    </section>

    <section v-else :class="section">
      <DsField
        :model-value="str('sharedDriveId')"
        :label="t('destinations.drive.sharedDrive')"
        mono
        @update:model-value="(v) => set('sharedDriveId', v)"
      />
      <div class="flex flex-col gap-1.5 text-ui">
        <span :id="`${keyId}-label`" class="font-medium text-fg">{{ t('destinations.drive.key') }}</span>
        <div
          v-if="storedKey || keyEmail"
          role="group"
          :aria-labelledby="`${keyId}-label`"
          class="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-fg-muted"
        >
          <KeyRound class="size-4 shrink-0 text-success" aria-hidden="true" />
          <span class="min-w-0 flex-1 break-all" data-key-for>{{
            keyEmail ? t('destinations.drive.keyFor', { email: keyEmail }) : t('destinations.secret.stored')
          }}</span>
          <button
            type="button"
            :class="linkBtn"
            :aria-label="t('destinations.secret.replaceNamed', { name: t('destinations.drive.key') })"
            @click="replaceKey"
          >
            {{ t('destinations.secret.replace') }}
          </button>
        </div>
        <template v-else>
          <div
            class="flex flex-col gap-3 rounded-xl border-2 border-dashed p-4 transition-colors duration-150"
            :class="dragging ? 'border-accent bg-accent-soft/60' : 'border-line-strong'"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <div class="flex items-center gap-3">
              <FileJson class="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <input
                ref="keyInput"
                type="password"
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('destinations.drive.key')"
                :aria-describedby="`${keyId}-help`"
                :placeholder="t('destinations.drive.keyPaste')"
                class="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-ui focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
                @input="onKeyInput"
                @drop.prevent.stop="onDrop"
              />
              <DsButton size="sm" variant="secondary" @click="fileInput?.click()">{{
                t('destinations.drive.keyChoose')
              }}</DsButton>
              <input
                ref="fileInput"
                type="file"
                accept="application/json,.json"
                class="sr-only"
                tabindex="-1"
                :aria-label="t('destinations.drive.keyFile')"
                @change="onKeyFile"
              />
            </div>
            <p :id="`${keyId}-help`" class="text-small text-fg-subtle">
              {{ t('destinations.drive.keyDrop') }}
            </p>
          </div>
          <p
            v-if="existing?.secrets.serviceAccountKey && identityChanged"
            class="text-small text-warning"
            data-reenter
          >
            {{ t('destinations.secret.reenter') }}
          </p>
          <p v-if="keyProblem" role="alert" class="text-small text-danger">
            {{
              keyProblem === 'tooLarge'
                ? t('destinations.drive.keyTooLarge')
                : t('destinations.drive.keyInvalid')
            }}
          </p>
        </template>
      </div>
    </section>
  </template>
</template>
