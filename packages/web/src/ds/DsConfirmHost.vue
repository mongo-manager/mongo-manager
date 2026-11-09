<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDialogStore } from '@/stores/dialogs'
import DsDialog from './DsDialog.vue'
import DsButton from './DsButton.vue'
import DsInput from './DsInput.vue'
import DsPasswordStrength from './DsPasswordStrength.vue'
import { accountPasswordProblems } from '@mongo-manager/shared/browser'
import { confirmGuard } from './confirmGuard'
import { useConfirmArming } from './useConfirmArming'

/** UI redesign R1: the confirmations and prompts of `useDialogStore`, one at a time. */
const store = useDialogStore()
const typed = ref('')
const canConfirm = computed(
  () =>
    !!store.current &&
    (!store.current.requireText || typed.value === store.current.requireText) &&
    (!store.current.input || store.current.value !== '') &&
    // Password strength final review M4: a new account password the server would refuse is not
    // taken to the next step (the administrator's own password, a second factor), to be lost there.
    (!store.current.input?.strength ||
      accountPasswordProblems(store.current.value, store.current.input.strength.username).length === 0),
)
/**
 * Security audit 2026-10-16: each question takes its Confirm only after a moment with no press, and
 * a pointer's click only from a press begun (and a move onto Confirm) after it — the rules live in
 * useConfirmArming, shared with the assistant's change cards (W6.3). Focus starts away from Confirm.
 */
const guard = useConfirmArming({
  active: () => !!store.current,
  submit: () => {
    if (guard.armed.value && canConfirm.value) store.settle(true)
  },
})
const { armed, arming, pointerOnto, confirmClick } = guard
watch(
  () => store.current?.id,
  () => {
    typed.value = ''
    guard.reset()
  },
  { immediate: true },
)
/** Enter in a field: now, or once the moment passed. */
const formSubmit = () => guard.formSubmit()
</script>

<template>
  <DsDialog
    v-if="store.current"
    :key="store.current.id"
    open
    :title="store.current.title"
    size="sm"
    @close="store.settle(false)"
  >
    <form novalidate class="flex flex-col gap-4" @submit.prevent="formSubmit">
      <p v-if="store.current.message" class="text-ui whitespace-pre-line text-fg-muted">
        {{ store.current.message }}
      </p>
      <div v-if="store.current.requireText" data-test="require-text">
        <DsInput
          v-model="typed"
          :label="$t('common.typeToConfirm', { name: store.current.requireText })"
          mono
          autocomplete="off"
        />
      </div>
      <div v-if="store.current.input" data-test="prompt-input">
        <DsInput
          v-model="store.current.value"
          :type="store.current.input.type"
          :label="store.current.input.label"
          :autocomplete="
            store.current.input.autocomplete ??
            (store.current.input.type === 'password' ? 'current-password' : 'off')
          "
        />
        <DsPasswordStrength
          v-if="store.current.input.strength"
          class="mt-1.5"
          :password="store.current.value"
          :username="store.current.input.strength.username"
        />
      </div>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <DsButton data-test="cancel" @click="store.settle(false)">{{ $t('common.cancel') }}</DsButton>
      <DsButton
        data-test="confirm"
        class="relative overflow-hidden"
        :variant="store.current.danger ? 'danger' : 'primary'"
        :disabled="!canConfirm || !armed"
        @pointerenter="pointerOnto"
        @pointermove="pointerOnto"
        @click="confirmClick"
      >
        {{ store.current.confirmLabel ?? $t('common.confirm') }}
        <!-- Getting ready, not broken: a bar fills while the moment runs (review I2). -->
        <span
          v-if="!armed"
          :key="arming"
          data-confirm-arming
          aria-hidden="true"
          class="confirm-arming absolute inset-x-0 bottom-0 h-0.5 origin-left bg-current opacity-60"
          :style="{ animationDuration: `${confirmGuard.armMs}ms` }"
        />
      </DsButton>
    </template>
  </DsDialog>
</template>

<style scoped>
.confirm-arming {
  animation-name: confirm-arming;
  animation-timing-function: linear;
  animation-fill-mode: both;
}
@keyframes confirm-arming {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .confirm-arming {
    animation: none;
    transform: scaleX(1);
  }
}
</style>
