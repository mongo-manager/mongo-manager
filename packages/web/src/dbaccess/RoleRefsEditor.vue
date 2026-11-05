<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, ShieldAlert } from 'lucide-vue-next'
import { BUILTIN_ROLES, isBroadRoleRef, type DbRoleView, type RoleRef } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsChip from '@/ds/DsChip.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'

/**
 * W3.1: the roles a user holds (or a custom role inherits), as removable chips, and a row to add
 * one: a built-in role (with what it allows) or a custom role, on a database. Roles that exist only
 * in admin take admin; a custom role outside admin inherits from its own database only (MongoDB's
 * rule), so the database is fixed there.
 */
const props = defineProps<{
  modelValue: RoleRef[]
  customRoles: readonly DbRoleView[]
  databases: readonly string[]
  /** The custom role being edited lives here: outside admin, it inherits from this database only. */
  roleDb?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [roles: RoleRef[]] }>()
const { t } = useI18n()
const ids = useId()

const scopeOf = (role: string) => BUILTIN_ROLES.find((r) => r.role === role)?.scope
const options = computed(() => [
  { value: '', label: t('dbAccess.roles.choose') },
  ...BUILTIN_ROLES.map((r) => ({
    value: `builtin:${r.role}`,
    label: t('dbAccess.roles.builtinOption', { role: r.role, what: t(`dbAccess.builtin.${r.role}`) }),
  })),
  ...props.customRoles
    .filter((r) => !props.roleDb || props.roleDb === 'admin' || r.db === props.roleDb)
    .map((r) => ({
      value: `custom:${r.db}:${r.role}`,
      label: t('dbAccess.roles.customOption', { role: r.role, db: r.db }),
    })),
])
const choice = ref('')
const db = ref(props.roleDb && props.roleDb !== 'admin' ? props.roleDb : '')
const fixedDb = computed(() => {
  if (choice.value.startsWith('custom:')) return choice.value.split(':')[1]!
  const role = choice.value.slice('builtin:'.length)
  if (choice.value.startsWith('builtin:') && scopeOf(role) === 'admin') return 'admin'
  if (props.roleDb && props.roleDb !== 'admin') return props.roleDb
  return null
})
const roleName = computed(() =>
  choice.value.startsWith('custom:')
    ? choice.value.split(':').slice(2).join(':')
    : choice.value.slice('builtin:'.length),
)
const targetDb = computed(() => fixedDb.value ?? db.value.trim())
const canAdd = computed(
  () =>
    choice.value !== '' &&
    targetDb.value !== '' &&
    !props.modelValue.some((r) => r.role === roleName.value && r.db === targetDb.value),
)
// Review of B4 (I1): every role over the deployment, as the server judges a built-in one.
const powerful = computed(() => props.modelValue.filter((r) => isBroadRoleRef(r)))
const listId = `${ids}-dbs`

function add(): void {
  if (!canAdd.value) return
  emit('update:modelValue', [...props.modelValue, { role: roleName.value, db: targetDb.value }])
  choice.value = ''
}
function remove(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, i) => i !== index),
  )
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul v-if="modelValue.length" class="flex flex-wrap gap-1.5" :aria-label="t('dbAccess.roles.held')">
      <li v-for="(r, i) in modelValue" :key="`${r.role}@${r.db}`">
        <DsChip
          :label="t('dbAccess.roles.on', { role: r.role, db: r.db })"
          removable
          :remove-label="t('dbAccess.roles.remove', { role: r.role, db: r.db })"
          @remove="remove(i)"
        />
      </li>
    </ul>
    <p v-else class="text-small text-fg-subtle">{{ t('dbAccess.roles.none') }}</p>
    <div class="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-end">
      <DsSelect v-model="choice" size="sm" :label="t('dbAccess.roles.role')" :options="options" />
      <DsInput
        v-if="fixedDb === null"
        v-model="db"
        size="sm"
        mono
        :label="t('dbAccess.roles.database')"
        :placeholder="t('dbAccess.roles.databasePlaceholder')"
        :list="listId"
        @keydown.enter.prevent="add"
      />
      <p v-else class="text-small text-fg-muted sm:pb-2">
        {{ t('dbAccess.roles.fixedDb', { db: fixedDb }) }}
      </p>
      <DsButton size="sm" :icon="Plus" :disabled="!canAdd" @click="add">{{
        t('dbAccess.roles.add')
      }}</DsButton>
      <datalist :id="listId">
        <option v-for="d in databases" :key="d" :value="d" />
      </datalist>
    </div>
    <p v-if="powerful.length" class="flex items-start gap-2 text-small text-warning" role="note">
      <ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {{ t('dbAccess.roles.powerful', { roles: powerful.map((r) => r.role).join(', ') }) }}
    </p>
  </div>
</template>
