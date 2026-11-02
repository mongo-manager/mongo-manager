<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  PanelLeftClose,
  Settings2,
  Trash2,
  WrapText,
} from 'lucide-vue-next'
import { WIDGET_SIZES, type WidgetSize } from '@mongo-manager/shared/browser'
import DsCard from '@/ds/DsCard.vue'
import type { DsMenuItem } from '@/ds/menu'
import { useWidget } from './context'
import { useWideScreen } from './grid'

/**
 * User review 2026-10-09: a widget on the Overview — its card, with collapse and remove; in edit mode
 * also a handle to drag it (or move it by keyboard), its width, moves and settings. Outside a dashboard
 * it is a plain card.
 */
withDefaults(defineProps<{ title: string; count?: number }>(), { count: undefined })
const { t } = useI18n()
const widget = useWidget()
const ctx = computed(() => widget?.value ?? null)
const wide = useWideScreen()

const items = computed<DsMenuItem[]>(() => {
  const c = ctx.value
  if (!c?.editing) return []
  return [
    ...WIDGET_SIZES.map((size) => ({
      id: `size:${size}`,
      label: t(`overview.dashboard.sizes.${size}`),
      icon: c.widget.size === size ? Check : undefined,
    })),
    ...(c.position > 0
      ? [{ id: 'up', label: t('overview.dashboard.moveUp'), icon: ArrowUp, separator: true }]
      : []),
    ...(c.position < c.count - 1
      ? [
          {
            id: 'down',
            label: t('overview.dashboard.moveDown'),
            icon: ArrowDown,
            separator: c.position === 0,
          },
        ]
      : []),
    ...(!wide.value
      ? []
      : [
          c.widget.col !== undefined
            ? {
                id: 'gap:close',
                label: t('overview.dashboard.closeGap'),
                icon: PanelLeftClose,
                separator: true,
              }
            : { id: 'gap:row', label: t('overview.dashboard.newRow'), icon: WrapText, separator: true },
        ]),
    ...(c.configurable
      ? [{ id: 'settings', label: t('overview.dashboard.settings'), icon: Settings2, separator: true }]
      : []),
    { id: 'remove', label: t('overview.dashboard.remove'), icon: Trash2, danger: true, separator: true },
  ]
})
function onSelect(id: string): void {
  const c = ctx.value
  if (!c) return
  if (id.startsWith('size:')) c.resize(id.slice(5) as WidgetSize)
  else if (id === 'up') c.move(-1)
  else if (id === 'down') c.move(1)
  else if (id === 'gap:row') c.setColumn(1)
  else if (id === 'gap:close') c.setColumn(null)
  else if (id === 'settings') c.configure()
  else if (id === 'remove') c.remove()
}
</script>

<template>
  <div
    :data-widget="ctx?.widget.type"
    :data-widget-id="ctx?.widget.id"
    class="h-full"
    :class="ctx?.editing ? 'rounded-card outline-1 outline-offset-4 outline-line-strong outline-dashed' : ''"
  >
    <DsCard
      class="h-full"
      :level="2"
      :title="title"
      :count="count"
      :collapsed="ctx?.widget.collapsed ?? false"
      :menu-label="t('overview.dashboard.options', { title })"
      :collapse-label="t('home.collapse')"
      :expand-label="t('home.expand')"
      :hide-label="ctx && !ctx.editing ? t('overview.dashboard.remove') : undefined"
      :items="items"
      :actions-shown="ctx?.editing ?? false"
      @update:collapsed="ctx?.setCollapsed($event)"
      @hide="ctx?.remove()"
      @select="onSelect"
    >
      <template v-if="ctx?.editing && ctx.handle" #lead>
        <button
          type="button"
          data-widget-handle
          class="-ml-1.5 grid size-7 shrink-0 cursor-grab pointer-coarse:size-11 place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-focus active:cursor-grabbing"
          :aria-label="t('overview.dashboard.move', { title })"
          v-bind="ctx.handle"
        >
          <GripVertical class="size-4" aria-hidden="true" />
        </button>
      </template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
      <slot />
    </DsCard>
  </div>
</template>
