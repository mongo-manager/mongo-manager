<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import ValueCell from './ValueCell.vue'
import { typeOf } from './values'
import TreeNode from './TreeNode.vue'
import PluginCellText from '@/plugins/PluginCellText.vue'

const props = defineProps<{
  name: string
  value: unknown
  depth: number
  path?: readonly string[]
  /** Open from the start (the inspector opens the first level). */
  open?: boolean
}>()
/** The field's path from the document root (phase 3c: hidden values are marked by path). */
const here = computed(() => props.path ?? [props.name])
const { t } = useI18n()
const PAGE = 100
const expanded = ref(props.open ?? false)
const shown = ref(PAGE)
const type = computed(() => typeOf(props.value))
const isContainer = computed(() => type.value === 'array' || type.value === 'object')
const entries = computed<Array<[string, unknown]>>(() => {
  if (!isContainer.value) return []
  return Array.isArray(props.value)
    ? props.value.map((v, i): [string, unknown] => [String(i), v])
    : Object.entries(props.value as Record<string, unknown>)
})
const remaining = computed(() => Math.min(PAGE, entries.value.length - shown.value))
</script>

<template>
  <li>
    <div
      data-tree-row
      class="flex min-w-0 items-baseline gap-2 rounded-md py-[3px] pr-1 font-mono text-[12.5px] leading-5 hover:bg-subtle/70"
      :style="{ paddingLeft: `${depth * 16 + 4}px` }"
    >
      <button
        v-if="isContainer"
        type="button"
        class="grid size-4 shrink-0 cursor-pointer place-items-center self-center rounded text-fg-subtle hover:text-fg"
        :aria-expanded="expanded"
        :aria-label="expanded ? t('documents.collapse', { name }) : t('documents.expand', { name })"
        @click="expanded = !expanded"
      >
        <ChevronRight
          class="size-3.5 transition-transform duration-150"
          :class="expanded ? 'rotate-90' : ''"
          aria-hidden="true"
        />
      </button>
      <span v-else class="w-4 shrink-0" aria-hidden="true" />
      <span class="min-w-[6.5rem] shrink-0 text-v-key">{{ name }}</span>
      <!-- What plugins say of a nested value too (user report: items.productId had no reference):
           beside it, or in a tooltip the row shows when hovered. -->
      <PluginCellText :value="value" :path="here" host="[data-tree-row]" show-value>
        <span class="min-w-0 truncate"><ValueCell :value="value" present quoted :path="here" /></span>
      </PluginCellText>
      <span class="ml-auto shrink-0 pl-3 font-sans text-caption text-fg-subtle">{{ type }}</span>
    </div>
    <ul v-if="isContainer && expanded">
      <TreeNode
        v-for="[key, child] in entries.slice(0, shown)"
        :key="key"
        :name="key"
        :value="child"
        :depth="depth + 1"
        :path="[...here, key]"
      />
      <li v-if="remaining > 0" :style="{ paddingLeft: `${(depth + 1) * 16 + 28}px` }">
        <button
          type="button"
          class="cursor-pointer py-0.5 text-small text-accent-fg hover:underline"
          @click="shown += PAGE"
        >
          {{ t('documents.showMore', { count: remaining }) }}
        </button>
      </li>
    </ul>
  </li>
</template>
