<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff, KeyRound } from 'lucide-vue-next'

/**
 * Spec §4.4, D2: a stored secret is never shown; "Replace" opens an empty field, null keeps it.
 * Phase 3d-3b final review: after an address change the stored secret no longer applies — the field
 * opens empty and says why (`reenter`), with no way back to the stored one.
 */
const props = defineProps<{
  label: string
  stored: boolean
  modelValue: string | null
  autocomplete?: string
  reenter?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()
const { t } = useI18n()
const shown = ref(false)
const id = useId()
const input = ref<HTMLInputElement | null>(null)
const replaceButton = ref<HTMLButtonElement | null>(null)

/** Focus follows the control that replaced the one just used. */
async function replace(): Promise<void> {
  emit('update:modelValue', '')
  await nextTick()
  input.value?.focus()
}
async function keep(): Promise<void> {
  emit('update:modelValue', null)
  shown.value = false
  await nextTick()
  replaceButton.value?.focus()
}
const showStored = () => props.stored && props.modelValue === null && !props.reenter
</script>

<template>
  <div class="flex flex-col gap-1.5 text-ui">
    <template v-if="showStored()">
      <span :id="`${id}-label`" class="text-small font-medium text-fg-muted">{{ label }}</span>
      <div
        role="group"
        :aria-labelledby="`${id}-label`"
        class="flex h-8 items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-fg-muted"
      >
        <KeyRound class="size-4 text-success" aria-hidden="true" />
        <span class="flex-1">{{ t('destinations.secret.stored') }}</span>
        <button
          ref="replaceButton"
          type="button"
          :aria-label="t('destinations.secret.replaceNamed', { name: label })"
          class="cursor-pointer rounded-md px-2 py-0.5 text-small font-medium text-accent-fg hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          @click="replace"
        >
          {{ t('destinations.secret.replace') }}
        </button>
      </div>
    </template>
    <template v-else>
      <label :for="id" class="text-small font-medium text-fg-muted">{{ label }}</label>
      <div class="relative">
        <input
          :id="id"
          ref="input"
          :type="shown ? 'text' : 'password'"
          :value="modelValue ?? ''"
          :autocomplete="autocomplete ?? 'new-password'"
          spellcheck="false"
          :aria-describedby="stored && reenter ? `${id}-note` : undefined"
          :aria-invalid="stored && reenter && !modelValue ? 'true' : undefined"
          class="h-8 w-full rounded-md border bg-surface pr-9 pl-2.5 font-mono text-[12.5px] text-fg transition-[border-color,box-shadow] duration-120 ease-out-soft focus:ring-3 focus:outline-none"
          :class="
            stored && reenter && !modelValue
              ? 'border-warning/40 focus:border-warning focus:ring-warning/20'
              : 'border-line-strong focus:border-focus focus:ring-focus/20'
          "
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        />
        <button
          type="button"
          class="absolute inset-y-0 right-0 flex w-8 cursor-pointer items-center justify-center rounded-r-md text-fg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          :aria-label="
            shown
              ? t('destinations.secret.hideNamed', { name: label })
              : t('destinations.secret.showNamed', { name: label })
          "
          :aria-pressed="shown"
          @click="shown = !shown"
        >
          <component :is="shown ? EyeOff : Eye" class="size-4" aria-hidden="true" />
        </button>
      </div>
      <p v-if="stored && reenter" :id="`${id}-note`" class="text-small text-warning" data-reenter>
        {{ t('destinations.secret.reenter') }}
      </p>
      <button
        v-else-if="stored"
        type="button"
        class="cursor-pointer self-start rounded-md text-small text-fg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        @click="keep"
      >
        {{ t('destinations.secret.keep') }}
      </button>
    </template>
  </div>
</template>
