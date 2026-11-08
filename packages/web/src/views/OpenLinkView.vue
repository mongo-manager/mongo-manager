<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AuthLayout from './AuthLayout.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { useSessionStore } from '@/stores/session'

/**
 * Security audit 2026-10-16 (important 2): local mode opens only from the one-time link Mongo
 * Manager printed when it started (or `mongo-manager open` makes). A browser without it sees how to
 * get one, never the data.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const busy = ref(false)
const expired = computed(() => route.query.link === 'expired')
/** Commands, the same in every language. */
const OPEN = 'mongo-manager open'
const SERVICE_OPEN = 'mongo-manager service open'

/** The link may have been opened in another tab since: read the session again. */
async function retry(): Promise<void> {
  busy.value = true
  session.ready = false
  try {
    await router.replace('/')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthLayout :title="t('openLink.title')" :subtitle="t('openLink.body')">
    <div class="flex flex-col gap-4" data-open-link>
      <DsCallout v-if="expired" tone="warning">{{ t('openLink.expired') }}</DsCallout>
      <!-- Second review (minor 4): why a browser that was in may be asked again. -->
      <p data-open-link-storage class="text-ui text-fg-muted">{{ t('openLink.storage') }}</p>
      <div class="flex flex-col gap-1.5">
        <p class="text-ui text-fg-muted">{{ t('openLink.how') }}</p>
        <code
          class="rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-ui text-fg select-all"
          >{{ OPEN }}</code
        >
      </div>
      <div class="flex flex-col gap-1.5">
        <p class="text-ui text-fg-muted">{{ t('openLink.service') }}</p>
        <code
          class="rounded-lg border border-line bg-subtle px-3 py-2 font-mono text-ui text-fg select-all"
          >{{ SERVICE_OPEN }}</code
        >
      </div>
      <DsButton data-test="retry" :loading="busy" @click="retry">{{ t('openLink.retry') }}</DsButton>
    </div>
  </AuthLayout>
</template>
