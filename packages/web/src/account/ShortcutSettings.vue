<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Keyboard, RotateCcw, RotateCw } from 'lucide-vue-next'
import {
  SHORTCUT_GROUPS,
  defaultShortcut,
  isBindableKey,
  pairOf,
  type BindingProblem,
  type RebindableAction,
} from '@mongo-manager/shared/browser'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsKbd from '@/ds/DsKbd.vue'
import { describeError } from '@/api/errors'
import { useShortcutsStore } from '@/stores/shortcuts'
import { comboFromEvent, keyLabel, modifierNames } from '@/workspace/shortcuts'
import { useSessionStore } from '@/stores/session'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * W5 (completion §2 W5.3): the global shortcuts, each rebound by pressing its new keys. A key
 * another shortcut has, or that the browser keeps, is refused with the reason; each one resets to
 * what ships, or all at once. Kept for the user on the server.
 */
const { t } = useI18n()
const store = useShortcutsStore()
const actions = computed(
  () =>
    SHORTCUT_GROUPS.flatMap((g) => g.items)
      .filter((s) => s.rebindable)
      .map((s) => s.action) as RebindableAction[],
)
// Review I2: the user's own bindings are read before anything can change (a change sends the whole set).
const session = useSessionStore()
onMounted(() => void store.load(session.me?.user.id ?? 'local'))
const locked = computed(() => !store.loaded)
const recording = ref<RebindableAction | null>(null)
const errors = ref<Partial<Record<RebindableAction, string>>>({})
const announcement = ref('')
const busy = ref(false)
const changed = (action: RebindableAction) => store.bindings[action] !== undefined
const anyChanged = computed(() => Object.keys(store.bindings).length > 0)
const comboText = (combo: readonly string[]) => combo.map(keyLabel).join('+')
const keysText = (combos: readonly (readonly string[])[]) => combos.map(comboText).join(' / ')

const recorders = new Map<RebindableAction, HTMLElement>()
const changers = new Map<RebindableAction, HTMLElement>()
async function start(action: RebindableAction): Promise<void> {
  errors.value = { ...errors.value, [action]: '' }
  recording.value = action
  await nextTick()
  recorders.get(action)?.focus()
}
async function stop(back = true): Promise<void> {
  const action = recording.value
  recording.value = null
  if (!back || !action) return
  await nextTick()
  changers.get(action)?.focus()
}

function problemText(problem: BindingProblem, combos: string[][]): string {
  const keys = keysText(combos)
  if (problem.reason === 'conflict')
    return t('account.shortcuts.conflict', { keys, action: t(`shortcuts.actions.${problem.with}`) })
  // The modifiers as this system names them (⌘ and ⌥ on a Mac: review, minor).
  return t(`account.shortcuts.${problem.reason}`, { keys, ...modifierNames() })
}

async function onRecord(action: RebindableAction, event: KeyboardEvent): Promise<void> {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  // Tab moves on as everywhere (nothing is bound); Escape leaves the recorder.
  if (event.key === 'Tab' && plain) return void stop(false)
  event.preventDefault()
  // The workspace's own shortcuts must not act on the keys being recorded.
  event.stopPropagation()
  if (event.key === 'Escape' && plain) return void stop()
  // An input method composing, or a key the browser cannot name: wait for the next one.
  if (event.isComposing) return
  const combo = comboFromEvent(event)
  if (!combo) return
  // Review (minor): a key of another alphabet, Space, a dead key — a shortcut cannot hold it.
  if (!isBindableKey(combo.at(-1)!)) {
    errors.value = {
      ...errors.value,
      [action]: t('account.shortcuts.unsupportedKey', { keys: comboText(combo) }),
    }
    return void stop()
  }
  const combos = defaultShortcut(action).pair ? pairOf(combo) : [combo]
  // A pair takes ← or → with its modifiers; anything else is checked as the pair it would give.
  const arrow = combo.at(-1) === '←' || combo.at(-1) === '→'
  const problem = store.problem(action, defaultShortcut(action).pair && !arrow ? [combo] : combos)
  if (problem) {
    errors.value = { ...errors.value, [action]: problemText(problem, [combo]) }
    return void stop()
  }
  busy.value = true
  try {
    await store.bind(action, combos)
    // Its own keys pressed again: back to them, said as a reset (review, minor).
    announcement.value = changed(action)
      ? t('account.shortcuts.saved', { action: t(`shortcuts.actions.${action}`), keys: keysText(combos) })
      : t('account.shortcuts.resetDone', { action: t(`shortcuts.actions.${action}`) })
  } catch (e) {
    errors.value = { ...errors.value, [action]: describeError(e, t) }
  } finally {
    busy.value = false
  }
  await stop()
}

