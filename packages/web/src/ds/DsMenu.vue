<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, type Component } from 'vue'
import { EllipsisVertical } from 'lucide-vue-next'
import { ariaKeys, keyLabel } from '@/workspace/shortcuts'
import type { DsMenuItem } from './menu'
import { place, type Placement } from './position'

/**
 * UI redesign R1 spec §2: a menu of actions. Keyboard: arrows, Home, End, Enter, Space, Escape (focus
 * goes back to whatever opened it), Tab closes. Disabled items are skipped. It closes when its anchor
 * moves (scroll) or the window resizes.
 */
const props = withDefaults(
  defineProps<{
    label: string
    items: DsMenuItem[]
    focusable?: boolean
    alert?: string
    /** Show the label as the trigger's text (a toolbar button), with this icon before it. */
    text?: boolean
    icon?: Component
    /** sm: in a row; md: beside a toolbar's controls; header: beside small buttons (a header's, a card's). */
    size?: 'sm' | 'md' | 'header'
    triggerClass?: string
    placement?: Placement
    /** A 44 px trigger on touch screens (cards' menus: final review 5). */
    touch?: boolean
  }>(),
  { alert: undefined, icon: undefined, size: 'sm', triggerClass: undefined, placement: 'bottom-end' },
)
const emit = defineEmits<{ select: [id: string] }>()
const triggerLabel = computed(() => (props.alert ? `${props.label}, ${props.alert}` : props.label))
const itemLabel = (item: DsMenuItem) => (item.badge ? `${item.label}, ${item.badge.label}` : undefined)
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const position = ref({ top: 0, left: 0 })
const menuId = useId()
let returnFocus: HTMLElement | null = null
let anchorTop = 0
let anchorLeft = 0

const enabled = () =>
  Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])

function onOutside(event: Event): void {
  const target = event.target as Node
  if (!menu.value?.contains(target) && !trigger.value?.contains(target)) close(false)
}
const onResize = () => close(false)
function onScroll(): void {
  const rect = (trigger.value ?? returnFocus)?.getBoundingClientRect()
  if (!rect || Math.abs(rect.top - anchorTop) > 1 || Math.abs(rect.left - anchorLeft) > 1) close(false)
}
function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  document[method]('pointerdown', onOutside, true)
  window[method]('scroll', onScroll, true)
  window[method]('resize', onResize)
}

async function openMenu(): Promise<void> {
  const active = document.activeElement as HTMLElement | null
  returnFocus = active && active !== document.body ? active : trigger.value
  const rect = (trigger.value ?? returnFocus)?.getBoundingClientRect()
  anchorTop = rect?.top ?? 0
  anchorLeft = rect?.left ?? 0
  open.value = true
  listen(true)
  await nextTick()
  const box = menu.value?.getBoundingClientRect()
  if (rect && box) position.value = place(rect, box, props.placement, 4)
  enabled()[0]?.focus()
}

function close(restore = true): void {
  if (!open.value) return
  open.value = false
  listen(false)
  if (restore) (returnFocus ?? trigger.value)?.focus()
}

function choose(item: DsMenuItem): void {
  if (item.disabled) return
  close()
  emit('select', item.id)
}

function onKeydown(event: KeyboardEvent): void {
  const items = enabled()
  const index = items.indexOf(document.activeElement as HTMLElement)
  const focus = (i: number) => items[(i + items.length) % items.length]?.focus()
  if (event.key === 'ArrowDown') focus(index + 1)
  else if (event.key === 'ArrowUp') focus(index - 1)
  else if (event.key === 'Home') focus(0)
  else if (event.key === 'End') focus(items.length - 1)
  else if (event.key === 'Escape') close()
  else if (event.key === 'Tab') close(false)
  else if (event.key === 'Enter' || event.key === ' ') {
    const id = items[index]?.dataset.id
    const item = props.items.find((i) => i.id === id)
    if (item) choose(item)
  } else return
  if (event.key !== 'Tab') event.preventDefault()
  event.stopPropagation()
}

onBeforeUnmount(() => close(false))
defineExpose({ openMenu })
</script>

<template>
  <button
    ref="trigger"
    type="button"
    :tabindex="focusable || text ? 0 : -1"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-controls="open ? menuId : undefined"
    :aria-label="text && !alert ? undefined : triggerLabel"
    class="relative inline-flex shrink-0 cursor-pointer items-center justify-center transition-[background-color,color] duration-120 ease-out-soft"
    :class="
      triggerClass ??
      (text
        ? 'h-8 gap-1.5 rounded-md px-2.5 text-ui font-medium text-fg-muted hover:bg-subtle hover:text-fg'
        : [
            'rounded-md text-fg-subtle hover:bg-muted hover:text-fg',
            size === 'md' ? 'size-8' : size === 'header' ? 'size-7' : 'size-6',
            touch ? 'pointer-coarse:size-11' : '',
            open ? 'bg-muted text-fg' : '',
          ])
    "
    @click.stop="open ? close() : openMenu()"
  >
    <slot name="trigger"><component :is="icon ?? EllipsisVertical" class="size-4" aria-hidden="true" /></slot>
    <template v-if="text">{{ label }}</template>
    <span
      v-if="alert"
      class="absolute top-0.5 right-0.5 size-2 rounded-full bg-warning ring-2 ring-surface"
      aria-hidden="true"
    />
  </button>
  <Teleport to="body">
    <ul
      v-if="open"
      :id="menuId"
      ref="menu"
      role="menu"
      :aria-label="label"
      class="fixed z-[55] w-max max-w-80 min-w-52 animate-pop rounded-lg bg-raised p-1 text-ui shadow-float"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      data-ds-popup
      @keydown="onKeydown"
      @mousedown.prevent
    >
      <template v-for="item in items" :key="item.id">
        <li v-if="item.separator" role="separator" class="mx-1 my-1 h-px bg-line" />
        <li
          role="menuitem"
          :aria-keyshortcuts="item.shortcut ? ariaKeys(item.shortcut) : undefined"
          tabindex="-1"
          :data-id="item.id"
          :aria-label="itemLabel(item)"
          :aria-disabled="item.disabled ? 'true' : undefined"
          class="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 outline-none"
          :class="[
            item.disabled
              ? 'cursor-default opacity-45'
              : item.danger
                ? 'text-danger focus:bg-danger-soft'
                : 'text-fg focus:bg-subtle',
          ]"
          @click="choose(item)"
          @mousemove="!item.disabled && ($event.currentTarget as HTMLElement).focus()"
        >
          <component
            :is="item.icon"
            v-if="item.icon"
            class="size-4 shrink-0"
            :class="item.danger ? '' : 'text-fg-subtle'"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate">{{ item.label }}</span>
            <span v-if="item.hint" class="block truncate text-small text-fg-subtle">{{ item.hint }}</span>
          </span>
          <span
            v-if="item.badge"
            class="rounded-full bg-warning-soft px-1.5 text-caption font-medium text-warning tabular-nums"
            aria-hidden="true"
            >{{ item.badge.text }}</span
          >
          <span v-if="item.shortcut" class="ml-3 flex gap-0.5 text-small text-fg-subtle" aria-hidden="true">
            <span v-for="k in item.shortcut" :key="k">{{ keyLabel(k) }}</span>
          </span>
        </li>
      </template>
    </ul>
  </Teleport>
</template>
