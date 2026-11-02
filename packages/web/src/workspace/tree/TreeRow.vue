<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import { useTreeStore } from '@/stores/tree'

const props = defineProps<{
  nodeKey: string
  label: string
  level: number
  expandable?: boolean
  menuItems?: DsMenuItem[]
  menuLabel?: string
  testId?: string
  /** The open tab shows this item (UI redesign R1 spec §3). */
  current?: boolean
}>()
const emit = defineEmits<{ open: []; select: [id: string] }>()
const { t } = useI18n()
const tree = useTreeStore()
const menu = ref<InstanceType<typeof DsMenu> | null>(null)
const expanded = computed(() => Boolean(props.expandable) && tree.isExpanded(props.nodeKey))
const hasMenu = computed(() => (props.menuItems?.length ?? 0) > 0)
// The open tab's row is brought into sight when it appears or becomes the open one (a long tree).
const item = ref<HTMLElement | null>(null)
const reveal = () => {
  if (props.current) item.value?.scrollIntoView?.({ block: 'nearest' })
}
onMounted(reveal)
watch(() => props.current, reveal)

function activate(): void {
  if (props.expandable && !expanded.value) tree.setExpanded(props.nodeKey, true)
  emit('open')
}

function openMenu(): void {
  if (hasMenu.value) void menu.value?.openMenu()
}

/** Keys owned by this item; Up/Down/Home/End are handled by the tree root. */
function onKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  const item = event.currentTarget as HTMLElement
  switch (event.key) {
    case 'ArrowRight':
      if (props.expandable && !expanded.value) tree.setExpanded(props.nodeKey, true)
      else item.querySelector<HTMLElement>('[role="group"] > [role="treeitem"]')?.focus()
      break
    case 'ArrowLeft':
      if (expanded.value) tree.setExpanded(props.nodeKey, false)
      else item.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus()
      break
    case 'Enter':
      activate()
      break
    case ' ':
      if (props.expandable) tree.toggle(props.nodeKey)
      break
    case 'ContextMenu':
      openMenu()
      break
    case 'F10':
      if (!event.shiftKey) return
      openMenu()
      break
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
}
</script>

<template>
  <li
    ref="item"
    role="treeitem"
    :aria-label="label"
    aria-keyshortcuts="Enter Space Shift+F10 ContextMenu"
    :aria-level="level"
    :aria-expanded="expandable ? expanded : undefined"
    :aria-current="current ? 'page' : undefined"
    :data-key="nodeKey"
    :tabindex="tree.focused === nodeKey ? 0 : -1"
    class="outline-none"
    @keydown="onKeydown"
    @focus="tree.focused = nodeKey"
  >
    <div
      class="group relative flex h-(--row-height) cursor-pointer items-center gap-1.5 rounded-md pr-1 text-ui transition-colors duration-120 ease-out-soft [li:focus-visible>&]:outline-2 [li:focus-visible>&]:-outline-offset-2 [li:focus-visible>&]:outline-focus"
      :class="current ? 'bg-accent-soft font-medium text-fg' : 'text-fg-muted hover:bg-subtle hover:text-fg'"
      :style="{ paddingLeft: `${(level - 1) * 14 + 4}px` }"
      :title="label"
      :data-test="testId"
      @click="activate"
      @contextmenu.prevent="openMenu"
    >
      <span
        v-if="current"
        class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent"
        aria-hidden="true"
      />
      <button
        v-if="expandable"
        type="button"
        tabindex="-1"
        class="grid size-4.5 shrink-0 cursor-pointer place-items-center rounded text-fg-subtle hover:text-fg"
        :aria-label="expanded ? t('tree.collapse', { name: label }) : t('tree.expand', { name: label })"
        @click.stop="tree.toggle(nodeKey)"
      >
        <ChevronRight
          class="size-3.5 transition-transform duration-160 ease-out-soft"
          :class="expanded ? 'rotate-90' : ''"
          aria-hidden="true"
        />
      </button>
      <span v-else class="w-4.5 shrink-0" aria-hidden="true" />
      <slot name="icon" />
      <span class="min-w-0 flex-1 truncate">{{ label }}</span>
      <slot name="badges" />
      <span
        v-if="hasMenu"
        class="opacity-0 group-hover:opacity-100 [li:focus>div>&]:opacity-100 has-[[aria-expanded=true]]:opacity-100"
        @click.stop
      >
        <DsMenu
          ref="menu"
          :label="menuLabel ?? label"
          :items="menuItems ?? []"
          @select="emit('select', $event)"
        />
      </span>
    </div>
    <ul v-if="expanded" role="group">
      <slot />
    </ul>
  </li>
</template>