async function reset(action: RebindableAction): Promise<void> {
  busy.value = true
  errors.value = { ...errors.value, [action]: '' }
  try {
    await store.bind(action, null)
    announcement.value = t('account.shortcuts.resetDone', { action: t(`shortcuts.actions.${action}`) })
  } catch (e) {
    errors.value = { ...errors.value, [action]: describeError(e, t) }
  } finally {
    busy.value = false
  }
}

const allError = ref('')
async function resetAll(): Promise<void> {
  busy.value = true
  allError.value = ''
  try {
    await store.resetAll()
    errors.value = {}
    announcement.value = t('account.shortcuts.resetAllDone')
  } catch (e) {
    allError.value = describeError(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- Review I2: nothing changes until the user's own bindings are read. -->
    <DsCallout v-if="store.status === 'failed'" data-shortcuts-load-error tone="danger">
      {{ t('account.shortcuts.loadFailed') }}
      <template #action>
        <DsButton size="sm" :icon="RotateCw" @click="store.retry()">{{ t('common.retry') }}</DsButton>
      </template>
    </DsCallout>
    <!-- W5 re-review: bindings this version could not keep are named once, then written back without them. -->
    <DsCallout v-if="store.dropped.length" data-shortcuts-dropped tone="warning">
      {{
        t('account.shortcuts.dropped', {
          actions: store.dropped.map((a) => t(`shortcuts.actions.${a}`)).join('; '),
        })
      }}
      <template #action>
        <DsButton size="sm" @click="store.dismissDropped()">{{ t('account.shortcuts.dismiss') }}</DsButton>
      </template>
    </DsCallout>
    <ul class="flex flex-col divide-y divide-line rounded-lg border border-line">
      <li v-for="action in actions" :key="action" data-shortcut-row class="flex flex-col gap-1 px-3 py-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="min-w-0 flex-1 text-ui text-fg">{{ t(`shortcuts.actions.${action}`) }}</span>
          <button
            v-if="recording === action"
            :ref="(el) => el && recorders.set(action, el as HTMLElement)"
            type="button"
            data-shortcut-recorder
            class="h-8 rounded-lg border border-accent bg-accent-soft px-2.5 text-ui text-accent-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            :aria-label="t('account.shortcuts.recordLabel', { action: t(`shortcuts.actions.${action}`) })"
            @keydown="onRecord(action, $event)"
            @blur="recording === action && stop(false)"
          >
            {{ t('account.shortcuts.recording') }}
          </button>
          <span v-else class="flex flex-wrap items-center gap-1.5" :data-shortcut-keys="action">
            <span v-for="(combo, i) in store.keysOf(action)" :key="i" class="flex items-center gap-0.5">
              <DsKbd v-for="key in combo" :key="key">{{ keyLabel(key) }}</DsKbd>
            </span>
            <DsBadge v-if="changed(action)" tone="accent">{{ t('shortcuts.changed') }}</DsBadge>
          </span>
          <span class="flex shrink-0 gap-1.5">
            <DsButton
              :ref="(c) => c && changers.set(action, (c as { $el: HTMLElement }).$el)"
              size="sm"
              :icon="Keyboard"
              :disabled="busy || locked"
              :aria-label="t('account.shortcuts.changeLabel', { action: t(`shortcuts.actions.${action}`) })"
              @click="start(action)"
              >{{ t('account.shortcuts.change') }}</DsButton
            >
            <DsButton
              v-if="changed(action)"
              size="sm"
              variant="ghost"
              :icon="RotateCcw"
              :disabled="busy || locked"
              :aria-label="t('account.shortcuts.resetLabel', { action: t(`shortcuts.actions.${action}`) })"
              @click="reset(action)"
              >{{ t('account.shortcuts.reset') }}</DsButton
            >
          </span>
        </div>
        <p v-if="errors[action]" role="alert" class="text-small text-danger">{{ errors[action] }}</p>
      </li>
    </ul>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-small text-fg-subtle">{{ t('account.shortcuts.fixed') }}</p>
      <DsButton size="sm" :disabled="busy || locked || !anyChanged" :icon="RotateCcw" @click="resetAll">{{
        t('account.shortcuts.resetAll')
      }}</DsButton>
    </div>
    <p v-if="allError" role="alert" class="text-small text-danger">{{ allError }}</p>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </div>
</template>
