<script setup lang="ts">
import { computed, ref, useAttrs, useId, type Component } from 'vue'
import { X } from 'lucide-vue-next'

/** UI redesign R1 spec §2: a text field with an optional icon, clear button, hint and error. */
defineOptions({ inheritAttrs: false })
const props = withDefaults(
  defineProps<{
    label?: string
    hideLabel?: boolean
    icon?: Component
    size?: 'sm' | 'md'
    mono?: boolean
    clearable?: boolean
    error?: string
    hint?: string
    type?: string
    /** Select the whole value on focus, so typing replaces it (a masked secret). */
    selectOnFocus?: boolean
    /** More that describes the field, by id (a password's strength meter under it). */
    describedby?: string
  }>(),
  {
    label: undefined,
    icon: undefined,
    size: 'md',
    error: undefined,
    hint: undefined,
    type: 'text',
    describedby: undefined,
  },
)
const model = defineModel<string>({ required: true })
const id = useId()
const input = ref<HTMLInputElement | null>(null)
function clear(): void {
  model.value = ''
  input.value?.focus()
}
defineExpose({ focus: () => input.value?.focus() })
// Review of K+R2 (I2): class and style lay out the field (as UiTextField's did); the rest — maxlength,
// autocomplete, inputmode, required, disabled, data-* — belong to the input.
const attrs = useAttrs()
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }))
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})
const describedBy = () =>
  [props.error ? `${id}-error` : props.hint ? `${id}-hint` : undefined, props.describedby]
    .filter(Boolean)
    .join(' ') || undefined
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5" v-bind="rootAttrs">
    <label v-if="label" :for="id" :class="hideLabel ? 'sr-only' : 'text-small font-medium text-fg-muted'">{{
      label
    }}</label>
    <div
      class="relative flex min-w-0 items-center rounded-md border bg-surface transition-[border-color,box-shadow] duration-120 ease-out-soft focus-within:border-focus focus-within:ring-3 focus-within:ring-focus/20 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:bg-subtle has-[input:disabled]:opacity-70"
      :class="[
        error ? 'border-danger focus-within:border-danger focus-within:ring-danger/20' : 'border-line-strong',
        size === 'sm' ? 'h-7' : 'h-8',
      ]"
    >
      <component
        :is="icon"
        v-if="icon"
        class="pointer-events-none ml-2.5 size-3.5 shrink-0 text-fg-subtle"
        aria-hidden="true"
      />
      <input
        :id="id"
        ref="input"
        v-model="model"
        v-bind="inputAttrs"
        :type="type"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="describedBy()"
        class="h-full min-w-0 flex-1 bg-transparent px-2.5 text-ui text-fg placeholder:text-fg-subtle focus:outline-none disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
        :class="[icon ? 'pl-2' : '', mono ? 'font-mono text-[12.5px]' : '']"
        @focus="selectOnFocus && ($event.target as HTMLInputElement).select()"
      />
      <button
        v-if="clearable && model"
        type="button"
        tabindex="-1"
        :aria-label="$t('common.clear')"
        class="mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle hover:bg-muted hover:text-fg"
        @click="clear"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </div>
    <p v-if="error" :id="`${id}-error`" class="text-small text-danger">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-hint`" class="text-small text-fg-subtle">{{ hint }}</p>
  </div>
</template>
