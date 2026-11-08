<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { startRegistration } from '@simplewebauthn/browser'
import { KeyRound, Pencil, Trash2 } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { accountApi, accountKeys, type PasskeyInfo } from '@/api/account'
import { STEP_UP_DECLINED, withStepUp } from './stepUp'
import { ApiError } from '@/api/client'
import { explainError } from '@/api/reasons'
import { passkeyErrorKey, passkeysAvailable } from '@/auth/passkeys'
import { useDialogStore } from '@/stores/dialogs'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'

const emit = defineEmits<{ recoveryCodes: [codes: string[]] }>()
const { t, locale } = useI18n()
const queryClient = useQueryClient()
const dialogs = useDialogStore()
const session = useSessionStore()
const toasts = useToastStore()

const support = useQuery({ queryKey: accountKeys.passkeySupport, queryFn: accountApi.passkeySupport })
const list = useQuery({ queryKey: accountKeys.passkeys, queryFn: accountApi.passkeys })
const name = ref('')
const busy = ref(false)

/** Why passkeys cannot be added here, or null (Review Focus 2). */
const unavailable = computed(() => {
  const s = support.data.value
  if (s && !s.available)
    return s.reason === 'ip-address'
      ? t('security.passkeys.unavailableIp')
      : t('security.passkeys.unavailableInsecure')
  if (!passkeysAvailable()) return t('security.passkeys.unsupportedBrowser')
  return null
})

const date = (ms: number) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(ms)
const explain = (e: unknown) => (e instanceof ApiError ? explainError(e, t) : t(passkeyErrorKey(e)))

const refresh = () =>
  Promise.all([queryClient.invalidateQueries({ queryKey: accountKeys.passkeys }), session.refresh()])

const askPassword = (title: string, message = t('security.passwordPrompt')) =>
  dialogs.prompt({
    title,
    message,
    confirmLabel: t('common.continue'),
    input: { type: 'password', label: t('transfer.password') },
  })

async function add(): Promise<void> {
  if (busy.value || !name.value.trim()) return
  const password = await askPassword(t('security.passkeys.add'))
  if (!password) return
  busy.value = true
  try {
    const optionsJSON = await withStepUp(() => accountApi.passkeyOptions(password))
    if (optionsJSON === STEP_UP_DECLINED) return
    const response = await startRegistration({ optionsJSON })
    const result = await accountApi.addPasskey(name.value.trim(), response)
    name.value = ''
    await refresh()
    toasts.push({ kind: 'success', message: t('security.passkeys.added') })
    if (result.recoveryCodes) emit('recoveryCodes', result.recoveryCodes)
  } catch (e) {
    toasts.push({ kind: 'error', message: explain(e) })
  } finally {
    busy.value = false
  }
}

const menuItems = computed<DsMenuItem[]>(() => [
  { id: 'rename', label: t('security.passkeys.rename'), icon: Pencil },
  { id: 'remove', label: t('security.passkeys.remove'), icon: Trash2, danger: true },
])

async function onSelect(passkey: PasskeyInfo, action: string): Promise<void> {
  try {
    if (action === 'rename') {
      const next = await dialogs.prompt({
        title: t('security.passkeys.renameTitle'),
        message: t('security.passkeys.name'),
        confirmLabel: t('common.save'),
        input: { type: 'text', label: t('security.passkeys.name'), value: passkey.name },
      })
      if (!next?.trim()) return
      await accountApi.renamePasskey(passkey.id, next.trim())
      await refresh()
      toasts.push({ kind: 'success', message: t('security.passkeys.renamed') })
    } else {
      const password = await askPassword(
        t('security.passkeys.removeTitle'),
        t('security.passkeys.removeMessage', { name: passkey.name }),
      )
      if (!password) return
      if ((await withStepUp(() => accountApi.deletePasskey(passkey.id, password))) === STEP_UP_DECLINED)
        return
      await refresh()
      toasts.push({ kind: 'success', message: t('security.passkeys.removed') })
    }
  } catch (e) {
    toasts.push({ kind: 'error', message: explain(e) })
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="font-medium">{{ t('security.passkeys.title') }}</p>
    <p v-if="unavailable" role="note" class="rounded-lg bg-warning-soft p-3 text-ui text-warning">
      {{ unavailable }}
    </p>
    <p v-if="(list.data.value ?? []).length === 0" class="text-ui text-fg-subtle">
      {{ t('security.passkeys.none') }}
    </p>
    <ul v-else class="divide-y divide-line">
      <li v-for="passkey in list.data.value" :key="passkey.id" class="flex items-center gap-3 py-2">
        <KeyRound class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-ui font-medium">{{ passkey.name }}</p>
          <p class="text-small text-fg-subtle">
            {{ t('security.passkeys.addedOn', { date: date(passkey.createdAt) }) }} ·
            {{
              passkey.lastUsedAt
                ? t('security.passkeys.lastUsed', { date: date(passkey.lastUsedAt) })
                : t('security.passkeys.neverUsed')
            }}
          </p>
        </div>
        <DsMenu
          focusable
          :label="t('security.passkeys.actions', { name: passkey.name })"
          :items="menuItems"
          @select="onSelect(passkey, $event)"
        />
      </li>
    </ul>
    <form v-if="!unavailable" class="flex flex-wrap items-end gap-2" novalidate @submit.prevent="add">
      <DsInput
        v-model="name"
        class="min-w-60 flex-1"
        :label="t('security.passkeys.name')"
        :placeholder="t('security.passkeys.namePlaceholder')"
        autocomplete="off"
      />
      <DsButton type="submit" :loading="busy" :disabled="!name.trim()">{{
        t('security.passkeys.add')
      }}</DsButton>
    </form>
  </div>
</template>
