<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import type { Component } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import DsMenu from './DsMenu.vue'
import type { DsMenuItem } from './menu'

/** UI redesign R1 revision 2 §2: a main action and a menu of related ones, joined. */
withDefaults(
  defineProps<{
    label: string
    icon?: Component
    items: DsMenuItem[]
    menuLabel: string
    variant?: 'primary' | 'secondary'
  }>(),
  { icon: undefined, variant: 'primary' },
)
const emit = defineEmits<{ click: []; select: [id: string] }>()
</script>

<template>
  <div class="inline-flex shrink-0 items-stretch rounded-lg shadow-xs">
    <button
      type="button"
      class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-l-lg pr-2.5 pl-3 text-ui font-medium whitespace-nowrap transition-colors duration-120 ease-out-soft"
      :class="
        variant === 'primary'
          ? 'bg-accent text-on-accent hover:bg-accent-hover'
          : 'border border-line-strong bg-surface text-fg hover:bg-subtle'
      "
      @click="emit('click')"
    >
      <component :is="icon" v-if="icon" class="size-4" aria-hidden="true" />
      {{ label }}
    </button>
    <DsMenu
      :label="menuLabel"
      :icon="ChevronDown"
      :items="items"
      focusable
      :trigger-class="
        [
          'inline-flex h-8 w-7 cursor-pointer items-center justify-center rounded-r-lg border-l transition-colors duration-120',
          variant === 'primary'
            ? 'border-on-accent/20 bg-accent text-on-accent hover:bg-accent-hover'
            : 'border-line-strong border-y border-r bg-surface text-fg-muted hover:bg-subtle',
        ].join(' ')
      "
      @select="emit('select', $event)"
    />
  </div>
</template>
