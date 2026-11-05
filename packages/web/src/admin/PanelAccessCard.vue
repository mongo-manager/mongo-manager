<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Network, Plus, X } from 'lucide-vue-next'
import { ACCESS_LIST_MAX, type AccessEntry, type AccessPreview } from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import { accountKeys, usersApi } from '@/api/account'
import { explainError } from '@/api/reasons'
import { ApiError } from '@/api/client'
import { formatRelative } from '@/format'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'
import { describeUserAgent } from './userAgent'

/**
 * Panel access (2026-10-30): the addresses the team-mode panel answers, set here — no reverse proxy
 * needed. Before saving the card shows who is signed in from where and who would be signed out, and
 * warns when the list leaves out the address the administrator is on. Saving asks for their
 * password (and a recent second factor); a list without their own address, also their word.
 */
const { t, locale } = useI18n()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()
const policy = useQuery({ queryKey: accountKeys.access, queryFn: usersApi.access, retry: false })
const unknown = computed(() => policy.error.value instanceof ApiError && policy.error.value.status === 404)

const draft = ref<AccessEntry[]>([])
const saved = computed(() => JSON.stringify(policy.data.value?.entries ?? []))
watch(
  () => policy.data.value?.entries,
  (entries) => (draft.value = (entries ?? []).map((e) => ({ ...e }))),
  { immediate: true },
)
const changed = computed(() => JSON.stringify(draft.value) !== saved.value)

// The preview of the draft, read again shortly after each change.
const preview = ref<AccessPreview | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let asked = 0
watch(
  draft,
  (entries) => {
    clearTimeout(timer)
    const mine = ++asked
    if (!changed.value) {
      preview.value = null
      return
    }
    timer = setTimeout(async () => {
      try {
        const answer = await usersApi.previewAccess(sendable(entries))
        if (mine === asked) preview.value = answer
      } catch {
        if (mine === asked) preview.value = null
      }
    }, 300)
  },
  { deep: true },
)
onBeforeUnmount(() => clearTimeout(timer))

const shown = computed(() => preview.value ?? policy.data.value)
/** The rows sent for a preview: those long enough to be an address (shorter ones are marked here). */
const longEnough = (e: AccessEntry) => e.range.trim().length >= 2
const sendable = (entries: AccessEntry[]) => entries.filter(longEnough)
/** Draft rows that do not read: too short here, or refused by the preview (it counts only those sent). */
const invalidRows = computed(() => {
  const rows = new Set(draft.value.flatMap((e, i) => (e.range.trim() !== '' && !longEnough(e) ? [i] : [])))
  const p = preview.value
  if (!p) return rows
  const sent = draft.value.map((e, i) => [e, i] as const).filter(([e]) => longEnough(e))
  for (const n of p.invalid) if (sent[n]) rows.add(sent[n][1])
  return rows
})
const leaving = computed(() => (shown.value?.sessions ?? []).filter((s) => !s.allowed))
const listOn = computed(() => draft.value.some((e) => e.range.trim() !== ''))
const state = computed(() => {
  const n = policy.data.value?.entries.length ?? 0
  return n === 0 ? t('users.access.open') : t('users.access.closed', { n }, n)
})

const newRange = ref('')
const newLabel = ref('')
function add(range = newRange.value, label = newLabel.value): void {
  const r = range.trim()
  if (!r || draft.value.length >= ACCESS_LIST_MAX) return
  if (!draft.value.some((e) => e.range === r)) draft.value.push({ range: r, label: label.trim() })
  newRange.value = ''
  newLabel.value = ''
}
function remove(i: number): void {
  draft.value.splice(i, 1)
}
const hasMine = computed(() => {
  const mine = policy.data.value?.yourRange
  return !!mine && draft.value.some((e) => e.range.trim().toLowerCase() === mine)
})
/** Review of panel access (I2): an IPv6 address rotates within its /64, which "my address" adds. */
const ipv6 = computed(() => policy.data.value?.yourAddress.includes(':') ?? false)

const when = (ms: number) => formatRelative(ms - Date.now(), locale.value)
const saving = ref(false)

