<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Widget } from '@mongo-manager/shared/browser'
import { useDashboardStore } from '@/stores/dashboard'
import { useToastStore } from '@/stores/toasts'
import { WIDGET_CONTEXT, type WidgetContext } from './context'
import { WIDGETS } from './registry'

/**
 * User review 2026-10-09: one widget on the dashboard — its kind's component, given what its frame
 * needs (the widget, edit mode, its place, and the store's changes).
 */
const props = withDefaults(
  defineProps<{
    widget: Widget
    position: number
    count: number
    editing: boolean
    /** The drag handle's bindings, from the dashboard (edit mode). */
    handle?: Record<string, unknown> | null
  }>(),
  { handle: null },
)
const emit = defineEmits<{ configure: [widget: Widget] }>()
const { t } = useI18n()
const store = useDashboardStore()
const def = computed(() => WIDGETS[props.widget.type])
const toasts = useToastStore()
/** Removed at once, with Undo (final review: a removal is never a dead end). */
function removeWithUndo(): void {
  const widget = props.widget
  const at = store.widgets.findIndex((w) => w.id === widget.id)
  const title = def.value ? t(def.value.title) : widget.type
  store.remove(widget.id)
  toasts.push({
    kind: 'info',
    message: t('overview.dashboard.removed', { title }),
    actions: [{ label: t('overview.dashboard.undo'), run: () => store.restore(widget, at) }],
  })
}
const context = computed<WidgetContext>(() => ({
  widget: props.widget,
  title: def.value ? t(def.value.title) : props.widget.type,
  editing: props.editing,
  position: props.position,
  count: props.count,
  configurable: (def.value?.settings ?? 'none') !== 'none',
  handle: props.editing ? (props.handle ?? {}) : null,
  remove: () => removeWithUndo(),
  resize: (size) => store.resize(props.widget.id, size),
  move: (delta) => store.move(props.widget.id, props.position + delta),
  setColumn: (col) => store.setColumn(props.widget.id, col),
  configure: () => emit('configure', props.widget),
  setCollapsed: (value) => store.setCollapsed(props.widget.id, value),
}))
provide(WIDGET_CONTEXT, context)
</script>

<template>
  <component :is="def.component" v-if="def" v-bind="def.props?.(widget) ?? {}" />
</template>
