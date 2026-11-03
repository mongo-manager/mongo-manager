<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CircleAlert, CircleCheck } from 'lucide-vue-next'
import { MIN_MONGODB_VERSION } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import type { TestResult } from '@/api/connections'

withDefaults(
  defineProps<{
    result: TestResult
    /** Said aloud as it appears; off where a region of the page's own says it (the connection tab). */
    announce?: boolean
  }>(),
  { announce: true },
)
defineEmits<{ trust: [fingerprint: string] }>()
const { t } = useI18n()
</script>

<template>
  <div
    data-test="test-result"
    :role="announce ? 'status' : undefined"
    class="rounded-lg border px-3 py-2.5 text-ui"
    :class="
      result.ok
        ? 'border-success/25 bg-success-soft text-success'
        : 'border-danger/25 bg-danger-soft text-danger'
    "
  >
    <template v-if="result.ok">
      <p class="flex items-center gap-2">
        <CircleCheck class="size-4 shrink-0" aria-hidden="true" />
        {{
          t('connection.testOk', {
            version: result.serverVersion,
            topology: t(`connection.topology.${result.topology}`),
            ms: result.latencyMs,
          })
        }}
      </p>
      <p v-if="result.sshFingerprint" class="mt-1 font-mono text-small break-all">
        {{ t('connection.sshPinned', { fingerprint: result.sshFingerprint }) }}
      </p>
    </template>
    <template v-else>
      <p class="flex items-center gap-2 font-medium">
        <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
        {{ t(`mongo.kinds.${result.error.kind}`, { min: MIN_MONGODB_VERSION }) }}
      </p>
      <p class="mt-1 text-small break-words text-fg-muted">{{ result.error.message }}</p>
      <p v-if="result.error.remembered" data-test="test-remembered" class="mt-1 text-small text-fg-muted">
        {{ t('mongo.rememberedTest') }}
      </p>
      <p v-if="result.error.issuer" data-test="test-issuer" class="mt-1 text-small break-all text-fg-muted">
        {{ t('connection.oidc.testIssuer', { issuer: result.error.issuer }) }}
      </p>
      <div v-if="result.error.kind === 'ssh-host-key' && result.error.sshFingerprint" class="mt-2">
        <p class="font-mono text-small break-all">
          {{ t('connection.sshKeyChanged', { fingerprint: result.error.sshFingerprint }) }}
        </p>
        <DsButton
          size="sm"
          variant="danger"
          class="mt-2"
          @click="$emit('trust', result.error.sshFingerprint)"
        >
          {{ t('connection.trustNewKey') }}
        </DsButton>
      </div>
    </template>
  </div>
</template>
