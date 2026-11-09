<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'
import { useRouter } from 'vue-router'
import { api, setLocalKey } from '@/api/client'
import SettingsCard from './SettingsCard.vue'
import BackupKeysPanel from './BackupKeysPanel.vue'
import ChangePasswordForm from './ChangePasswordForm.vue'
import PreferencesForm from './PreferencesForm.vue'
import ShortcutSettings from './ShortcutSettings.vue'
import TwoFactorSettings from './TwoFactorSettings.vue'
import { UserCog } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import { aiChatApi } from '@/api/aiChat'
import { describeError } from '@/api/errors'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import { useAssistantStore } from '@/ai/chat/store'

const { t } = useI18n()
const session = useSessionStore()
const router = useRouter()
const team = computed(() => session.status?.mode === 'team' && session.me !== null)

// UI redesign R5: a settings page — its sections listed on the side, each a card it takes you to.
type Section =
  'profile' | 'password' | 'security' | 'browsers' | 'keys' | 'aiChats' | 'preferences' | 'shortcuts'
const TEAM_ONLY: readonly Section[] = ['profile', 'password', 'security']
const LOCAL_ONLY: readonly Section[] = ['browsers']
const uid = useId()
const sectionId = (s: Section) => `${uid}-${s}`
const sections = computed(() =>
  (
    [
      ['profile', t('account.profile')],
      ['password', t('account.password.title')],
      ['security', t('security.title')],
      ['browsers', t('account.browsers.title')],
      ['keys', t('keys.title')],
      ['aiChats', t('account.aiChats.title')],
      ['preferences', t('account.preferences.title')],
      ['shortcuts', t('account.shortcuts.title')],
    ] as const
  ).filter(([id]) => (team.value ? !LOCAL_ONLY.includes(id) : !TEAM_ONLY.includes(id))),
)
const current = ref<Section | null>(null)
const scroller = ref<HTMLElement | null>(null)
// The section in view is the one marked in the list, as the page scrolls — except just after a
// click, while the page glides to the section that was asked for.
let following = true
let resume: ReturnType<typeof setTimeout> | undefined
async function go(id: Section): Promise<void> {
  current.value = id
  following = false
  clearTimeout(resume)
  await nextTick()
  const el = document.getElementById(sectionId(id))
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
  el?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
  resume = setTimeout(() => (following = true), 1200)
}
let observer: IntersectionObserver | null = null
function observe(): void {
  observer?.disconnect()
  if (typeof IntersectionObserver === 'undefined' || !scroller.value) return
  const visible = new Set<string>()
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id)
        else visible.delete(e.target.id)
      }
      if (!following) return
      const first = sections.value.find(([id]) => visible.has(sectionId(id)))
      if (first) current.value = first[0]
    },
    { root: scroller.value, rootMargin: '0px 0px -60% 0px' },
  )
  for (const [id] of sections.value) {
    const el = document.getElementById(sectionId(id))
    if (el) observer.observe(el)
  }
}
// Review of R3–R5, minor 1: a short last card is never the first in view, so at the end of the
// page the list marks it; and the glide to a chosen section ends the pause when it ends.
function onScroll(): void {
  const el = scroller.value
  if (!following || !el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    current.value = sections.value.at(-1)?.[0] ?? null
}
function onScrollEnd(): void {
  clearTimeout(resume)
  following = true
}
onMounted(() => {
  observe()
  scroller.value?.addEventListener('scroll', onScroll, { passive: true })
  scroller.value?.addEventListener('scrollend', onScrollEnd)
})
watch(sections, () => void nextTick(observe))
onBeforeUnmount(() => {
  observer?.disconnect()
  clearTimeout(resume)
  scroller.value?.removeEventListener('scroll', onScroll)
  scroller.value?.removeEventListener('scrollend', onScrollEnd)
})

/** Phase 4a-2 final review minor 8: chats can be deleted here, also by someone who lost the AI right. */
const dialogs = useDialogStore()
const toasts = useToastStore()

/**
 * Review of the audit fixes (important 1): local mode signs every browser out (this one too); each
 * opens the app again only from a new launch link.
 */
async function signOutBrowsers(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('account.browsers.confirmTitle'),
    message: t('account.browsers.confirmMessage'),
    confirmLabel: t('account.browsers.signOutAll'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.post('auth/local/sign-out-all')
    setLocalKey(undefined)
    session.ready = false
    await router.replace({ name: 'openLink' })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
async function deleteChats(): Promise<void> {
  const ok = await dialogs.confirm({
    title: t('account.aiChats.confirmTitle'),
    message: t('account.aiChats.confirmMessage'),
    confirmLabel: t('account.aiChats.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    const { removed } = await aiChatApi.removeAll()
    useAssistantStore().newChat()
    toasts.push({ kind: 'success', message: t('ai.chat.history.deletedAll', { n: removed }, removed) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-account-page>
    <DsPageHeader
      :title="t('tabs.account')"
      :icon="UserCog"
      :context="team ? session.me?.user.username : undefined"
      :facts="team && session.me ? [t(`overview.roles.${session.me.user.role}`)] : []"
    />
    <!-- User report 2026-10-29: positioned, so a card's absolutely placed parts (a screen reader's
         text, a checkbox's input) scroll with the list instead of stretching the window. -->
    <div ref="scroller" class="relative min-h-0 flex-1 overflow-auto">
      <div class="mx-auto grid max-w-5xl grid-cols-1 gap-6 px-6 py-5 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <!-- Languages (2026-10-29): a longer name (German, Russian) wraps in its column, never into the cards. -->
        <nav :aria-label="t('account.sections')" class="min-w-0 lg:sticky lg:top-5 lg:self-start">
          <ul class="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap">
            <li v-for="[id, title] in sections" :key="id" class="shrink-0 lg:shrink lg:min-w-0">
              <button
                type="button"
                :aria-current="current === id ? 'true' : undefined"
                class="w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-ui whitespace-nowrap transition-colors duration-120 lg:hyphens-auto lg:break-words lg:whitespace-normal focus-visible:outline-2 focus-visible:outline-focus"
                :class="
                  current === id
                    ? 'bg-accent-soft font-medium text-accent-fg'
                    : 'text-fg-muted hover:bg-subtle hover:text-fg'
                "
                @click="go(id)"
              >
                {{ title }}
              </button>
            </li>
          </ul>
        </nav>
        <div class="flex min-w-0 flex-col gap-5">
          <template v-if="team && session.me">
            <SettingsCard :id="sectionId('profile')" :title="t('account.profile')">
              <dl class="grid grid-cols-[8rem_1fr] gap-2 text-ui">
                <dt class="text-fg-subtle">{{ t('account.username') }}</dt>
                <dd class="font-medium">{{ session.me.user.username }}</dd>
                <dt class="text-fg-subtle">{{ t('account.role') }}</dt>
                <dd>{{ t(`overview.roles.${session.me.user.role}`) }}</dd>
              </dl>
            </SettingsCard>
            <SettingsCard :id="sectionId('password')" :title="t('account.password.title')">
              <ChangePasswordForm />
            </SettingsCard>
            <SettingsCard :id="sectionId('security')" :title="t('security.title')">
              <TwoFactorSettings />
            </SettingsCard>
          </template>
          <template v-else>
            <DsCallout tone="info">{{ t('account.localMode') }}</DsCallout>
            <!-- Review of the audit fixes (important 1): every browser that opened a launch link. -->
            <SettingsCard
              :id="sectionId('browsers')"
              :title="t('account.browsers.title')"
              :description="t('account.browsers.description')"
            >
              <DsButton data-sign-out-browsers variant="danger" @click="signOutBrowsers">{{
                t('account.browsers.signOutAll')
              }}</DsButton>
            </SettingsCard>
          </template>
          <!-- Phase 3d-3c: local mode has backup keys too. -->
          <SettingsCard :id="sectionId('keys')" :title="t('keys.title')" :description="t('keys.subtitle')">
            <BackupKeysPanel />
          </SettingsCard>
          <SettingsCard
            :id="sectionId('aiChats')"
            :title="t('account.aiChats.title')"
            :description="t('account.aiChats.description')"
          >
            <DsButton variant="danger" @click="deleteChats">{{ t('account.aiChats.delete') }}</DsButton>
          </SettingsCard>
          <SettingsCard :id="sectionId('preferences')" :title="t('account.preferences.title')">
            <PreferencesForm />
          </SettingsCard>
          <!-- W5: the global shortcuts, rebound by each user. -->
          <SettingsCard
            :id="sectionId('shortcuts')"
            :title="t('account.shortcuts.title')"
            :description="t('account.shortcuts.description')"
          >
            <ShortcutSettings />
          </SettingsCard>
        </div>
      </div>
    </div>
  </section>
</template>
