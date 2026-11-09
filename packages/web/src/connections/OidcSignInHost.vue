<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { KeyRound } from 'lucide-vue-next'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { connectionsApi, type OidcStatus } from '@/api/connections'
import { describeError } from '@/api/errors'
import { reasonMessage } from '@/api/reasons'
import { useOidcSignInStore } from '@/stores/oidcSignIn'
import { useToastStore } from '@/stores/toasts'
import { useConnectionCapabilities } from './capabilities'

/**
 * W7 (completion): signs this person in to a connection with OIDC. The identity provider's page
 * opens in this tab (authorization code with PKCE) and sends it back here; where its redirect cannot
 * reach this server, a code is entered at the provider instead (device flow) while this dialog
 * waits. No token ever reaches the browser.
 */
const { t } = useI18n()
const store = useOidcSignInStore()
const toasts = useToastStore()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const status = ref<OidcStatus | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const open = computed(() => store.connectionId !== null)
const device = computed(() => status.value?.device)

function stopPolling(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
}
function close(): void {
  stopPolling()
  status.value = null
  error.value = null
  pending.value = null
  deviceHosts.value = ''
  store.close()
}
const fail = (e: unknown) => {
  error.value = reasonMessage(e, t) ?? describeError(e, t)
}

/**
 * Security review I5: before the browser leaves for the identity provider, the person sees which
 * provider the MongoDB server named and which hosts their token will go to — and goes on only then.
 */
const pending = ref<{ authorizeUrl: string; issuerHost: string; tokenHosts: string } | null>(null)
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const deviceIssuer = computed(() => (device.value?.issuer ? hostOf(device.value.issuer) : null))
const deviceHosts = ref('')
// Security review I6: sign-in with a code is offered only where the server allows it.
// Asked once a sign-in is wanted (the host is on every page, the signed-out ones too).
const capabilities = useConnectionCapabilities(open)
// Offered once the server has said it may (not while its answer is still on its way).
const deviceAllowed = computed(() => capabilities.data.value?.oidc.deviceFlow === true)

async function withCode(): Promise<void> {
  const id = store.connectionId
  if (!id) return
  busy.value = true
  error.value = null
  try {
    const start = await connectionsApi.oidcStart(id, 'code', route.fullPath)
    if (start.flow === 'code')
      pending.value = {
        authorizeUrl: start.authorizeUrl,
        issuerHost: hostOf(start.issuer),
        tokenHosts: start.tokenHosts.join(', '),
      }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
function proceed(): void {
  if (pending.value) window.location.assign(pending.value.authorizeUrl)
}

async function poll(id: string): Promise<void> {
  try {
    status.value = await connectionsApi.oidcStatus(id)
  } catch (e) {
    fail(e)
    return
  }
  if (status.value.signedIn && status.value.device?.state === 'done') return done(id)
  if (status.value.device?.state === 'pending') timer = setTimeout(() => void poll(id), 3_000)
}

async function withDevice(): Promise<void> {
  const id = store.connectionId
  if (!id) return
  busy.value = true
  error.value = null
  try {
    const start = await connectionsApi.oidcStart(id, 'device')
    if (start.flow === 'device') {
      status.value = { signIn: 'person', signedIn: false, device: { ...start.device, issuer: start.issuer } }
      deviceHosts.value = start.tokenHosts.join(', ')
    }
    stopPolling()
    timer = setTimeout(() => void poll(id), 3_000)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

function done(id: string): void {
  toasts.push({ kind: 'success', message: t('connection.oidc.signedIn') })
  void queryClient.invalidateQueries({ queryKey: ['connections', id] })
  close()
}

watch(open, (isOpen) => {
  if (!isOpen) stopPolling()
})
onBeforeUnmount(stopPolling)

const KNOWN_ERRORS = new Set([
  'oidc_state',
  'oidc_denied',
  'oidc_token',
  'oidc_id_token',
  'oidc_issuer',
  'oidc_issuer_unreachable',
])
// Back from the identity provider: what it said, then the address without it.
watch(
  () => route.query,
  (q) => {
    if (q.oidc === undefined && q.oidc_error === undefined) return
    if (q.oidc === 'signed-in') toasts.push({ kind: 'success', message: t('connection.oidc.signedIn') })
    else if (typeof q.oidc_error === 'string')
      toasts.push({
        kind: 'error',
        message: t(`connection.oidc.errors.${KNOWN_ERRORS.has(q.oidc_error) ? q.oidc_error : 'oidc_error'}`),
      })
    const { oidc: _o, oidc_error: _e, ...rest } = q
    void router.replace({ query: rest })
  },
  { immediate: true },
)
</script>

<template>
  <DsDialog :open="open" :title="t('connection.oidc.signInTitle')" size="sm" @close="close">
    <div class="flex flex-col gap-3" data-test="oidc-sign-in">
      <p class="text-ui text-fg-muted">{{ t('connection.oidc.signInBody') }}</p>
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
      <template v-if="device">
        <p class="text-ui">{{ t('connection.oidc.deviceBody') }}</p>
        <p class="text-center font-mono text-2xl tracking-widest select-all" data-test="oidc-user-code">
          {{ device.userCode }}
        </p>
        <a
          :href="device.verificationUriComplete ?? device.verificationUri"
          target="_blank"
          rel="noopener noreferrer"
          class="text-center text-ui break-all text-accent-fg underline"
          >{{ device.verificationUri }}</a
        >
        <p v-if="device.state === 'pending'" role="status" class="text-small text-fg-muted">
          {{ t('connection.oidc.deviceWaiting') }}
        </p>
        <DsCallout v-else-if="device.state !== 'done'" tone="warning">
          {{ t(`connection.oidc.deviceStates.${device.state}`) }}
        </DsCallout>
      </template>
      <p v-if="device && deviceIssuer" class="text-small text-fg-muted" data-test="oidc-device-where">
        {{ t('connection.oidc.whereDevice', { issuer: deviceIssuer, hosts: deviceHosts }) }}
      </p>
      <template v-if="pending">
        <DsCallout tone="info" data-test="oidc-where">
          {{ t('connection.oidc.whereCode', { issuer: pending.issuerHost, hosts: pending.tokenHosts }) }}
        </DsCallout>
        <div class="flex flex-wrap justify-end gap-2">
          <DsButton variant="ghost" @click="pending = null">{{ t('common.cancel') }}</DsButton>
          <DsButton variant="primary" :icon="KeyRound" data-test="oidc-proceed" @click="proceed">
            {{ t('connection.oidc.proceed', { issuer: pending.issuerHost }) }}
          </DsButton>
        </div>
      </template>
      <div v-else class="flex flex-wrap justify-end gap-2">
        <DsButton v-if="deviceAllowed" variant="ghost" :disabled="busy" @click="withDevice">{{
          t('connection.oidc.withDevice')
        }}</DsButton>
        <DsButton variant="primary" :icon="KeyRound" :loading="busy" @click="withCode">
          {{ t('connection.oidc.withCode') }}
        </DsButton>
      </div>
    </div>
  </DsDialog>
</template>
