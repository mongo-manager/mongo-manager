<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Eye, EyeOff, KeyRound, ShieldAlert } from 'lucide-vue-next'
import { MIN_BACKUP_PASSWORD } from '@mongo-manager/shared/browser'
import { useToastStore } from '@/stores/toasts'
import { generatePassword, passwordStrength } from './password'

/** U1: a backup password with a generator, reveal, copy, strength meter and the warning that matters. */
const password = defineModel<string>('password', { required: true })
const repeat = defineModel<string>('repeat', { required: true })
const { t } = useI18n()
const toasts = useToastStore()
const id = useId()
const reveal = ref(false)
const strength = computed(() => (password.value ? passwordStrength(password.value) : null))
const tooShort = computed(() => password.value.length > 0 && password.value.length < MIN_BACKUP_PASSWORD)
const mismatch = computed(() => repeat.value.length > 0 && repeat.value !== password.value)
const LEVEL = { weak: 1, fair: 2, strong: 3 } as const
const COLOR = { weak: 'bg-danger', fair: 'bg-warning', strong: 'bg-success' } as const

function generate(): void {
  const p = generatePassword()
  password.value = p
  repeat.value = p
  // A generated password is shown, so it can be written down before the backup starts.
  reveal.value = true
}
async function copy(): Promise<void> {
  try {
    if (!navigator.clipboard) return
    await navigator.clipboard.writeText(password.value)
    toasts.push({ kind: 'success', message: t('backup.password.copied') })
  } catch {
    // Copying is a convenience; the password stays in the field.
  }
}
const input =
  'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-sm transition-colors focus:border-accent focus:ring-2 focus:ring-focus/30 focus:outline-none aria-[invalid=true]:border-danger/30'
const icon =
  'cursor-pointer rounded-md p-1.5 text-fg-subtle transition-colors duration-150 hover:bg-subtle hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-default disabled:opacity-40'
</script>

<template>
  <div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
    <div class="flex flex-wrap items-end gap-3">
      <div class="flex min-w-60 flex-1 flex-col gap-1.5">
        <label :for="`${id}-p`" class="text-ui font-medium text-fg">{{ t('backup.password.label') }}</label>
        <div class="relative">
          <input
            :id="`${id}-p`"
            v-model="password"
            :type="reveal ? 'text' : 'password'"
            autocomplete="new-password"
            spellcheck="false"
            autocapitalize="off"
            :class="[input, 'pr-20']"
            :aria-invalid="tooShort"
            :aria-describedby="`${id}-s`"
          />
          <div class="absolute inset-y-0 right-1 flex items-center gap-0.5">
            <button
              type="button"
              :class="icon"
              :aria-label="reveal ? t('backup.password.hide') : t('backup.password.show')"
              :aria-pressed="reveal"
              @click="reveal = !reveal"
            >
              <EyeOff v-if="reveal" class="size-4" aria-hidden="true" />
              <Eye v-else class="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              :class="icon"
              :disabled="!password"
              :aria-label="t('backup.password.copy')"
              @click="copy"
            >
              <Copy class="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        class="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-3 text-ui font-medium text-fg transition-colors duration-150 hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        @click="generate"
      >
        <KeyRound class="size-4" aria-hidden="true" />{{ t('backup.password.generate') }}
      </button>
    </div>
    <div :id="`${id}-s`" class="flex min-h-4 items-center gap-3 text-small" aria-live="polite">
      <div class="flex h-1.5 w-40 gap-1" aria-hidden="true">
        <span
          v-for="n in 3"
          :key="n"
          class="flex-1 rounded-full transition-colors duration-200"
          :class="strength && n <= LEVEL[strength] ? COLOR[strength] : 'bg-muted'"
        />
      </div>
      <span v-if="strength" class="text-fg-muted">{{ t(`backup.password.strength.${strength}`) }}</span>
      <span v-if="tooShort" class="text-danger">{{
        t('backup.password.tooShort', { n: MIN_BACKUP_PASSWORD })
      }}</span>
    </div>
    <div class="flex flex-col gap-1.5">
      <label :for="`${id}-r`" class="text-ui font-medium text-fg">{{ t('backup.password.repeat') }}</label>
      <input
        :id="`${id}-r`"
        v-model="repeat"
        :type="reveal ? 'text' : 'password'"
        autocomplete="new-password"
        spellcheck="false"
        autocapitalize="off"
        :class="input"
        :aria-invalid="mismatch"
        :aria-describedby="mismatch ? `${id}-m` : undefined"
      />
      <span v-if="mismatch" :id="`${id}-m`" class="text-small text-danger">{{
        t('backup.password.mismatch')
      }}</span>
    </div>
    <p class="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-small text-warning">
      <ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{{ t('backup.password.warning') }}
    </p>
  </div>
</template>
