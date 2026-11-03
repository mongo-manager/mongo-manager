<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { STAGES } from '@mongo-manager/shared/browser'
import { searchStages } from './stageSearch'

/** Phase 2a spec §4.2: "Add stage", with a searchable list of the operators and what each does. */
const emit = defineEmits<{ pick: [operator: string] }>()
const { t } = useI18n()
const id = useId()
const open = ref(false)
const query = ref('')
const active = ref(0)
const search = ref<HTMLInputElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)

const describe = (operator: string) => t(`aggregation.stageHelp.${operator.slice(1)}`)
// W2.5: the same search as a stage's operator — by name, then by what the stage does.
const BY_OPERATOR = new Map(STAGES.map((s) => [s.operator, s]))
const matches = computed(() => searchStages(query.value, describe).map((op) => BY_OPERATOR.get(op)!))

async function toggle(): Promise<void> {
  open.value = !open.value
  query.value = ''
  active.value = 0
  if (open.value) {
    await nextTick()
    search.value?.focus()
  }
}

function pick(operator: string): void {
  open.value = false
  emit('pick', operator)
}

function onKeydown(event: KeyboardEvent): void {
  const count = matches.value.length
  if (event.key === 'Escape') {
    // Seventh review of the floating window (M-2): the key is the list's, and focus goes back to its
    // button (the field it was in goes).
    event.stopPropagation()
    open.value = false
    trigger.value?.focus()
  } else if (event.key === 'ArrowDown' && count) {
    active.value = (active.value + 1) % count
  } else if (event.key === 'ArrowUp' && count) {
    active.value = (active.value - 1 + count) % count
  } else if (event.key === 'Enter' && count) {
    pick(matches.value[Math.min(active.value, count - 1)]!.operator)
  } else return
  event.preventDefault()
}
</script>

<template>
  <div class="relative">
    <button
      ref="trigger"
      type="button"
      class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-on-accent shadow-xs transition-colors duration-120 hover:bg-accent-hover"
      :aria-expanded="open"
      :aria-controls="open ? `${id}-list` : undefined"
      @click="toggle"
    >
      {{ t('aggregation.addStage') }}
    </button>
    <div
      v-if="open"
      data-ds-popup
      class="absolute top-full left-0 z-30 mt-1 w-96 max-w-[90vw] rounded-xl bg-raised p-1.5 shadow-float ring-1 ring-line animate-pop"
    >
      <input
        ref="search"
        v-model="query"
        type="search"
        :aria-label="t('aggregation.findStage')"
        :placeholder="t('aggregation.findStage')"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="true"
        :aria-controls="`${id}-list`"
        :aria-activedescendant="matches.length ? `${id}-${active}` : undefined"
        class="mb-1.5 h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-ui text-fg placeholder:text-fg-subtle focus:border-focus focus:ring-3 focus:ring-focus/20 focus-visible:outline-none"
        @input="active = 0"
        @keydown="onKeydown"
      />
      <ul
        :id="`${id}-list`"
        role="listbox"
        :aria-label="t('aggregation.addStage')"
        class="max-h-72 overflow-auto"
      >
        <li
          v-for="(stage, i) in matches"
          :id="`${id}-${i}`"
          :key="stage.operator"
          role="option"
          :aria-selected="i === active"
          :data-operator="stage.operator"
          class="cursor-pointer rounded-md px-2 py-1.5"
          :class="i === active ? 'bg-accent-soft text-accent-fg' : 'hover:bg-subtle'"
          @click="pick(stage.operator)"
          @mousemove="active = i"
        >
          <span class="font-mono text-ui">{{ stage.operator }}</span>
          <span class="block text-small text-fg-subtle">{{ describe(stage.operator) }}</span>
        </li>
        <li v-if="matches.length === 0" class="px-2 py-1.5 text-ui text-fg-subtle">
          {{ t('aggregation.noStage') }}
        </li>
      </ul>
    </div>
  </div>
</template>
