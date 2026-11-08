<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsPopover from '@/ds/DsPopover.vue'
import TreeNode from './TreeNode.vue'
import { summarize } from './values'

/** An object or array in a table cell: its size, opening its tree in a popover (row height never changes). */
const props = defineProps<{
  value: unknown
  label: string
  /** The cell's field: its values' paths start there (masking, plugins). */
  path?: readonly string[]
}>()
const { t } = useI18n()
const summary = computed(() => summarize(props.value))
const entries = computed<Array<[string, unknown]>>(() =>
  Array.isArray(props.value)
    ? props.value.map((v, i): [string, unknown] => [String(i), v])
    : Object.entries(props.value as Record<string, unknown>),
)
</script>

<template>
  <DsPopover
    :label="label"
    trigger-class="rounded px-1 text-fg-subtle underline decoration-dotted underline-offset-2 hover:bg-subtle hover:text-fg"
    panel-class="w-[32rem]"
  >
    <template #trigger>
      {{
        summary.kind === 'array'
          ? t('documents.arrayItems', { count: summary.count }, summary.count)
          : t(
              'documents.objectFields',
              { count: summary.kind === 'object' ? summary.count : 0 },
              summary.kind === 'object' ? summary.count : 0,
            )
      }}
    </template>
    <ul class="font-mono">
      <TreeNode
        v-for="[name, child] in entries"
        :key="name"
        :name="name"
        :value="child"
        :depth="0"
        :path="[...(path ?? []), name]"
      />
    </ul>
  </DsPopover>
</template>
