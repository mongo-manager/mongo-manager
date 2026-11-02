<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ShieldBan } from 'lucide-vue-next'
import { SIGN_IN_BAN_HOURS, type SignInBan, type SignInBanHours } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { accountKeys, usersApi } from '@/api/account'
import { explainError } from '@/api/reasons'
import { ApiError } from '@/api/client'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'

/**
 * Sign-in bans (2026-10-30): the addresses refused at the sign-in, by their own failed attempts or by
 * an administrator. Blocking one asks nothing more; lifting a ban lets the address guess again, so it
 * asks for the administrator's password (and a second factor used lately). A server without bans
 * (404) shows no card.
 */
const { t, locale } = useI18n()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()
const bans = useQuery({ queryKey: accountKeys.bans, queryFn: usersApi.bans, retry: false })
const unknown = computed(() => bans.error.value instanceof ApiError && bans.error.value.status === 404)

/** "15 min", "6 h": short, so no language needs a plural form here. */
const span = (minutes: number) =>
  minutes < 60 ? t('errors.waitMinutes', { n: minutes }) : t('errors.waitHours', { n: minutes / 60 })
const rule = computed(() => {
  const r = bans.data.value?.rule
  return r
    ? t('users.bans.rule', {
        failures: r.failures,
        window: span(r.windowMinutes),
        steps: r.stepsMinutes.map(span).join(' → '),
      })
    : ''
})
const until = (ms: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
const why = (ban: SignInBan) =>
  ban.reason === 'manual'
    ? t('users.bans.byAdmin', { name: ban.by ?? '—' })
    : t('users.bans.byFailures', { n: ban.strikes })

const address = ref('')
const hours = ref<string>(String(SIGN_IN_BAN_HOURS[1]))
const durations = computed(() =>
  SIGN_IN_BAN_HOURS.map((h) => ({ value: String(h), label: t(`users.bans.for.h${h}`) })),
)
const blocking = ref(false)
const lifting = ref('')

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: accountKeys.bans })
}

async function block(): Promise<void> {
  const target = address.value.trim()
  if (!target) return
  blocking.value = true
  try {
    await usersApi.blockAddress(target, Number(hours.value) as SignInBanHours)
    address.value = ''
    toasts.push({ kind: 'success', message: t('users.bans.blocked', { address: target }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
  } finally {
    blocking.value = false
    await refresh()
  }
}

async function lift(ban: SignInBan): Promise<void> {
  const password = await dialogs.prompt({
    title: t('users.bans.liftTitle', { address: ban.address }),
    message: t('users.bans.liftMessage'),
    confirmLabel: t('users.bans.liftConfirm'),
    danger: true,
    input: { type: 'password', label: t('users.password'), autocomplete: 'current-password' },
  })
  if (!password) return
  lifting.value = ban.address
  try {
    if ((await withStepUp(() => usersApi.liftBan(ban.address, password))) === STEP_UP_DECLINED) return
    toasts.push({ kind: 'success', message: t('users.bans.lifted', { address: ban.address }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: explainError(e, t) })
  } finally {
    lifting.value = ''
    await refresh()
  }
}
</script>

<template>
  <section
    v-if="bans.data.value || (bans.isError.value && !unknown)"
    data-sign-in-bans
    class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
  >
    <header class="flex items-center gap-2.5">
      <span
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted"
        aria-hidden="true"
      >
        <ShieldBan class="size-4" />
      </span>
      <div class="min-w-0">
        <h3 class="text-ui font-semibold text-fg">{{ t('users.bans.title') }}</h3>
        <p class="text-small text-fg-subtle">{{ rule }}</p>
      </div>
    </header>
    <p
      v-if="!bans.data.value"
      data-sign-in-bans-error
      class="rounded-lg bg-subtle px-3 py-2 text-small text-fg-muted"
    >
      {{ explainError(bans.error.value, t) }}
    </p>
    <template v-else>
      <p v-if="bans.data.value.bans.length === 0" data-bans-empty class="text-small text-fg-muted">
        {{ t('users.bans.empty') }}
      </p>
      <ul v-else class="flex flex-col divide-y divide-line rounded-lg border border-line" data-bans-list>
        <li
          v-for="ban in bans.data.value.bans"
          :key="ban.address"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          data-ban
        >
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-mono text-ui text-fg" :title="ban.address">{{ ban.address }}</span>
            <span class="text-small text-fg-subtle">
              {{ why(ban) }} · {{ t('users.bans.until', { time: until(ban.until) }) }}
            </span>
          </div>
          <DsButton
            size="sm"
            variant="secondary"
            :loading="lifting === ban.address"
            :aria-label="t('users.bans.liftLabel', { address: ban.address })"
            @click="lift(ban)"
          >
            {{ t('users.bans.lift') }}
          </DsButton>
        </li>
      </ul>
      <p
        v-if="bans.data.value.total > bans.data.value.bans.length"
        data-bans-more
        class="text-small text-fg-subtle"
      >
        {{ t('users.bans.more', { shown: bans.data.value.bans.length, total: bans.data.value.total }) }}
      </p>
      <form class="flex flex-wrap items-end gap-2" data-ban-form @submit.prevent="block">
        <DsInput
          v-model="address"
          class="min-w-44 flex-1"
          :label="t('users.bans.address')"
          placeholder="203.0.113.7"
          mono
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
          :disabled="blocking"
        />
        <DsSelect
          v-model="hours"
          class="min-w-32"
          :label="t('users.bans.duration')"
          :options="durations"
          :disabled="blocking"
        />
        <DsButton type="submit" :disabled="!address.trim()" :loading="blocking">
          {{ t('users.bans.block') }}
        </DsButton>
      </form>
      <p class="text-small text-fg-subtle">{{ t('users.bans.hint') }}</p>
    </template>
  </section>
</template>
