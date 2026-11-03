<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ROLES, type Role } from '@mongo-manager/shared/browser'
import DsDialog from '@/ds/DsDialog.vue'
import DsButton from '@/ds/DsButton.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsPasswordStrength from '@/ds/DsPasswordStrength.vue'
import DsFormErrors from '@/ds/DsFormErrors.vue'
import { accountKeys, twoFactorRequiredOf, usersApi } from '@/api/account'
import { useFormErrors } from '@/connections/formErrors'
import { useToastStore } from '@/stores/toasts'
import { STEP_UP_DECLINED, withStepUp } from '@/account/stepUp'

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const queryClient = useQueryClient()
const toasts = useToastStore()
const username = ref('')
const password = ref('')
const role = ref<Role>('viewer')
/** Security audit 2026-10-16: the administrator's own password confirms the new account. */
const currentPassword = ref('')
const roles = computed(() => ROLES.map((r) => ({ value: r, label: t(`overview.roles.${r}`) })))
/** Required 2FA (2026-10-28): the administrator's own choice for this user (off by default). */
const requireTwoFactor = ref(false)
const meterId = useId()
const policy = useQuery({ queryKey: accountKeys.policy, queryFn: usersApi.policy })
/**
 * Required anyway by the policy: said, while the box stays what is stored for this user (final review
 * I1: a box shown checked but sent unchecked looked stored when it was not).
 */
const covered = computed(() => {
  const p = policy.data.value
  if (!twoFactorRequiredOf({ role: role.value }, p)) return null
  return t(p?.everyoneTwoFactor ? 'users.requireTwoFactorEveryone' : 'users.requireTwoFactorAdmins')
})
const { general, reset, showError, errorFor } = useFormErrors()

const { mutate: create, isPending } = useMutation({
  mutationFn: () =>
    withStepUp(() =>
      usersApi.create(
        username.value.trim(),
        password.value,
        role.value,
        currentPassword.value,
        requireTwoFactor.value,
      ),
    ),
  onMutate: reset,
  onSuccess: async (user) => {
    // No second factor given: the dialog stays, as filled in.
    if (user === STEP_UP_DECLINED) return
    await queryClient.invalidateQueries({ queryKey: accountKeys.users })
    toasts.push({ kind: 'success', message: t('users.createdToast', { name: user.username }) })
    emit('close')
  },
  onError: showError,
})

function submit(): void {
  if (!isPending.value) create()
}
</script>

<template>
  <DsDialog open :title="t('users.create')" size="sm" @close="emit('close')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <DsInput
        v-model="username"
        :label="t('users.username')"
        :error="errorFor('username')"
        autocomplete="off"
        required
      />
      <div class="flex flex-col gap-1.5">
        <DsInput
          v-model="password"
          type="password"
          :label="t('users.password')"
          :error="errorFor('password')"
          autocomplete="new-password"
          :describedby="meterId"
          required
        />
        <DsPasswordStrength :id="meterId" :password="password" :username="username.trim()" />
      </div>
      <DsSelect v-model="role" :label="t('users.role')" :options="roles" />
      <DsCheckbox
        v-model="requireTwoFactor"
        data-require-two-factor
        :label="t('users.requireTwoFactor')"
        :hint="covered ?? t('users.requireTwoFactorHint')"
      />
      <DsInput
        v-model="currentPassword"
        type="password"
        :label="t('users.yourPassword')"
        :hint="t('users.confirmCreate')"
        autocomplete="current-password"
        data-current-password
        required
      />
      <DsFormErrors :messages="general" />
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton @click="emit('close')">{{ t('common.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="isPending" @click="submit">{{ t('users.create') }}</DsButton>
    </template>
  </DsDialog>
</template>