async function save(): Promise<void> {
  if (invalidRows.value.size > 0) {
    toasts.push({ kind: 'error', message: t('users.access.invalid') })
    return
  }
  const entries = draft.value.filter((e) => e.range.trim() !== '')
  let check: AccessPreview
  try {
    check = await usersApi.previewAccess(entries)
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
    return
  }
  preview.value = check
  if (check.invalid.length > 0) {
    toasts.push({ kind: 'error', message: t('users.access.invalid') })
    return
  }
  const out = check.sessions.filter((s) => !s.allowed).length
  const lockMeOut = !check.youAllowed
  const password = await dialogs.prompt({
    title: lockMeOut ? t('users.access.lockTitle') : t('users.access.saveTitle'),
    message: [
      lockMeOut ? t('users.access.lockMessage', { address: check.yourAddress }) : '',
      entries.length === 0 ? t('users.access.openMessage') : t('users.access.saveMessage', { n: out }, out),
      t('users.access.passwordMessage'),
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: lockMeOut ? t('users.access.lockConfirm') : t('users.access.saveConfirm'),
    danger: lockMeOut || out > 0,
    input: { type: 'password', label: t('users.password'), autocomplete: 'current-password' },
  })
  if (!password) return
  saving.value = true
  try {
    const result = await withStepUp(() => usersApi.saveAccess(entries, password, lockMeOut))
    if (result === STEP_UP_DECLINED) return
    preview.value = null
    toasts.push({ kind: 'success', message: t('users.access.saved', { n: out }, out) })
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
  } finally {
    saving.value = false
    await queryClient.invalidateQueries({ queryKey: accountKeys.access })
  }
}
</script>

<template>
  <section
    v-if="policy.data.value || (policy.isError.value && !unknown)"
    data-panel-access
    class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
  >
    <header class="flex items-center gap-2.5">
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted"
        aria-hidden="true"
      >
        <Network class="size-4" />
      </span>
      <div class="min-w-0">
        <h3 class="text-ui font-semibold text-fg">{{ t('users.access.title') }}</h3>
        <p class="text-small text-fg-subtle">{{ state }}</p>
      </div>
    </header>
    <p v-if="!policy.data.value" class="rounded-lg bg-subtle px-3 py-2 text-small text-fg-muted">
      {{ explainError(policy.error.value, t) }}
    </p>
    <template v-else>
      <p class="text-small text-fg-muted" data-your-address>
        {{ t('users.access.yourAddress') }}
        <code class="rounded bg-subtle px-1.5 py-0.5 font-mono text-fg">{{
          policy.data.value.yourAddress
        }}</code>
      </p>
      <DsCallout v-if="shown?.untrustedProxy" tone="warning" data-access-proxy>
        {{ t('users.access.untrustedProxy') }}
      </DsCallout>

      <ul v-if="draft.length > 0" class="flex flex-col gap-2" data-access-entries>
        <li v-for="(entry, i) in draft" :key="i" class="flex flex-wrap items-end gap-2" data-access-entry>
          <DsInput
            v-model="entry.range"
            class="min-w-48 flex-[2]"
            mono
            maxlength="64"
            spellcheck="false"
            autocomplete="off"
            :label="t('users.access.range')"
            :hide-label="i > 0"
            :error="invalidRows.has(i) ? t('users.access.rangeInvalid') : undefined"
          />
          <DsInput
            v-model="entry.label"
            class="min-w-32 flex-1"
            maxlength="60"
            :label="t('users.access.label')"
            :hide-label="i > 0"
          />
          <DsIconButton
            :icon="X"
            :label="t('users.access.remove', { range: entry.range })"
            @click="remove(i)"
          />
        </li>
      </ul>
      <form class="flex flex-wrap items-end gap-2" data-access-add @submit.prevent="add()">
        <DsInput
          v-model="newRange"
          class="min-w-48 flex-[2]"
          mono
          maxlength="64"
          spellcheck="false"
          autocomplete="off"
          placeholder="203.0.113.0/24"
          :label="t('users.access.newRange')"
        />
        <DsInput v-model="newLabel" class="min-w-32 flex-1" maxlength="60" :label="t('users.access.label')" />
        <DsButton type="submit" :icon="Plus" :disabled="!newRange.trim()">{{
          t('users.access.add')
        }}</DsButton>
        <DsButton
          v-if="!hasMine"
          variant="ghost"
          data-add-mine
          @click="add(policy.data.value.yourRange, t('users.access.mine'))"
        >
          {{ t('users.access.addMine') }}
        </DsButton>
      </form>
      <p class="text-small text-fg-subtle">{{ t('users.access.hint') }}</p>
      <p v-if="ipv6" class="text-small text-fg-subtle" data-access-ipv6>
        {{ t('users.access.ipv6Mine', { range: policy.data.value.yourRange }) }}
      </p>

      <DsCallout v-if="changed && listOn" tone="info" data-access-info>
        {{ t('users.access.info') }}
      </DsCallout>
      <DsCallout v-if="changed && shown && !shown.youAllowed" tone="danger" data-access-lockout>
        {{ t('users.access.lockWarning', { address: shown.yourAddress }) }}
      </DsCallout>

      <div class="flex flex-col gap-1.5">
        <h4 class="text-small font-medium text-fg-muted">
          {{ t('users.access.sessions', { n: shown?.sessions.length ?? 0 }) }}
        </h4>
        <ul
          class="flex flex-col divide-y divide-line max-h-80 overflow-y-auto rounded-lg border border-line"
          data-access-sessions
        >
          <li
            v-for="(s, i) in shown?.sessions ?? []"
            :key="i"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            data-access-session
          >
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-ui text-fg">
                {{ s.username }}
                <span v-if="s.current" class="text-fg-subtle">({{ t('users.access.you') }})</span>
              </span>
              <span class="truncate text-small text-fg-subtle">
                <span class="font-mono">{{ s.ip ?? t('users.access.noAddress') }}</span>
                <template v-if="describeUserAgent(s.userAgent)">
                  · {{ describeUserAgent(s.userAgent) }}</template
                >
                · {{ t('users.access.lastSeen', { when: when(s.lastSeenAt) }) }}
              </span>
            </div>
            <DsBadge v-if="changed && !s.allowed" tone="danger" data-signed-out>
              {{ t('users.access.willSignOut') }}
            </DsBadge>
          </li>
        </ul>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <DsButton variant="primary" :disabled="!changed" :loading="saving" data-access-save @click="save">
          {{ t('users.access.save') }}
        </DsButton>
        <span v-if="changed && leaving.length > 0" class="text-small text-fg-muted" data-access-leaving>
          {{ t('users.access.leaving', { n: leaving.length }, leaving.length) }}
        </span>
      </div>
    </template>
  </section>
</template>
