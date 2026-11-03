<script setup lang="ts">
import { computed, useId, type Component } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { useLayoutStore } from '@/stores/layout'
import SidebarItem from './SidebarItem.vue'
import type { SidebarEntry } from './types'

/**
 * UI redesign R1 revision 2 §3.1: a group of sidebar entries. Expanded, it opens in place (for the session: a reload opens only the group holding the open page);
 * in the rail it is a menu that flies out to the right.
 */
const props = withDefaults(
  defineProps<{ id: string; icon: Component; label: string; items: SidebarEntry[]; collapsed?: boolean }>(),
  { collapsed: false },
)
const emit = defineEmits<{ select: [id: string] }>()
const layout = useLayoutStore()
const listId = useId()
const active = computed(() => props.items.some((i) => i.active))
const open = computed(() => layout.isGroupOpen(props.id, active.value))
const attention = computed(() => props.items.reduce((n, i) => n + (i.badge ?? 0), 0))
const attentionLabel = computed(() =>
  props.items
    .filter((i) => i.badge)
    .map((i) => i.badgeLabel)
    .filter(Boolean)
    .join(' '),
)
const menuItems = computed<DsMenuItem[]>(() =>
  props.items.map((i) => ({
    id: i.id,
    label: i.label,
    icon: i.icon,
    ...(i.badge ? { badge: { text: String(i.badge), label: i.badgeLabel ?? String(i.badge) } } : {}),
  })),
)
</script>

<template>
  <DsMenu
    v-if="collapsed"
    :label="label"
    :icon="icon"
    :items="menuItems"
    :alert="attention ? attentionLabel || String(attention) : undefined"
    focusable
    placement="right-start"
    :trigger-class="
      [
        'relative grid size-9 cursor-pointer place-items-center rounded-lg transition-colors duration-120 ease-out-soft [&>svg]:size-[18px]',
        active ? 'bg-accent-soft text-accent-fg' : 'text-fg-muted hover:bg-muted hover:text-fg',
      ].join(' ')
    "
    @select="emit('select', $event)"
  />
  <div v-else class="flex flex-col">
    <button
      type="button"
      class="group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-ui text-fg-muted transition-colors duration-120 ease-out-soft hover:bg-muted hover:text-fg"
      :aria-label="attention ? `${label}, ${attentionLabel || attention}` : undefined"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      @click="layout.toggleGroup(id, active)"
    >
      <component :is="icon" class="size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-left">{{ label }}</span>
      <span v-if="attention && !open" class="size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
      <ChevronRight
        class="size-3.5 shrink-0 text-fg-subtle transition-transform duration-160 ease-out-soft"
        :class="open ? 'rotate-90' : ''"
        aria-hidden="true"
      />
    </button>
    <ul v-if="open" :id="listId" class="mt-0.5 flex flex-col gap-0.5">
      <li v-for="item in items" :key="item.id">
        <SidebarItem
          nested
          :icon="item.icon"
          :label="item.label"
          :active="item.active"
          :badge="item.badge"
          :badge-label="item.badgeLabel"
          @click="emit('select', item.id)"
        />
      </li>
    </ul>
  </div>
</template>
