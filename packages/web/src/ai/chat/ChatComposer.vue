<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Square } from 'lucide-vue-next'
import { AI_CHAT_LIMITS } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsSelect from '@/ds/DsSelect.vue'
/** Spec §5: a growing box; Enter sends, Shift+Enter is a new line, IME-safe; Escape leaves. */
const model = defineModel<string>({ required: true })
const provider = defineModel<string | null>('provider', { default: null })
const props = defineProps<{
  busy: boolean
  /** Why nothing can be sent now, in words; null when it can. */
  blocked: string | null
  providers: Array<{ value: string; label: string }>
  placeholder: string
}>()
const emit = defineEmits<{ send: []; stop: []; leave: [] }>()
const { t } = useI18n()
const id = useId()
const hintId = useId()
const box = ref<HTMLTextAreaElement | null>(null)
const near = computed(() => model.value.length > AI_CHAT_LIMITS.message * 0.9)

function grow(): void {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 192)}px`
}
watch(model, () => void nextTick(grow))

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    if (!props.busy && !props.blocked && model.value.trim()) emit('send')
  } else if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    emit('leave')
  }
}
defineExpose({ focus: () => box.value?.focus() })
</script>

<template>
  <div
    class="rounded-xl border border-line bg-surface transition-shadow duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-focus/20"
  >
    <label :for="id" class="sr-only">{{ t('ai.chat.composer.label') }}</label>
    <textarea
      :id="id"
      ref="box"
      v-model="model"
      rows="2"
      :maxlength="AI_CHAT_LIMITS.message"
      :placeholder="placeholder"
      :aria-describedby="hintId"
      style="outline: none"
      class="block max-h-48 w-full resize-none bg-transparent px-3 pt-3 text-ui text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:outline-none"
      @keydown="onKeydown"
    />
    <div class="flex items-center gap-2 px-2 pt-1 pb-2">
      <DsSelect
        v-if="providers.length > 1"
        class="max-w-[13rem]"
        size="sm"
        hide-label
        :label="t('ai.chat.composer.provider')"
        :model-value="provider ?? ''"
        :options="providers"
        @update:model-value="provider = $event"
      />
      <span v-else-if="providers[0]" class="min-w-0 truncate text-small text-fg-subtle">{{
        providers[0].label
      }}</span>
      <!-- The keys are told to screen readers; a reason not to send is shown to everyone. -->
      <span
        :id="hintId"
        class="ml-auto truncate text-small text-fg-subtle"
        :class="blocked ? '' : 'sr-only'"
        >{{ blocked ?? t('ai.chat.composer.hint') }}</span
      >
      <span class="flex-1" aria-hidden="true" />
      <span v-if="near" class="text-small text-fg-subtle tabular-nums"
        >{{ model.length }} / {{ AI_CHAT_LIMITS.message }}</span
      >
      <DsButton v-if="busy" size="sm" @click="emit('stop')"
        ><Square class="size-3.5" aria-hidden="true" />{{ t('ai.chat.composer.stop') }}</DsButton
      >
      <DsButton
        v-else
        size="sm"
        variant="primary"
        :disabled="!!blocked || !model.trim()"
        aria-keyshortcuts="Enter"
        @click="emit('send')"
        ><ArrowUp class="size-3.5" aria-hidden="true" />{{ t('ai.chat.composer.send') }}</DsButton
      >
    </div>
  </div>
</template>
