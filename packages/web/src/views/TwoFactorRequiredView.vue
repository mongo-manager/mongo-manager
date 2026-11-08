<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ArrowRight, LogOut, ShieldCheck } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import ProductMark from '@/workspace/ProductMark.vue'
import TwoFactorSettings from '@/account/TwoFactorSettings.vue'
import { useSessionStore } from '@/stores/session'
import { useSignOut } from '@/auth/signOut'

/**
 * Phase 4c §4: administrators (or, since required 2FA, everyone or this account) must have 2FA, and
 * this one has none yet — the set-up alone, nothing of
 * the workspace (the server refuses everything else until it is done), and a way to sign out.
 */
const { t } = useI18n()
const router = useRouter()
const session = useSessionStore()
const signOut = useSignOut()
const done = computed(() => !!session.me && !session.me.twoFactorRequired)
/** Required 2FA (2026-10-28): why — everyone, this account, or (as before) the administrators. */
const body = computed(() => {
  const by = session.me?.twoFactorRequiredBy
  return t(
    by === 'everyone'
      ? 'twoFactorRequired.bodyEveryone'
      : by === 'account'
        ? 'twoFactorRequired.bodyAccount'
        : 'twoFactorRequired.body',
  )
})
</script>

<template>
  <main class="min-h-full bg-canvas px-4 py-10 text-fg">
    <section data-two-factor-required class="mx-auto flex max-w-2xl flex-col gap-6">
      <header class="flex flex-col gap-4">
        <p class="flex items-center gap-2 text-ui font-semibold text-fg-muted">
          <ProductMark :size="22" />{{ t('app.name') }}
        </p>
        <div class="flex items-start gap-3">
          <span
            class="grid size-10 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning"
            aria-hidden="true"
          >
            <ShieldCheck class="size-5" />
          </span>
          <div class="min-w-0">
            <h1 class="text-title-l font-semibold">{{ t('twoFactorRequired.title') }}</h1>
            <p class="mt-1 text-ui text-fg-muted">{{ body }}</p>
          </div>
        </div>
      </header>
      <div class="rounded-card border border-line bg-surface p-5 shadow-xs">
        <TwoFactorSettings />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <DsButton variant="ghost" :icon="LogOut" @click="signOut()">{{
          t('twoFactorRequired.signOut')
        }}</DsButton>
        <DsButton
          v-if="done"
          variant="primary"
          :icon-right="ArrowRight"
          @click="router.push({ name: 'workspace' })"
        >
          {{ t('twoFactorRequired.continue') }}
        </DsButton>
      </div>
    </section>
  </main>
</template>
