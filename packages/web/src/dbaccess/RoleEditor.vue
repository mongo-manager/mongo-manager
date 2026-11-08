<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { Plus, Trash2 } from 'lucide-vue-next'
import {
  isBroadRoleRef,
  PRIVILEGE_ACTIONS,
  isBroadPrivilege,
  type DbRoleView,
  type Privilege,
  type PrivilegeActionGroup,
  type RoleRef,
} from '@mongo-manager/shared/browser'
import DsSheet from '@/ds/DsSheet.vue'
import DsButton from '@/ds/DsButton.vue'
import DsChip from '@/ds/DsChip.vue'
import DsCombobox from '@/ds/DsCombobox.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsInput from '@/ds/DsInput.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { accessKeys, databaseAccessApi } from '@/api/databaseAccess'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import RoleRefsEditor from './RoleRefsEditor.vue'
import { adminErrorText, isBroadRefusal } from './errors'

/**
 * W3.1: a custom role — its privileges (actions on a database and collection, the cluster, or any
 * resource) and the roles it inherits. Each privilege is a card; actions are picked from MongoDB's
 * own list, grouped as its manual groups them, so a typo never becomes a privilege.
 */
type Kind = 'namespace' | 'cluster' | 'any'
interface Draft {
  key: number
  kind: Kind
  db: string
  collection: string
  actions: string[]
}

const props = defineProps<{
  connectionId: string
  existing?: DbRoleView
  databases: readonly string[]
  customRoles: readonly DbRoleView[]
}>()
const emit = defineEmits<{ close: []; saved: [role: DbRoleView] }>()
const { t } = useI18n()
const toasts = useToastStore()
const dialogs = useDialogStore()
const queryClient = useQueryClient()

let seq = 0
const toDraft = (p: Privilege): Draft => {
  const r = p.resource
  return 'cluster' in r
    ? { key: ++seq, kind: 'cluster', db: '', collection: '', actions: [...p.actions] }
    : 'anyResource' in r
      ? { key: ++seq, kind: 'any', db: '', collection: '', actions: [...p.actions] }
      : { key: ++seq, kind: 'namespace', db: r.db, collection: r.collection, actions: [...p.actions] }
}
const db = ref(props.existing?.db ?? 'admin')
const name = ref(props.existing?.role ?? '')
const privileges = ref<Draft[]>((props.existing?.privileges ?? []).map(toDraft))
const roles = ref<RoleRef[]>((props.existing?.roles ?? []).map((r) => ({ ...r })))
const saving = ref(false)
const errors = ref<string[]>([])
const opened = JSON.stringify([privileges.value, roles.value])
const dirty = computed(
  () => JSON.stringify([privileges.value, roles.value]) !== opened || (!props.existing && !!name.value),
)

const dbOptions = computed(() =>
  [...new Set(['admin', ...props.databases.filter((d) => d !== 'local' && d !== 'config')])].map((d) => ({
    value: d,
    label: d,
  })),
)
const kinds = computed(() => [
  { value: 'namespace' as const, label: t('dbAccess.privileges.namespace') },
  { value: 'cluster' as const, label: t('dbAccess.privileges.cluster') },
  { value: 'any' as const, label: t('dbAccess.privileges.any') },
])
const actionItems = computed(() =>
  (Object.keys(PRIVILEGE_ACTIONS) as PrivilegeActionGroup[]).flatMap((group) =>
    PRIVILEGE_ACTIONS[group].map((action) => ({
      value: action,
      label: t('dbAccess.privileges.actionOption', {
        action,
        group: t(`dbAccess.privileges.groups.${group}`),
      }),
    })),
  ),
)
const title = computed(() =>
  props.existing
    ? t('dbAccess.customRoles.editTitle', { role: props.existing.role })
    : t('dbAccess.customRoles.addTitle'),
)

function addPrivilege(): void {
  privileges.value = [
    ...privileges.value,
    {
      key: ++seq,
      kind: 'namespace',
      db: db.value === 'admin' ? '' : db.value,
      collection: '',
      actions: ['find'],
    },
  ]
}
function addAction(p: Draft, action: string): void {
  if (!p.actions.includes(action)) p.actions = [...p.actions, action]
}
const resource = (p: Draft): Privilege['resource'] =>
  p.kind === 'cluster'
    ? { cluster: true }
    : p.kind === 'any'
      ? { anyResource: true }
      : { db: p.db.trim(), collection: p.collection.trim() }
