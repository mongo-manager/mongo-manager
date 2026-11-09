<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import {
  EXTERNAL_DB,
  MIN_DB_PASSWORD,
  isBroadRoleRef,
  type DbRoleView,
  type DbUserView,
  type RoleRef,
} from '@mongo-manager/shared/browser'
import DsSheet from '@/ds/DsSheet.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { accessKeys, databaseAccessApi } from '@/api/databaseAccess'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import PasswordField from './PasswordField.vue'
import RoleRefsEditor from './RoleRefsEditor.vue'
import { adminErrorText, isBroadRefusal } from './errors'

/**
 * W3.1: a MongoDB user — made (its database, name, a SCRAM-SHA-256 password typed or generated,
 * its roles) or changed (a new password, its roles). Granting a role that rules the deployment, and
 * changing the account the connection signs in with, are confirmed first.
 */
const props = defineProps<{
  connectionId: string
  existing?: DbUserView
  databases: readonly string[]
  customRoles: readonly DbRoleView[]
}>()
const emit = defineEmits<{ close: []; saved: [user: DbUserView] }>()
const { t } = useI18n()
const dialogs = useDialogStore()
const toasts = useToastStore()
const queryClient = useQueryClient()

const db = ref(props.existing?.db ?? 'admin')
const user = ref(props.existing?.user ?? '')
const password = ref('')
const changePassword = ref(!props.existing)
const roles = ref<RoleRef[]>(props.existing ? props.existing.roles.map((r) => ({ ...r })) : [])
const saving = ref(false)
const errors = ref<string[]>([])
const external = computed(() => db.value === EXTERNAL_DB)
const dbOptions = computed(() => {
  const names = new Set(['admin', ...props.databases.filter((d) => d !== 'local' && d !== 'config')])
  return [
    ...[...names].map((d) => ({ value: d, label: d === 'admin' ? t('dbAccess.users.adminDb') : d })),
    { value: EXTERNAL_DB, label: t('dbAccess.users.externalDb') },
  ]
})
const title = computed(() =>
  props.existing
    ? t('dbAccess.users.editTitle', { user: props.existing.user })
    : t('dbAccess.users.addTitle'),
)
const rolesChanged = computed(
  () =>
    JSON.stringify(roles.value.map((r) => `${r.role}@${r.db}`).sort()) !==
    JSON.stringify((props.existing?.roles ?? []).map((r) => `${r.role}@${r.db}`).sort()),
)
const dirty = computed(() => !!password.value || rolesChanged.value || (!props.existing && !!user.value))

function check(): string[] {
  const out: string[] = []
  if (!props.existing && !user.value.trim()) out.push(t('dbAccess.users.nameRequired'))
  if (!external.value && changePassword.value && password.value.length < MIN_DB_PASSWORD)
    out.push(t('dbAccess.password.tooShort', { min: MIN_DB_PASSWORD }))
  if (props.existing && !rolesChanged.value && !(changePassword.value && password.value))
    out.push(t('dbAccess.users.nothingChanged'))
  return out
}

/** W3 review (M4): a built-in role over the deployment, or a custom role that holds or inherits one. */
const isBroad = (r: RoleRef) =>
  isBroadRoleRef(r) || props.customRoles.some((c) => c.role === r.role && c.db === r.db && c.broad)
const anyBroad = computed(() => roles.value.some(isBroad))

async function confirmPowerful(): Promise<boolean> {
  const before = new Set((props.existing?.roles ?? []).map((r) => `${r.role}@${r.db}`))
  const added = roles.value.filter((r) => isBroad(r) && !before.has(`${r.role}@${r.db}`))
  if (!added.length) return true
  return dialogs.confirm({
    title: t('dbAccess.users.powerfulTitle'),
    message: t('dbAccess.users.powerfulMessage', {
      user: user.value.trim(),
      roles: added.map((r) => t('dbAccess.roles.on', { role: r.role, db: r.db })).join(', '),
    }),
    confirmLabel: t('dbAccess.users.powerfulConfirm'),
    danger: true,
  })
}

async function confirmOwn(): Promise<boolean> {
  return dialogs.confirm({
    title: t('dbAccess.own.title'),
    message: t('dbAccess.own.message', { user: user.value }),
    confirmLabel: t('dbAccess.own.confirm'),
    danger: true,
  })
}

