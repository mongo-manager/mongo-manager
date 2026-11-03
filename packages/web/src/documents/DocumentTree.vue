<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsMenu from '@/ds/DsMenu.vue'
import type { Row, RowAction } from './rows'
import { rowId, rowMenuItems } from './rowMenu'
import { useRowExtras } from './rowExtras'
import TreeNode from './TreeNode.vue'

const props = defineProps<{ rows: Row[]; canWrite: boolean }>()
const emit = defineEmits<{ action: [kind: RowAction, row: Row] }>()
const { t } = useI18n()
const extras = useRowExtras()
const menus = computed(
  () =>
    new Map(
      props.rows.map((row) => [
        row.key,
        { items: rowMenuItems(row, props.canWrite, t, extras.value), id: rowId(row) },
      ]),
    ),
)
</script>

<template>
  <div class="h-full overflow-auto p-3">
    <ol class="flex flex-col gap-2">
      <li
        v-for="row in rows"
        :key="row.key"
        class="relative rounded-lg border border-line bg-surface p-3 pr-10 [contain-intrinsic-size:auto_120px] [content-visibility:auto]"
      >
        <div class="absolute top-2 right-2">
          <DsMenu
            v-if="menus.get(row.key)?.items.length"
            focusable
            :label="t('documents.actions', { id: menus.get(row.key)!.id })"
            :items="menus.get(row.key)!.items"
            @select="emit('action', $event as RowAction, row)"
          />
        </div>
        <ul v-if="row.kind === 'document'">
          <TreeNode
            v-for="(value, name) in row.value"
            :key="name"
            :name="String(name)"
            :value="value"
            :depth="0"
          />
        </ul>
        <p v-else class="text-ui text-warning">
          {{ t('documents.unsupported', { reason: row.reason }) }}
        </p>
      </li>
    </ol>
  </div>
</template>