const describeResource = (p: Draft) =>
  p.kind === 'cluster'
    ? t('dbAccess.privileges.clusterWord')
    : p.kind === 'any'
      ? t('dbAccess.privileges.anyWord')
      : t('dbAccess.privileges.on', {
          db: p.db.trim() || t('dbAccess.privileges.anyDb'),
          collection: p.collection.trim() || t('dbAccess.privileges.anyCollection'),
        })

async function save(): Promise<void> {
  errors.value = []
  if (!props.existing && !name.value.trim()) errors.value.push(t('dbAccess.customRoles.nameRequired'))
  if (privileges.value.some((p) => !p.actions.length))
    errors.value.push(t('dbAccess.privileges.actionsRequired'))
  if (!privileges.value.length && !roles.value.length) errors.value.push(t('dbAccess.customRoles.empty'))
  if (errors.value.length || saving.value) return
  const given = privileges.value.map((p) => ({ resource: resource(p), actions: p.actions }))
  // W3 review (M4): rights over the deployment, held or inherited, are given only when confirmed.
  const broad =
    given.some((p) => isBroadPrivilege(p as { resource: Record<string, unknown>; actions: string[] })) ||
    roles.value.some(
      (r) =>
        isBroadRoleRef(r) || props.customRoles.some((c) => c.role === r.role && c.db === r.db && c.broad),
    )
  if (
    broad &&
    !props.existing?.broad &&
    !(await dialogs.confirm({
      title: t('dbAccess.customRoles.broadTitle'),
      message: t('dbAccess.customRoles.broadMessage', { role: props.existing?.role ?? name.value.trim() }),
      confirmLabel: t('dbAccess.customRoles.broadConfirm'),
      danger: true,
    }))
  )
    return
  // W3 review (M2): the connection's own account holds this role: a change can lock it out.
  if (
    props.existing?.own &&
    !(await dialogs.confirm({
      title: t('dbAccess.own.title'),
      message: t('dbAccess.own.roleMessage', { role: props.existing.role }),
      confirmLabel: t('dbAccess.own.confirm'),
      danger: true,
    }))
  )
    return
  saving.value = true
  const send = (confirmBroad: boolean) => {
    const body = {
      privileges: given,
      roles: roles.value,
      ...(confirmBroad ? { confirmBroad: true } : {}),
      ...(props.existing?.own ? { confirmOwn: true } : {}),
    }
    return props.existing
      ? databaseAccessApi.updateRole(props.connectionId, props.existing.db, props.existing.role, body)
      : databaseAccessApi.createRole(props.connectionId, { db: db.value, role: name.value.trim(), ...body })
  }
  try {
    let saved
    try {
      saved = await send(broad)
    } catch (e) {
      // Re-review (1): an inherited role of a database not listed here can make it broad; the
      // server says so, and the confirmation is asked then.
      if (broad || !isBroadRefusal(e)) throw e
      const ok = await dialogs.confirm({
        title: t('dbAccess.customRoles.broadTitle'),
        message: t('dbAccess.customRoles.broadMessage', { role: props.existing?.role ?? name.value.trim() }),
        confirmLabel: t('dbAccess.customRoles.broadConfirm'),
        danger: true,
      })
      if (!ok) return
      saved = await send(true)
    }
    await queryClient.invalidateQueries({ queryKey: accessKeys.all(props.connectionId) })
    toasts.push({
      kind: 'success',
      message: props.existing
        ? t('dbAccess.customRoles.updated', { role: saved.role })
        : t('dbAccess.customRoles.created', { role: saved.role, db: saved.db }),
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
    :subtitle="t('dbAccess.customRoles.sheetSubtitle')"
    :dirty="dirty"
    @close="emit('close')"
  >
    <form class="flex max-w-3xl flex-col gap-5" data-role-editor @submit.prevent="save">
      <DsFormErrors :messages="errors" />
      <div class="grid gap-4 sm:grid-cols-2">
        <DsSelect v-if="!existing" v-model="db" :label="t('dbAccess.customRoles.db')" :options="dbOptions" />
        <DsInput v-else :model-value="existing.db" :label="t('dbAccess.customRoles.db')" mono readonly />
        <DsInput
          v-if="!existing"
          v-model="name"
          :label="t('dbAccess.customRoles.name')"
          mono
          autocomplete="off"
          spellcheck="false"
          maxlength="256"
        />
        <DsInput v-else :model-value="existing.role" :label="t('dbAccess.customRoles.name')" mono readonly />
      </div>
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-ui font-semibold text-fg">{{ t('dbAccess.privileges.title') }}</h3>
          <DsButton size="sm" :icon="Plus" @click="addPrivilege">{{ t('dbAccess.privileges.add') }}</DsButton>
        </div>
        <p v-if="!privileges.length" class="text-small text-fg-subtle">{{ t('dbAccess.privileges.none') }}</p>
        <ul class="flex flex-col gap-3">
          <li
            v-for="(p, i) in privileges"
            :key="p.key"
            class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3"
            :aria-label="describeResource(p)"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <DsSegmented
                v-model="p.kind"
                size="sm"
                :label="t('dbAccess.privileges.resource')"
                :options="kinds"
              />
              <DsIconButton
                :label="t('dbAccess.privileges.remove', { n: i + 1 })"
                :icon="Trash2"
                size="sm"
                @click="privileges = privileges.filter((x) => x.key !== p.key)"
              />
            </div>
            <div v-if="p.kind === 'namespace'" class="grid gap-3 sm:grid-cols-2">
              <!-- User report 2026-10-30: the connection's names offered; empty still means any. -->
              <NamespaceNameInput
                v-model="p.db"
                kind="database"
                :connection-id="connectionId"
                size="sm"
                mono
                :label="t('dbAccess.privileges.db')"
                :placeholder="t('dbAccess.privileges.anyDb')"
              />
              <NamespaceNameInput
                v-model="p.collection"
                kind="collection"
                :connection-id="connectionId"
                :db="p.db"
                views
                size="sm"
                mono
                :label="t('dbAccess.privileges.collection')"
                :placeholder="t('dbAccess.privileges.anyCollection')"
              />
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <DsChip
                v-for="a in p.actions"
                :key="a"
                :label="a"
                removable
                :remove-label="t('dbAccess.privileges.removeAction', { action: a })"
                @remove="p.actions = p.actions.filter((x) => x !== a)"
              />
              <DsCombobox
                :label="t('dbAccess.privileges.addAction')"
                :items="actionItems"
                :placeholder="t('dbAccess.privileges.searchAction')"
                :empty-text="t('dbAccess.privileges.noAction')"
                trigger-class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-dashed border-line-strong px-2 text-small text-fg-muted hover:border-accent hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                @select="addAction(p, $event)"
              >
                <template #trigger
                  ><Plus class="size-3.5" aria-hidden="true" />{{
                    t('dbAccess.privileges.addAction')
                  }}</template
                >
              </DsCombobox>
            </div>
          </li>
        </ul>
      </section>
      <section class="flex flex-col gap-3">
        <h3 class="text-ui font-semibold text-fg">{{ t('dbAccess.customRoles.inherits') }}</h3>
        <p class="text-small text-fg-subtle">
          {{
            db === 'admin'
              ? t('dbAccess.customRoles.inheritsAdmin')
              : t('dbAccess.customRoles.inheritsDb', { db })
          }}
        </p>
        <RoleRefsEditor
          v-model="roles"
          :custom-roles="customRoles.filter((r) => !(r.db === db && r.role === name))"
          :databases="databases"
          :role-db="db"
        />
      </section>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <div class="flex justify-end gap-2">
        <DsButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</DsButton>
        <DsButton variant="primary" :loading="saving" data-save-role @click="save">{{
          existing ? t('dbAccess.customRoles.save') : t('dbAccess.customRoles.create')
        }}</DsButton>
      </div>
    </template>
  </DsSheet>
</template>
