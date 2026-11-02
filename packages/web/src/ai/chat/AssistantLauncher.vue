<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Sparkles } from 'lucide-vue-next'
import DsTooltip from '@/ds/DsTooltip.vue'
import { useShortcutsStore } from '@/stores/shortcuts'
import { ASSISTANT_PANEL_ID, ASSISTANT_TOGGLE_ID, LAUNCHER_CLEARANCE, useAssistantStore } from './store'
import { useCompactScreen } from './compact'
import { focusPage } from './focusPage'
import { useAiWords } from '../words'

/**
 * User report 2026-10-25: the assistant opens from a button floating over the page (bottom right), as a
 * window over the workspace — never narrowing it. Closed, the button says an answer is coming or a change
 * waits for approval; the page keeps room for it where it puts its actions (LAUNCHER_CLEARANCE).
 */
const emit = defineEmits<{ toggle: [] }>()
/** Focused on a click (Safari does not focus a button), so a close leaves focus where it was clicked. */
function onClick(e: MouseEvent): void {
  ;(e.currentTarget as HTMLElement).focus()
  emit('toggle')
}
const { t } = useI18n()
const store = useAssistantStore()
const shortcuts = useShortcutsStore()
const compact = useCompactScreen()
const words = useAiWords()
const awaiting = computed(() => !!store.live?.agent?.steps.some((s) => s.state === 'awaiting'))
const busy = computed(() => store.busy && !awaiting.value)
/** Closed, what goes on inside, said to a screen reader too (not only a coloured dot). */
const status = computed(() =>
  store.open
    ? null
    : awaiting.value
      ? t('ai.chat.launcher.awaiting')
      : busy.value
        ? t('ai.chat.launcher.busy')
        : null,
)
// Review of the floating window (I5): said as it happens while the window is closed (its own
// announcer is hidden with it) — a change come to wait for approval, an answer ended.
const announcement = ref('')
/**
 * Said anew each time (the same words twice are said twice): cleared, then set after a pause a
 * screen reader notices (third review, M-6) — unless the window opened meanwhile.
 */
let pending: ReturnType<typeof setTimeout> | null = null
function say(text: string): void {
  announcement.value = ''
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    if (!store.open) announcement.value = text
  }, 100)
}
watch(awaiting, (now) => {
  if (now && !store.open) say(t('ai.agent.awaitingStatus'))
})
watch(
  () => store.busy,
  (now, was) => {
    if (!was || now || store.open || awaiting.value) return
    // Re-review (I2): as it ended — ready, or why not (a stopped one is not said).
    const live = store.live
    if (live?.state === 'done') say(t('ai.chat.doneStatus'))
    else if (live?.state === 'error' && live.error)
      say(words.reason(live.error.reason, live.error.retryAfterMs))
  },
)
watch(
  () => store.open,
  (open) => {
    if (open) announcement.value = ''
  },
)
const root = () => document.documentElement
onMounted(() => root().style.setProperty('--mm-launcher-clearance', LAUNCHER_CLEARANCE))
onBeforeUnmount(() => {
  root().style.removeProperty('--mm-launcher-clearance')
  // Sixth review (M-2): gone with focus on it (the assistant turned off): focus to the page.
  if (document.activeElement?.id === ASSISTANT_TOGGLE_ID) focusPage()
  if (pending) clearTimeout(pending)
})
</script>

<template>
  <!-- Its status in its tooltip too (minor: not by colour alone); none over the open window. -->
  <DsTooltip
    :text="status ? `${t('ai.chat.title')} — ${status}` : t('ai.chat.title')"
    :shortcut="shortcuts.keysOf('assistant')[0]"
    :disabled="store.open"
  >
    <button
      v-show="!(store.open && compact)"
      :id="ASSISTANT_TOGGLE_ID"
      type="button"
      class="fixed right-4 bottom-4 z-40 grid size-11 cursor-pointer place-items-center rounded-full shadow-float ring-1 transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      :class="
        store.open
          ? 'bg-raised text-fg ring-line hover:bg-subtle'
          : 'bg-accent text-on-accent ring-accent/40 hover:bg-accent-hover'
      "
      :aria-label="t('ai.chat.title')"
      :aria-expanded="store.open ? 'true' : 'false'"
      :aria-controls="store.open ? ASSISTANT_PANEL_ID : undefined"
      :aria-describedby="status ? 'assistant-launcher-status' : undefined"
      :aria-keyshortcuts="shortcuts.aria('assistant')"
      :data-busy="busy ? 'true' : undefined"
      :data-awaiting="awaiting ? 'true' : undefined"
      data-assistant-toggle
      @click="onClick"
    >
      <ChevronDown v-if="store.open" class="size-5" aria-hidden="true" />
      <Sparkles v-else class="size-5" aria-hidden="true" />
      <!-- Closed, what goes on inside: an answer coming, a change waiting (said, not only shown). -->
      <span
        v-if="!store.open && (busy || awaiting)"
        class="absolute -top-0.5 -right-0.5 grid size-3.5 place-items-center rounded-full ring-2 ring-canvas"
        :class="awaiting ? 'bg-warning' : 'bg-success'"
        aria-hidden="true"
      >
        <span
          v-if="busy"
          class="size-3.5 animate-ping rounded-full bg-success/60 motion-reduce:animate-none"
        />
      </span>
      <span v-if="status" id="assistant-launcher-status" class="sr-only">{{ status }}</span>
    </button>
  </DsTooltip>
  <span role="status" class="sr-only" data-assistant-announcer>{{ announcement }}</span>
</template>
