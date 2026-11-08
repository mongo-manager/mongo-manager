<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ListFilter } from 'lucide-vue-next'
import DsChip from '@/ds/DsChip.vue'
import { filterChips, type FilterChip } from './filterChips'

/**
 * W1 (completion §2), UI redesign R1 §4.4: the filter the results came from, one removable chip per
 * top-level condition. Removing one (its button, Delete or Backspace) runs the filter without it; the
 * focus moves to the chip that takes its place, so the keyboard can go on removing.
 */
const props = defineProps<{ filter: Record<string, unknown> }>()
const emit = defineEmits<{
  remove: [chip: FilterChip]
  /** The last chip went: the view moves the focus to the bar (W1 review, minor 10). */
  emptied: []
}>()
const { t } = useI18n()

const chips = computed(() => filterChips(props.filter))
const list = ref<HTMLElement | null>(null)

/** What was removed is said by the view's toast (with Undo); the focus stays among the chips. */
async function remove(chip: FilterChip, index: number): Promise<void> {
  emit('remove', chip)
  await nextTick()
  const left = list.value?.querySelectorAll<HTMLElement>('[data-chip]') ?? []
  if (left.length) left[Math.min(index, left.length - 1)]!.focus()
  else emit('emptied')
}
</script>

<template>
  <div>
    <div
      v-if="chips.length"
      ref="list"
      data-filter-chips
      role="group"
      :aria-label="t('explorer.chips.label')"
      class="flex flex-wrap items-center gap-1.5 px-4 pb-2"
    >
      <ListFilter class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <DsChip
        v-for="(chip, i) in chips"
        :key="chip.id"
        removable
        class="max-w-80!"
        :label="chip.label"
        :title="chip.title"
        :remove-label="t('explorer.chips.remove', { condition: chip.label })"
        :hint="t('explorer.chips.hint')"
        @remove="remove(chip, i)"
      />
    </div>
  </div>
</template>
