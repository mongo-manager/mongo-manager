<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { KeyRound, Plus, Send, Trash2, Webhook } from 'lucide-vue-next'
import type { WebhookView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import DsDialog from '@/ds/DsDialog.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import { alertKeys, alertsApi } from '@/api/alerts'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { adminErrorText } from '@/dbaccess/errors'
import { deliveryError } from './labels'

/**
 * W3.3: webhooks — each an https address (plain http only inside the networks the operator
 * listed) and a signing secret made by the server, shown once when it is made or rotated. Every
 * delivery's body is signed: x-mm-signature is sha256=HMAC(secret, timestamp + "." + body).
 */
defineProps<{ webhooks: readonly WebhookView[] }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()
const name = ref('')
const url = ref('')
const errors = ref<string[]>([])
const adding = ref(false)
const secret = ref<{ name: string; secret: string } | null>(null)
const busy = ref<string | null>(null)
const refresh = () => queryClient.invalidateQueries({ queryKey: alertKeys.channels })

async function add(): Promise<void> {
  errors.value = []
  if (!name.value.trim() || !url.value.trim()) {
    errors.value = [t('alerts.webhooks.required')]
    return
  }
  adding.value = true
  try {
    const made = await alertsApi.createWebhook({ name: name.value.trim(), url: url.value.trim() })
    secret.value = { name: made.name, secret: made.secret! }
    name.value = url.value = ''
    await refresh()
  } catch (e) {
    errors.value = [adminErrorText(e, t)]
  } finally {
    adding.value = false
  }
}
async function test(w: WebhookView): Promise<void> {
  busy.value = w.id
  try {
    const r = await alertsApi.testWebhook(w.id)
    toasts.push(
      r.ok
        ? { kind: 'success', message: t('alerts.webhooks.testOk', { name: w.name }) }
        : {
            kind: 'error',
            message: t('alerts.webhooks.testFailed', {
              name: w.name,
              why: deliveryError(t, 'webhook', r.error),
            }),
          },
    )
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  } finally {
    busy.value = null
  }
}
async function rotate(w: WebhookView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('alerts.webhooks.rotateTitle', { name: w.name }),
    message: t('alerts.webhooks.rotateMessage'),
    confirmLabel: t('alerts.webhooks.rotate'),
    danger: true,
  })
  if (!ok) return
  try {
    const next = await alertsApi.patchWebhook(w.id, { rotateSecret: true })
    secret.value = { name: next.name, secret: next.secret! }
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}
async function remove(w: WebhookView): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('alerts.webhooks.deleteTitle', { name: w.name }),
    message: t('alerts.webhooks.deleteMessage'),
    confirmLabel: t('alerts.webhooks.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await alertsApi.deleteWebhook(w.id)
    await queryClient.invalidateQueries({ queryKey: alertKeys.all })
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}
async function toggle(w: WebhookView, enabled: boolean): Promise<void> {
  try {
    await alertsApi.patchWebhook(w.id, { enabled })
    await refresh()
  } catch (e) {
    toasts.push({ kind: 'error', message: adminErrorText(e, t) })
  }
}
</script>

<template>
  <div class="flex flex-col gap-4" data-webhooks>
    <ul v-if="webhooks.length" class="flex flex-col gap-2">
      <li
        v-for="w in webhooks"
        :key="w.id"
        class="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3"
      >
        <Webhook class="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate font-medium text-fg">{{ w.name }}</span>
          <span class="truncate font-mono text-small text-fg-subtle" :title="w.url">{{ w.url }}</span>
        </span>
        <DsSwitch
          :model-value="w.enabled"
          :label="t('alerts.webhooks.enabledFor', { name: w.name })"
          class="[&_label]:sr-only"
          @update:model-value="toggle(w, $event)"
        />
        <DsButton size="sm" :icon="Send" :loading="busy === w.id" @click="test(w)">{{
          t('alerts.webhooks.test')
        }}</DsButton>
        <DsIconButton
          size="sm"
          :icon="KeyRound"
          :label="t('alerts.webhooks.rotateNamed', { name: w.name })"
          @click="rotate(w)"
        />
        <DsIconButton
          size="sm"
          :icon="Trash2"
          :label="t('alerts.webhooks.deleteNamed', { name: w.name })"
          @click="remove(w)"
        />
      </li>
    </ul>
    <DsEmptyState
      v-else
      :icon="Webhook"
      :title="t('alerts.webhooks.emptyTitle')"
      :description="t('alerts.webhooks.empty')"
    />
    <form
      class="grid gap-2 rounded-lg bg-subtle p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
      @submit.prevent="add"
    >
      <DsFormErrors class="sm:col-span-3" :messages="errors" />
      <DsInput v-model="name" size="sm" maxlength="80" :label="t('alerts.webhooks.name')" />
      <DsInput
        v-model="url"
        size="sm"
        mono
        type="url"
        spellcheck="false"
        :label="t('alerts.webhooks.url')"
        placeholder="https://"
      />
      <DsButton type="submit" size="sm" :icon="Plus" :loading="adding">{{
        t('alerts.webhooks.add')
      }}</DsButton>
    </form>
    <p class="text-small text-fg-subtle">{{ t('alerts.webhooks.signing') }}</p>
    <DsDialog
      v-if="secret"
      open
      persistent
      size="md"
      :title="t('alerts.webhooks.secretTitle', { name: secret.name })"
    >
      <div class="flex flex-col gap-3">
        <p class="text-ui text-fg-muted">{{ t('alerts.webhooks.secretHelp') }}</p>
        <DsCodeBlock :code="secret.secret" :copy-label="t('alerts.webhooks.copy')" data-webhook-secret />
        <p class="text-small text-fg-subtle">{{ t('alerts.webhooks.verifyHelp') }}</p>
      </div>
      <template #footer>
        <DsButton variant="primary" @click="secret = null">{{ t('alerts.webhooks.secretDone') }}</DsButton>
      </template>
    </DsDialog>
  </div>
</template>
