<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { safeNext } from '@/workspace/tabRoutes'
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AuthLayout from './AuthLayout.vue'
import DsButton from '@/ds/DsButton.vue'
import { useSessionStore } from '@/stores/session'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const busy = ref(false)

/** Only an in-app path may come back from the query string. */
function nextPath(): string {
  return safeNext(route.query.next) ?? '/'
}

async function retry(): Promise<void> {
  busy.value = true
  session.ready = false
  try {
    await router.replace(nextPath())
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthLayout
    v-if="session.blockedAddress !== null"
    data-blocked
    :title="t('unavailable.blockedTitle')"
    :subtitle="t('unavailable.blockedBody', { address: session.blockedAddress || '?' })"
  >
    <DsButton data-test="retry" variant="primary" :loading="busy" @click="retry">{{
      t('unavailable.retry')
    }}</DsButton>
  </AuthLayout>
  <AuthLayout v-else :title="t('unavailable.title')" :subtitle="t('unavailable.body')">
    <DsButton data-test="retry" variant="primary" :loading="busy" @click="retry">{{
      t('unavailable.retry')
    }}</DsButton>
  </AuthLayout>
</template>
