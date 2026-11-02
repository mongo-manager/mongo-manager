<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ShieldCheck } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { useTabsStore } from '@/stores/tabs'
import { openAccountTab } from '@/workspace/openTabs'
import { accountKeys, usersApi } from '@/api/account'
import { explainError } from '@/api/reasons'
import { useSessionStore } from '@/stores/session'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'

/**
 * Phase 4c §4: administrators must have 2FA — turned on only by an administrator who has it (so no
 * one is locked out), or forced by the server's configuration (shown, not to be turned off here).
 * Required 2FA (2026-10-28): everyone must, the same way. The administrators' own rule is shown as it
 * is stored meanwhile (final review I1), so turning "everyone" off never drops it unseen.
 */
type Which = 'admins' | 'everyone'
const { t } = useI18n()
const session = useSessionStore()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()
const id = useId()
const policy = useQuery({ queryKey: accountKeys.policy, queryFn: usersApi.policy })
/** The users' table's own list: how many would be held to the set-up (final review, minor 3). */
const users = useQuery({ queryKey: accountKeys.users, queryFn: usersApi.list })
const everyone = computed(() => policy.data.value?.everyoneTwoFactor ?? false)
const everyoneForced = computed(() => policy.data.value?.everyoneForced ?? false)
/** Older servers have no "everyone" policy: its switch is not shown. */
const hasEveryone = computed(() => policy.data.value?.everyoneTwoFactor !== undefined)
const admins = computed(() => policy.data.value?.adminTwoFactor ?? false)
const forced = computed(() => policy.data.value?.forced ?? false)
const required = computed(() => admins.value || everyone.value)
const selfHas = computed(() => session.me?.twoFactor.enabled ?? false)
/** Why a switch cannot be changed now, if it cannot. */
// User review 2026-10-30: why a switch is locked is said once — above the switches when it is the
// administrator's own missing 2FA, under the switch when it is the server's configuration.
const lockedAdmins = computed(() =>
  forced.value ? t('users.policy.forced') : !admins.value && !selfHas.value ? 'self' : null,
)
const lockedEveryone = computed(() =>
  everyoneForced.value ? t('users.policy.everyoneForced') : !everyone.value && !selfHas.value ? 'self' : null,
)
const needSelf = computed(() => lockedAdmins.value === 'self' || lockedEveryone.value === 'self')
const status = computed(() =>
  everyone.value
    ? t('users.policy.statusEveryone')
    : admins.value
      ? t('users.policy.statusAdmins')
      : t('users.policy.statusNone'),
)
const tabs = useTabsStore()
const saving = ref(false)
/** Bumped after a refused or abandoned change so the switches show the policy as it is. */
const drawn = ref(0)

async function redraw(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: accountKeys.policy })
  drawn.value++
}

/** Turning "everyone" on holds every active user without 2FA to the set-up: said first. */
async function confirmEveryone(): Promise<boolean> {
  const count = (users.data.value ?? []).filter((u) => !u.disabled && !(u.twoFactor ?? u.totpEnabled)).length
  return dialogs.confirm({
    title: t('users.policy.everyoneOnTitle'),
    message: t('users.policy.everyoneOnMessage', { count }),
    confirmLabel: t('users.policy.everyoneOnConfirm'),
  })
}

async function set(which: Which, on: boolean): Promise<void> {
  // 4c review I4: turning it off asks the administrator's password.
  let password: string | undefined
  if (on && which === 'everyone' && !(await confirmEveryone())) {
    await redraw()
    return
  }
  if (!on) {
    const message =
      which === 'everyone'
        ? [
            t('users.policy.everyoneOffMessage'),
            ...(admins.value ? [] : [t('users.policy.everyoneOffAdmins')]),
          ].join(' ')
        : t('users.policy.offMessage')
    const given = await dialogs.prompt({
      title: t('users.policy.offTitle'),
      message,
      confirmLabel: t('users.policy.offConfirm'),
      danger: true,
      input: { type: 'password', label: t('users.password'), autocomplete: 'current-password' },
    })
    if (!given) {
      await redraw()
      return
    }
    password = given
  }
  saving.value = true
  const change = which === 'everyone' ? { everyoneTwoFactor: on } : { adminTwoFactor: on }
  try {
    // Security audit 2026-10-16: turning it off takes a second factor proved lately too.
    if ((await withStepUp(() => usersApi.setPolicy(change, password))) === STEP_UP_DECLINED) {
      await redraw()
      return
    }
    await queryClient.invalidateQueries({ queryKey: accountKeys.policy })
    const key = which === 'everyone' ? (on ? 'everyoneOn' : 'everyoneOff') : on ? 'on' : 'off'
    toasts.push({ kind: 'success', message: t(`users.policy.${key}`) })
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
    await redraw()
  } finally {
    saving.value = false
  }
}

