<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import DsIconButton from '@/ds/DsIconButton.vue'
import { useTabsStore, type PaneSide, type WorkspaceTab } from '@/stores/tabs'
import { useTabIcon, useTabTitle } from './tabTitle'
import { rememberFocus, useSplitView } from './split'

/**
 * completion W6.1: a pane of the split view, or — with no side — the plain frame a kept tab (a
 * shell, a plugin page, SQL ↔ MongoDB) always sits in. The frame never changes element, so a kept
 * tab moved into a pane or out of one keeps its session, its iframe, its work.
 *
 * In a pane: a landmark named after its tab ("orders, left pane"), a slim header with the tab's name
 * and "Close pane", the accent bar and "Active pane" on the one in use. A pointer or the keyboard's
 * focus going into a pane makes it the one in use.
 */
const props = defineProps<{ tab: WorkspaceTab; side: PaneSide | null; focused?: boolean }>()
const tabs = useTabsStore()
const split = useSplitView()
const { t } = useI18n()
const titleOf = useTabTitle()
const iconOf = useTabIcon()
const title = computed(() => (props.tab.kind === 'collection' ? props.tab.title : titleOf(props.tab)))
const label = computed(() =>
  props.side ? t('split.paneLabel', { title: title.value, side: t(`split.side.${props.side}`) }) : undefined,
)
function use(): void {
  if (props.side && !props.focused) tabs.focusPane(props.side)
}
/** The focus came in: the pane is in use, and the control it reached is kept for coming back. */
function onFocusIn(event: FocusEvent): void {
  rememberFocus(props.tab.id, event.target)
  use()
}
</script>

<template>
  <section
    data-workspace-frame
    :data-tab-id="tab.id"
    tabindex="-1"
    :role="side ? 'region' : undefined"
    :aria-label="label"
    :data-pane="side ?? undefined"
    :data-pane-focused="side ? String(!!focused) : undefined"
    class="focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    :class="side ? 'absolute inset-y-0 flex min-w-0 flex-col overflow-hidden' : 'h-full'"
    @pointerdown.capture="use"
    @focusin="onFocusIn"
  >
    <header
      v-if="side"
      data-pane-header
      class="relative flex h-8 shrink-0 items-center gap-2 border-b border-line pr-1 pl-3 text-small"
      :class="focused ? 'bg-surface text-fg' : 'bg-canvas text-fg-muted'"
    >
      <span v-if="focused" class="absolute inset-x-0 top-0 h-0.5 bg-accent" aria-hidden="true" />
      <component :is="iconOf(tab)" class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate font-medium" :title="tab.title || title">{{ title }}</span>
      <span
        v-if="focused"
        class="shrink-0 rounded-full bg-accent-soft px-1.5 text-caption font-medium text-accent-fg"
        >{{ t('split.active') }}</span
      >
      <DsIconButton
        :icon="X"
        size="sm"
        :label="t('split.closePane', { title })"
        data-close-pane
        @click="split.closePane(side)"
      />
    </header>
    <div :class="side ? 'min-h-0 flex-1 overflow-auto' : 'h-full'">
      <slot />
    </div>
    <!-- The pane in use, outlined above whatever it shows. -->
    <span
      v-if="side && focused"
      class="pointer-events-none absolute inset-0 ring-1 ring-accent/40 ring-inset"
      aria-hidden="true"
    />
  </section>
</template>
