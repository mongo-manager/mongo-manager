<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Lock, Pencil } from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { DsMenuItem } from '@/ds/menu'
import PluginCellText from '@/plugins/PluginCellText.vue'
import ValueCell from '../ValueCell.vue'
import { valueTone } from '../valueTone'
import { shownText, type DocMatch } from './search'
import { TREE_FOCUS, dottedPath, type FieldLine } from './treeModel'
import MarkedText from './MarkedText.vue'
import TreeValueEditor, { type EditorInput, type EditorKind } from './TreeValueEditor.vue'

/**
 * Document page design §6.4, §6.5: one line of the document tree — a field, its value, its actions.
 * Review 2026-11-07 (performance): a line of its own, that reads the tree's focus itself, so a move
 * of the focus renders again the two lines it left and reached, not every line of the tree.
 */
type Mark = DocMatch & { current: boolean }
const props = defineProps<{
  line: FieldLine
  marks?: { key?: Mark; value?: Mark }
  dimmed: boolean
  changed: boolean
  hidden: boolean
  locked: boolean
  canEdit: boolean
  menu: DsMenuItem[]
  /** The editor open on this line (a value or a name in it; a new field or item under it). */
  editing: { kind: EditorKind; error: string } | null
}>()
const emit = defineEmits<{
  focus: []
  toggle: []
  edit: [kind: EditorKind]
  menu: [id: string]
  apply: [input: EditorInput]
  cancel: []
}>()
const { t } = useI18n()
const focusedKey = inject(TREE_FOCUS)!
const focused = computed(() => focusedKey.value === props.line.key)
const menuEl = ref<InstanceType<typeof DsMenu> | null>(null)
defineExpose({ openMenu: async () => menuEl.value?.openMenu() })

const inLine = computed(() => props.editing?.kind === 'value' || props.editing?.kind === 'rename')
const under = computed(() => props.editing?.kind === 'field' || props.editing?.kind === 'item')
/** A string is shown in quotes, as the shell writes it. */
const quote = computed(() => (props.line.type === 'string' ? '"' : ''))
const iconButton =
  'grid size-6 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-muted hover:text-fg'
</script>

<template>
  <li
    role="treeitem"
    :data-key="line.key"
    :data-path="dottedPath(line.path)"
    :aria-level="line.depth + 1"
    :aria-posinset="line.index"
    :aria-setsize="line.setSize"
    :aria-expanded="line.container ? line.open : undefined"
    :aria-selected="focused"
    :tabindex="focused ? 0 : -1"
    :data-dimmed="dimmed ? '' : undefined"
    :data-changed="changed ? '' : undefined"
    class="group/line relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
    :class="[dimmed ? 'opacity-45' : '', focused ? 'bg-subtle/70' : 'hover:bg-subtle/50']"
    @click="emit('focus')"
    @dblclick="canEdit && emit('edit', 'value')"
  >
    <div
      data-tree-row
      class="flex min-w-0 items-center gap-2 border-l-2 py-[3px] pr-2 font-mono text-[12.5px] leading-5"
      :class="changed ? 'border-accent' : 'border-transparent'"
      :style="{ paddingLeft: `${line.depth * 16 + 4}px` }"
    >
      <button
        v-if="line.container"
        type="button"
        tabindex="-1"
        class="grid size-4 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle hover:text-fg"
        :aria-label="
          line.open
            ? t('documents.collapse', { name: line.name })
            : t('documents.expand', { name: line.name })
        "
        @click.stop="emit('toggle')"
      >
        <ChevronRight
          class="size-3.5 transition-transform duration-150"
          :class="line.open ? 'rotate-90' : ''"
          aria-hidden="true"
        />
      </button>
      <span v-else class="w-4 shrink-0" aria-hidden="true" />
      <span class="min-w-[7rem] shrink-0 text-v-key"
        ><MarkedText :text="line.name" :mark="marks?.key"
      /></span>
      <TreeValueEditor
        v-if="editing && inLine"
        :kind="editing.kind"
        :name="line.name"
        :value="line.value"
        :error="editing.error"
        @apply="emit('apply', $event)"
        @cancel="emit('cancel')"
      />
      <template v-else>
        <span v-if="hidden" data-masked class="inline-flex items-center gap-1 text-fg-subtle">
          <Lock class="size-3" aria-hidden="true" />
          <MarkedText
            :text="t('masking.hidden')"
            :mark="
              marks?.value
                ? { start: 0, end: t('masking.hidden').length, current: marks.value.current }
                : null
            "
          />
        </span>
        <span
          v-else-if="marks?.value && !line.container"
          class="min-w-0 truncate"
          :class="valueTone(line.type)"
          >{{ quote }}<MarkedText :text="shownText(line.value)" :mark="marks.value" />{{ quote }}</span
        >
        <PluginCellText v-else :value="line.value" :path="line.path" host="[data-tree-row]" show-value>
          <span class="min-w-0 truncate"
            ><ValueCell :value="line.value" present quoted :path="line.path"
          /></span>
        </PluginCellText>
      </template>
      <span v-if="changed" class="sr-only">{{ t('documents.docPage.changed') }}</span>
      <span class="ml-auto shrink-0 pl-3 font-sans text-caption text-fg-subtle">{{ line.type }}</span>
      <span
        v-if="!locked && !editing"
        data-tree-actions
        class="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/line:opacity-100 group-hover/line:opacity-100 pointer-coarse:opacity-100"
      >
        <DsTooltip v-if="canEdit" :text="t('documents.docPage.editValue', { name: line.name })">
          <button
            type="button"
            tabindex="-1"
            :class="iconButton"
            :aria-label="t('documents.docPage.editValue', { name: line.name })"
            @click.stop="emit('edit', 'value')"
          >
            <Pencil class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsMenu
          ref="menuEl"
          :label="t('documents.docPage.fieldActions', { name: line.name })"
          :items="menu"
          @select="emit('menu', $event)"
        />
      </span>
    </div>
    <div
      v-if="editing && under"
      class="py-1 pr-2"
      :style="{ paddingLeft: `${(line.depth + 1) * 16 + 24}px` }"
    >
      <TreeValueEditor
        :kind="editing.kind"
        :name="line.name"
        :error="editing.error"
        @apply="emit('apply', $event)"
        @cancel="emit('cancel')"
      />
    </div>
  </li>
</template>