const switches = computed(() => [
  {
    which: 'admins' as const,
    label: t('users.policy.label'),
    hint: t('users.policy.hint'),
    checked: admins.value,
    locked: lockedAdmins.value,
    // Not a lock: the rule can still be set, to stay when "everyone" is turned off.
    note: everyone.value && !admins.value ? t('users.policy.coveredByEveryone') : null,
  },
  ...(hasEveryone.value
    ? [
        {
          which: 'everyone' as const,
          label: t('users.policy.everyoneLabel'),
          hint: t('users.policy.everyoneHint'),
          checked: everyone.value,
          locked: lockedEveryone.value,
          note: null,
        },
      ]
    : []),
])
/** Final review (minor 9): the hint, note and lock of a switch are its description. */
const describedBy = (s: { which: Which; locked: string | null; note: string | null }) =>
  [
    `${id}-${s.which}-hint`,
    ...(s.note ? [`${id}-${s.which}-note`] : []),
    ...(s.locked === 'self' ? [`${id}-self`] : s.locked ? [`${id}-${s.which}-lock`] : []),
  ].join(' ')
</script>

<template>
  <section data-admin-policy class="flex flex-col rounded-xl border border-line bg-surface shadow-xs">
    <header class="flex items-center gap-3 px-4 pt-4 pb-3">
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg"
        :class="required ? 'bg-accent-soft text-accent-fg' : 'bg-subtle text-fg-muted'"
        aria-hidden="true"
      >
        <ShieldCheck class="size-4" />
      </span>
      <div class="min-w-0">
        <h3 class="text-ui font-semibold text-fg">{{ t('users.policy.title') }}</h3>
        <p class="text-small text-fg-subtle" data-policy-status>{{ status }}</p>
      </div>
    </header>
    <div v-if="needSelf" class="px-4 pb-3">
      <DsCallout :id="`${id}-self`" tone="warning" data-policy-self>
        <span class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span>{{ t('users.policy.needSelf') }}</span>
          <DsButton size="sm" data-policy-setup @click="openAccountTab(tabs)">{{
            t('users.policy.setUp')
          }}</DsButton>
        </span>
      </DsCallout>
    </div>
    <ul class="divide-y divide-line border-t border-line">
      <li
        v-for="s in switches"
        :key="`${s.which}:${drawn}`"
        :data-policy="s.which"
        class="flex flex-col gap-2 px-4 py-3.5"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex min-w-0 flex-col gap-0.5">
            <label
              :for="`${id}-${s.which}`"
              class="text-ui font-medium text-fg"
              :class="s.locked || saving ? 'cursor-not-allowed' : 'cursor-pointer'"
              >{{ s.label }}</label
            >
            <p :id="`${id}-${s.which}-hint`" class="text-small text-fg-subtle">{{ s.hint }}</p>
          </div>
          <label
            class="mt-0.5 flex shrink-0"
            :class="s.locked || saving ? 'cursor-not-allowed' : 'cursor-pointer'"
          >
            <input
              :id="`${id}-${s.which}`"
              type="checkbox"
              role="switch"
              class="peer sr-only"
              :checked="s.checked"
              :aria-describedby="describedBy(s)"
              :disabled="!!s.locked || saving || policy.isPending.value"
              @change="set(s.which, ($event.target as HTMLInputElement).checked)"
            />
            <span
              aria-hidden="true"
              class="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors duration-160 peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:shadow-xs after:transition-transform after:duration-160 peer-checked:after:translate-x-4"
            />
          </label>
        </div>
        <p
          v-if="s.note"
          :id="`${id}-${s.which}-note`"
          data-policy-note
          class="rounded-lg bg-accent-soft px-3 py-2 text-small text-accent-fg"
        >
          {{ s.note }}
        </p>
        <p
          v-if="s.locked && s.locked !== 'self'"
          :id="`${id}-${s.which}-lock`"
          class="text-small text-fg-muted"
        >
          {{ s.locked }}
        </p>
      </li>
    </ul>
  </section>
</template>