async function save(): Promise<void> {
  errors.value = check()
  if (errors.value.length || saving.value) return
  if (!(await confirmPowerful())) return
  const own = props.existing?.own === true
  if (own && !(await confirmOwn())) return
  saving.value = true
  const send = (broad: boolean) =>
    props.existing
      ? databaseAccessApi.updateUser(props.connectionId, props.existing.db, props.existing.user, {
          ...(changePassword.value && password.value ? { password: password.value } : {}),
          ...(rolesChanged.value ? { roles: roles.value, ...(broad ? { confirmBroad: true } : {}) } : {}),
          ...(own ? { confirmOwn: true } : {}),
        })
      : databaseAccessApi.createUser(props.connectionId, {
          db: db.value,
          user: user.value.trim(),
          ...(external.value ? {} : { password: password.value }),
          roles: roles.value,
          ...(broad ? { confirmBroad: true } : {}),
        })
  try {
    let saved
    try {
      saved = await send(anyBroad.value)
    } catch (e) {
      // Re-review (1): broad rights the page could not see (a role of a database not listed).
      if (anyBroad.value || !isBroadRefusal(e)) throw e
      const ok = await dialogs.confirm({
        title: t('dbAccess.users.powerfulTitle'),
        message: t('dbAccess.users.powerfulFound', { user: user.value.trim() }),
        confirmLabel: t('dbAccess.users.powerfulConfirm'),
        danger: true,
      })
      if (!ok) return
      saved = await send(true)
    }
    // The password goes with the form: nothing keeps it once saved.
    password.value = ''
    await queryClient.invalidateQueries({ queryKey: accessKeys.all(props.connectionId) })
    toasts.push({
      kind: 'success',
      message: props.existing
        ? t('dbAccess.users.updated', { user: saved.user })
        : t('dbAccess.users.created', { user: saved.user, db: saved.db }),
    })
    emit('saved', saved)
    emit('close')
  } catch (e) {
    errors.value = [adminErrorText(e, t)]
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <DsSheet
    open
    :title="title"
    :subtitle="t('dbAccess.users.sheetSubtitle')"
    :dirty="dirty"
    @close="emit('close')"
  >
    <form class="flex max-w-2xl flex-col gap-5" data-user-editor @submit.prevent="save">
      <DsFormErrors :messages="errors" />
      <DsCallout v-if="existing?.own" tone="warning">{{ t('dbAccess.own.callout') }}</DsCallout>
      <section class="flex flex-col gap-4">
        <h3 class="text-ui font-semibold text-fg">{{ t('dbAccess.users.identity') }}</h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <DsSelect
            v-if="!existing"
            v-model="db"
            :label="t('dbAccess.users.authDb')"
            :hint="t('dbAccess.users.authDbHint')"
            :options="dbOptions"
          />
          <DsInput v-else :model-value="existing.db" :label="t('dbAccess.users.authDb')" mono readonly />
          <DsInput
            v-if="!existing"
            v-model="user"
            :label="t('dbAccess.users.name')"
            mono
            autocomplete="off"
            spellcheck="false"
            maxlength="256"
          />
          <DsInput v-else :model-value="existing.user" :label="t('dbAccess.users.name')" mono readonly />
        </div>
      </section>
      <section v-if="!external" class="flex flex-col gap-3">
        <h3 class="text-ui font-semibold text-fg">{{ t('dbAccess.password.title') }}</h3>
        <DsCheckbox v-if="existing" v-model="changePassword" :label="t('dbAccess.password.change')" />
        <PasswordField v-if="changePassword" v-model="password" :label="t('dbAccess.password.label')" />
        <p class="text-small text-fg-subtle">{{ t('dbAccess.password.never') }}</p>
      </section>
      <DsCallout v-else tone="info">{{ t('dbAccess.users.externalHelp') }}</DsCallout>
      <section class="flex flex-col gap-3">
        <h3 class="text-ui font-semibold text-fg">{{ t('dbAccess.users.roles') }}</h3>
        <p class="text-small text-fg-subtle">{{ t('dbAccess.users.rolesHelp') }}</p>
        <RoleRefsEditor v-model="roles" :custom-roles="customRoles" :databases="databases" />
      </section>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <div class="flex justify-end gap-2">
        <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
        <DsButton variant="primary" :loading="saving" data-save-user @click="save">{{
          existing ? t('dbAccess.users.save') : t('dbAccess.users.create')
        }}</DsButton>
      </div>
    </template>
  </DsSheet>
</template>
