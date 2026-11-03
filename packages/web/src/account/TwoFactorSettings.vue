<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'
import TotpPanel from './TotpPanel.vue'
import PasskeysPanel from './PasskeysPanel.vue'
import RecoveryPanel from './RecoveryPanel.vue'
import RecoveryCodesDialog from './RecoveryCodesDialog.vue'

const { t } = useI18n()
const session = useSessionStore()
const enabled = computed(() => session.me?.twoFactor.enabled ?? false)
/** Shown once, then dropped from memory. */
const codes = ref<string[] | null>(null)
</script>

<template>
  <div class="flex flex-col gap-5">
    <p class="flex items-center gap-2 text-ui">
      <span
        class="rounded px-2 py-0.5 text-small font-medium"
        :class="enabled ? 'bg-success-soft text-success' : 'bg-muted text-fg-muted'"
      >
        {{ enabled ? t('security.on') : t('security.off') }}
      </span>
      {{ t('security.intro') }}
    </p>
    <TotpPanel @recovery-codes="codes = $event" />
    <hr class="border-line" />
    <PasskeysPanel @recovery-codes="codes = $event" />
    <hr class="border-line" />
    <RecoveryPanel @recovery-codes="codes = $event" />
    <RecoveryCodesDialog v-if="codes" :codes="codes" @close="codes = null" />
  </div>
</template>
