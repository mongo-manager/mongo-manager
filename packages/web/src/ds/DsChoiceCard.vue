<script setup lang="ts">
/**
 * A radio card: a title, a line of help, an optional badge and command, and a reason when it is
 * disabled. The chosen card is tinted; the focused one gets an offset ring, so the two never look alike.
 */
defineProps<{
  name: string
  value: string
  title: string
  help: string
  badge?: string
  /** A command that opens the result (kept on one line, never broken at its dashes). */
  code?: string
  disabled?: boolean
  reason?: string
}>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <label
    class="group relative flex gap-3 rounded-card border p-4 transition-[border-color,background-color,box-shadow] duration-160 ease-out-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface"
    :class="[
      disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      model === value
        ? 'border-accent bg-accent-soft shadow-xs'
        : 'border-line hover:border-line-strong hover:bg-subtle',
    ]"
  >
    <input
      v-model="model"
      type="radio"
      :name="name"
      :value="value"
      :disabled="disabled"
      :autofocus="model === value"
      class="mt-1 size-4 shrink-0 accent-accent disabled:opacity-50"
    />
    <span class="flex min-w-0 flex-col gap-1">
      <span class="flex flex-wrap items-center gap-2 font-medium text-fg" :class="{ 'opacity-50': disabled }">
        {{ title }}
        <span
          v-if="badge"
          class="rounded-md bg-accent-soft px-1.5 py-0.5 text-caption font-medium text-accent-fg ring-1 ring-accent/20"
          >{{ badge }}</span
        >
      </span>
      <span class="text-ui text-fg-muted" :class="{ 'opacity-50': disabled }">{{ help }}</span>
      <code
        v-if="code"
        class="mt-0.5 w-fit max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-fg"
        :class="{ 'opacity-50': disabled }"
        :title="code"
        >{{ code }}</code
      >
      <span v-if="disabled && reason" class="text-small text-warning">{{ reason }}</span>
    </span>
  </label>
</template>
