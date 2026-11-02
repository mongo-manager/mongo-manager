<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-vue-next'
import DsPopover from '@/ds/DsPopover.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsButton from '@/ds/DsButton.vue'
import { orderColumns, type ColumnPrefs } from './rows'

const props = defineProps<{ columns: string[] }>()
const prefs = defineModel<ColumnPrefs>({ required: true })
const { t } = useI18n()

const ordered = computed(() => orderColumns(props.columns, prefs.value))
const hidden = computed(() => new Set(prefs.value.hidden))

// The model reaches the parent on its next render: changes made before then build on each other.
let pending: ColumnPrefs | null = null
watch(prefs, () => (pending = null))
const current = () => pending ?? prefs.value
function update(change: Partial<ColumnPrefs>): void {
  pending = { ...current(), ...change }
  prefs.value = pending
}

function setShown(column: string, shown: boolean): void {
  const rest = current().hidden.filter((c) => c !== column)
  update({ hidden: shown ? rest : [...rest, column] })
}

const list = ref<HTMLElement | null>(null)

/** Moves a column and keeps focus on its buttons (the pressed one may now be disabled). */
async function move(index: number, by: -1 | 1): Promise<void> {
  const next = orderColumns(props.columns, current())
  const [column] = next.splice(index, 1)
  const to = index + by
  next.splice(to, 0, column!)
  update({ order: next })
  await nextTick()
  const atEdge = by === -1 ? to === 0 : to === next.length - 1
  // At the top or bottom the pressed button is disabled: the other one takes focus.
  const up = atEdge ? by === 1 : by === -1
  const direction = up ? 'moveUp' : 'moveDown'
  const label = t(`documents.columns.${direction}`, { name: column })
  const buttons = list.value?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? []
  ;[...buttons].find((b) => b.getAttribute('aria-label') === label)?.focus()
}
</script>

<template>
  <DsPopover
    :label="t('documents.columns.button')"
    trigger-class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-small font-medium text-fg-muted hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
    panel-class="w-72"
  >
    <template #trigger>
      <Columns3 class="size-4" aria-hidden="true" />
      {{ t('documents.columns.button') }}
    </template>
    <ul ref="list" class="flex max-h-80 flex-col gap-0.5 overflow-auto">
      <li v-for="(column, i) in ordered" :key="column" class="flex items-center gap-1">
        <DsCheckbox
          class="min-w-0 flex-1 truncate font-mono"
          :model-value="!hidden.has(column)"
          :label="column"
          @update:model-value="setShown(column, $event)"
        />
        <button
          type="button"
          class="rounded p-1 text-fg-subtle hover:bg-subtle disabled:opacity-30"
          :aria-label="t('documents.columns.moveUp', { name: column })"
          :disabled="i === 0"
          @click="move(i, -1)"
        >
          <ArrowUp class="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="rounded p-1 text-fg-subtle hover:bg-subtle disabled:opacity-30"
          :aria-label="t('documents.columns.moveDown', { name: column })"
          :disabled="i === ordered.length - 1"
          @click="move(i, 1)"
        >
          <ArrowDown class="size-3" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <div class="mt-2 flex justify-end gap-1 border-t border-line pt-2">
      <DsButton size="sm" @click="update({ hidden: [] })">{{ t('documents.columns.showAll') }}</DsButton>
      <DsButton size="sm" @click="update({ order: [] })">{{ t('documents.columns.resetOrder') }}</DsButton>
    </div>
  </DsPopover>
</template>
