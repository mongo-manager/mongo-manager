<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, LogOut, UserX } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCard from '@/ds/DsCard.vue'
import DsStatusDot from '@/ds/DsStatusDot.vue'
import { connectionsApi, type ConnectionDto } from '@/api/connections'
import { describeError } from '@/api/errors'
import { useOidcSignInStore } from '@/stores/oidcSignIn'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'

/**
 * W7 (completion): this person's OIDC sign-in on a connection — whether they are signed in, and
 * with whom — to sign in or out; in team mode its administrators see who is signed in and can end
 * every sign-in at once.
 */
const props = defineProps<{ connection: ConnectionDto }>()
const { t, locale } = useI18n()
const signIn = useOidcSignInStore()
const session = useSessionStore()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()
const key = computed(() => ['connections', props.connection.id, 'oidc'] as const)

const status = useQuery({ queryKey: key, queryFn: () => connectionsApi.oidcStatus(props.connection.id) })
const manage = computed(() => session.status?.mode === 'team' && session.can('connections:manage'))
const sessions = useQuery({
  queryKey: computed(() => ['connections', props.connection.id, 'oidc', 'sessions'] as const),
  queryFn: () => connectionsApi.oidcSessions(props.connection.id),
  enabled: manage,
})
const signOut = useMutation({
  mutationFn: () => connectionsApi.oidcSignOut(props.connection.id),
  onSuccess: () => {
    toasts.push({ kind: 'success', message: t('connection.oidc.signedOut') })
    void queryClient.invalidateQueries({ queryKey: key.value })
  },
  onError: (e) => toasts.push({ kind: 'error', message: describeError(e, t) }),
})
const revokeAll = useMutation({
  mutationFn: () => connectionsApi.oidcRevokeAll(props.connection.id),
  onSuccess: () => {
    toasts.push({ kind: 'success', message: t('connection.oidc.revoked') })
    void queryClient.invalidateQueries({ queryKey: key.value })
  },
  onError: (e) => toasts.push({ kind: 'error', message: describeError(e, t) }),
})
async function confirmRevokeAll(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('connection.oidc.revokeAll'),
    message: t('connection.oidc.revokeAllConfirm', { name: props.connection.name }),
    confirmLabel: t('connection.oidc.revokeAll'),
    danger: true,
  })
  if (ok) revokeAll.mutate()
}
const date = (ms: number) => new Date(ms).toLocaleString(locale.value)
</script>

<template>
  <DsCard :title="t('connection.oidc.cardTitle')" data-test="oidc-card">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="flex items-center gap-2 text-ui">
        <DsStatusDot
          :state="status.data.value?.signedIn ? 'connected' : 'idle'"
          :label="
            status.data.value?.signedIn
              ? t('connection.oidc.signedInState')
              : t('connection.oidc.signedOutState')
          "
        />
        <span v-if="status.data.value?.signedIn">{{
          t('connection.oidc.signedInWith', { issuer: status.data.value.issuer ?? '' })
        }}</span>
        <span v-else>{{ t('connection.oidc.signedOutState') }}</span>
      </p>
      <div class="flex gap-2">
        <DsButton
          v-if="status.data.value?.signedIn"
          size="sm"
          :icon="LogOut"
          :loading="signOut.isPending.value"
          @click="signOut.mutate()"
          >{{ t('connection.oidc.signOut') }}</DsButton
        >
        <DsButton
          v-else
          size="sm"
          variant="primary"
          :icon="KeyRound"
          @click="signIn.request(connection.id)"
          >{{ t('connection.oidc.signIn') }}</DsButton
        >
      </div>
    </div>
    <template v-if="manage">
      <h3 class="mt-4 text-small font-medium text-fg-muted">{{ t('connection.oidc.people') }}</h3>
      <ul v-if="sessions.data.value?.length" class="mt-2 flex flex-col gap-1 text-ui">
        <li v-for="p in sessions.data.value" :key="p.userId" class="flex flex-wrap justify-between gap-2">
          <span>
            {{ p.username ?? p.userId }}
            <!-- Security review I6: as whom they signed in at the identity provider. -->
            <span
              v-if="p.signedInAs || p.subject"
              class="text-small text-fg-muted"
              data-test="oidc-signed-in-as"
            >
              {{ t('connection.oidc.signedInAs', { name: p.signedInAs ?? p.subject }) }}
            </span>
          </span>
          <span class="text-small text-fg-muted">{{ date(p.updatedAt) }}</span>
        </li>
      </ul>
      <p v-else class="mt-2 text-small text-fg-muted">{{ t('connection.oidc.nobody') }}</p>
      <DsButton
        v-if="sessions.data.value?.length"
        size="sm"
        variant="danger"
        class="mt-3"
        :icon="UserX"
        :loading="revokeAll.isPending.value"
        @click="confirmRevokeAll"
        >{{ t('connection.oidc.revokeAll') }}</DsButton
      >
    </template>
  </DsCard>
</template>
