<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, useId } from 'vue'
import { ChevronDown, Ellipsis } from 'lucide-vue-next'
import DsMenu from './DsMenu.vue'
import type { DsMenuItem } from './menu'

/**
 * UI redesign R1 revision 2 §2: a module of the workspace. A region named by its title, with a count,
 * actions that show on hover or focus, and a menu to collapse or hide it.
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** A number, or words for one ("50+": more than it lists). */
    count?: number | string
    collapsed?: boolean
    /** The menu's words, from the caller (the kit speaks the caller's language). */
    menuLabel?: string
    collapseLabel?: string
    expandLabel?: string
    hideLabel?: string
    /** More menu entries, before collapse and hide; chosen ones come back as `select`. */
    items?: DsMenuItem[]
    /** Its actions and menu shown all the time (not only on hover or focus). */
    actionsShown?: boolean
    /** Its title's level: under a page's title (h2) by default; Home's widgets, under its h1, ask for 2. */
    level?: 2 | 3
  }>(),
  {
    count: undefined,
    collapsed: false,
    menuLabel: undefined,
    collapseLabel: undefined,
    expandLabel: undefined,
    hideLabel: undefined,
    items: () => [],
    actionsShown: false,
    level: 3,
  },
)
const emit = defineEmits<{ 'update:collapsed': [value: boolean]; hide: []; select: [id: string] }>()
/** It folds only when the caller gives the words for it (and keeps `collapsed`). */
const foldable = computed(() => Boolean(props.collapseLabel && props.expandLabel))
const titleId = useId()
const bodyId = useId()
const menu = computed<DsMenuItem[]>(() => [
  ...props.items,
  ...(props.collapseLabel && props.expandLabel
    ? [
        {
          id: 'collapse',
          label: props.collapsed ? props.expandLabel : props.collapseLabel,
          icon: ChevronDown,
        },
      ]
    : []),
  ...(props.hideLabel ? [{ id: 'hide', label: props.hideLabel }] : []),
])
function onSelect(id: string): void {
  if (id === 'collapse') emit('update:collapsed', !props.collapsed)
  else if (id === 'hide') emit('hide')
  else emit('select', id)
}
</script>

<template>
  <section
    :aria-labelledby="titleId"
    class="group/card flex min-w-0 flex-col rounded-card border border-line bg-surface shadow-xs"
  >
    <header class="flex min-h-11 items-center gap-2 px-4 pt-3" :class="collapsed ? 'pb-3' : 'pb-1'">
      <slot name="lead" />
      <!-- Review of K+R2 (I3): a card that folds has its button inside the heading; one that does not
           has a plain heading — never a button that does nothing. -->
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <component :is="`h${level}`" :id="titleId" class="min-w-0 text-ui font-semibold text-fg">
          <button
            v-if="foldable"
            type="button"
            class="flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            :aria-expanded="!collapsed"
            :aria-controls="bodyId"
            @click="emit('update:collapsed', !collapsed)"
          >
            <span class="truncate">{{ title }}</span>
            <ChevronDown
              class="size-3.5 shrink-0 text-fg-subtle opacity-0 transition-[transform,opacity] duration-160 group-hover/card:opacity-100"
              :class="collapsed ? '-rotate-90 opacity-100' : ''"
              aria-hidden="true"
            />
          </button>
          <span v-else class="block truncate">{{ title }}</span>
        </component>
        <span v-if="count !== undefined" class="text-small text-fg-subtle tabular-nums">{{ count }}</span>
      </div>
      <div
        class="flex shrink-0 items-center gap-1 transition-opacity duration-120 group-hover/card:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100"
        :class="actionsShown ? 'opacity-100' : 'opacity-0'"
      >
        <slot name="actions" />
        <DsMenu
          v-if="menu.length && menuLabel"
          :label="menuLabel"
          :icon="Ellipsis"
          :items="menu"
          focusable
          touch
          @select="onSelect"
        />
      </div>
    </header>
    <div v-if="!collapsed" :id="bodyId" class="min-w-0 px-4 pt-1 pb-4">
      <slot />
    </div>
  </section>
</template>
