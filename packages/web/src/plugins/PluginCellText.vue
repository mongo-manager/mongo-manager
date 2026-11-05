<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DsTooltip from '@/ds/DsTooltip.vue'
import { useMaskedPath } from '@/masking/useMaskedPaths'
import { toShell } from '@/documents/values'
import { localized, usePluginsStore } from './store'
import { cellTextsFor, useCellPlace } from './cells'

/**
 * Phase 4b §3: what plugins' cell renderers say about a value, drawn by the app as plain text —
 * beside the value, or, for a renderer that asks for it (user request 2026-10-13: "zaman
 * etiketlerini yanlarına yazma, ObjectId üzerine geldiğimizde tooltip ile göstersin"), in a tooltip
 * over the value this component wraps (its default slot). The tooltip shows when `host` (the cell,
 * the row) is hovered or focused; a screen reader reads its text with the value.
 */
const props = defineProps<{
  value: unknown
  path?: readonly string[]
  /** The ancestor that shows the tooltip when hovered or focused (DsTooltip `host`). */
  host?: string
  /** The tooltip starts with the whole value (clipped): the cell may show it cut short. */
  showValue?: boolean
}>()
defineSlots<{ default?(props: { tipped: boolean }): unknown }>()
const { locale } = useI18n()
const plugins = usePluginsStore()
const isMasked = useMaskedPath()
const place = useCellPlace()
/**
 * The field's path as MongoDB names it: positions in arrays left out (items.0.productId is
 * items.productId), so a renderer reads one field, not one per element.
 */
const fieldPath = computed(() => (props.path ? props.path.filter((p) => !/^\d+$/.test(p)).join('.') : null))
const texts = computed(() => {
  if (!plugins.cellPlugins.length || !plugins.renderers.size) return []
  // A hidden personal value is never sent to a plugin.
  if (props.value === '***' && props.path && isMasked.value(props.path)) return []
  return cellTextsFor(plugins.cellPlugins, plugins.renderers, props.value, fieldPath.value, place())
})
const beside = computed(() => texts.value.filter((c) => c.display !== 'tooltip'))
const tips = computed(() => texts.value.filter((c) => c.display === 'tooltip'))

const MAX_LABEL = 200
/** Built only for a tooltip that shows: a whole subtree is never written out for nothing (I3). */
const label = computed(() => {
  if (!props.showValue || !tips.value.length) return ''
  const text = toShell(props.value, 0)
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text
})
/** A plugin's line is marked with its name: it never reads as the app's own (review M1). */
const nameOf = (id: string) => {
  const plugin = plugins.cellPlugins.find((p) => p.id === id)
  return plugin ? localized(plugin.name, locale.value) : id
}
const tipText = computed(() =>
  [label.value, ...tips.value.map((c) => `${nameOf(c.plugin)}: ${c.text}`)].filter(Boolean).join('\n'),
)
const TONES = {
  neutral: 'bg-subtle text-fg-muted',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const
</script>

<template>
  <template v-if="$slots.default">
    <slot v-if="!plugins.cellPlugins.length" :tipped="false" />
    <!-- One wrapper whether or not a tooltip has come: the value is never drawn twice (review M3). -->
    <DsTooltip
      v-else
      :text="tipText"
      :disabled="!tips.length"
      :host="host"
      wide
      anchor-class="min-w-0 max-w-full"
    >
      <span data-plugin-tip class="min-w-0 truncate"
        ><slot :tipped="tips.length > 0" /><span v-if="tips.length" class="sr-only select-none">{{
          tips.map((c) => ` ${nameOf(c.plugin)}: ${c.text}`).join(',')
        }}</span></span
      >
      <template #content>
        <span v-if="label" class="block">{{ label }}</span>
        <span v-for="cell in tips" :key="cell.plugin" class="block"
          ><span class="opacity-70">{{ nameOf(cell.plugin) }}:</span> {{ cell.text }}</span
        >
      </template>
    </DsTooltip>
  </template>
  <span
    v-for="cell in beside"
    :key="cell.plugin"
    data-plugin-cell
    class="ml-1.5 inline-block max-w-48 shrink-0 truncate rounded px-1.5 align-middle text-[11px] leading-[18px]"
    :class="TONES[cell.tone]"
    :title="cell.text"
    >{{ cell.text }}</span
  >
</template>
