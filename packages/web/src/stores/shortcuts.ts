// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  bindingProblem,
  comboId,
  defaultShortcut,
  effectiveKeys,
  type BindingProblem,
  type RebindableAction,
  type ShortcutBindings,
} from '@mongo-manager/shared/browser'
import { shortcutsApi } from '@/api/shortcuts'
import { ariaShortcut, keyLabel } from '@/workspace/shortcuts'

/**
 * W5 (completion §2 W5.3): the user's own bindings of the global shortcuts, kept on the server
 * for them (their other devices get them too). Until they are read, and when they cannot be, the
 * shipped keys apply — and nothing can be changed (review I2): a change is sent as the whole set,
 * which would otherwise replace the bindings not yet read.
 */
export const useShortcutsStore = defineStore('shortcuts', () => {
  const bindings = ref<ShortcutBindings>({})
  const status = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const loaded = computed(() => status.value === 'ready')
  /** W5 re-review: bindings the server could not keep (an upgrade took their keys), told once. */
  const dropped = ref<RebindableAction[]>([])
  /** Whose bindings these are: another user signing in starts from what ships. */
  let owner: string | null = null

  async function load(userId: string): Promise<void> {
    if (owner === userId && (status.value === 'loading' || status.value === 'ready')) return
    if (owner !== userId) bindings.value = {}
    owner = userId
    status.value = 'loading'
    try {
      const answer = await shortcutsApi.get()
      if (owner !== userId) return
      bindings.value = answer.bindings
      dropped.value = answer.dropped ?? []
      status.value = 'ready'
    } catch {
      // The server is away: the shipped keys work meanwhile; Retry (or the next sign-in) asks again.
      if (owner === userId) status.value = 'failed'
    }
  }

  /**
   * The user has read which bindings went: the set kept is written back without them, so they are
   * not named again (on a failure, they are named again next time).
   */
  async function dismissDropped(): Promise<void> {
    dropped.value = []
    if (status.value !== 'ready') return
    try {
      if (Object.keys(bindings.value).length > 0) await shortcutsApi.save(bindings.value)
      else await shortcutsApi.reset()
    } catch {
      // Told again on the next read.
    }
  }

  /** Asks again for the bindings of whoever they were asked for. */
  const retry = (): Promise<void> => (owner === null ? Promise.resolve() : load(owner))

  /** The keys of an action for this user. */
  const keysOf = (action: RebindableAction): string[][] => effectiveKeys(action, bindings.value)

  /** The action's keys for aria-keyshortcuts (every combination). */
  const aria = (action: RebindableAction): string => ariaShortcut(keysOf(action))

  /** The action's first combination, as written for people ("Ctrl+Shift+K"). */
  const text = (action: RebindableAction): string => (keysOf(action)[0] ?? []).map(keyLabel).join('+')

  /** Why the keys cannot be used for the action, or null. */
  const problem = (action: RebindableAction, combos: string[][]): BindingProblem | null =>
    bindingProblem(action, combos, bindings.value)

  /** The keys the action ships with: binding them again is going back to them. */
  const shipped = (action: RebindableAction, combos: string[][]): boolean => {
    const own = defaultShortcut(action).keys.map(comboId)
    return combos.length === own.length && combos.every((c, i) => comboId(c) === own[i])
  }

  /** Binds an action (null, or its shipped keys: back to them); the server checks and keeps it. */
  async function bind(action: RebindableAction, combos: string[][] | null): Promise<void> {
    if (status.value !== 'ready') throw new Error('The shortcuts are not read yet')
    const next: ShortcutBindings = { ...bindings.value }
    if (combos && !shipped(action, combos)) next[action] = combos
    else delete next[action]
    const answer =
      Object.keys(next).length > 0
        ? await shortcutsApi.save(next)
        : (await shortcutsApi.reset(), { bindings: {} })
    bindings.value = answer.bindings
  }

  async function resetAll(): Promise<void> {
    if (status.value !== 'ready') throw new Error('The shortcuts are not read yet')
    await shortcutsApi.reset()
    bindings.value = {}
  }

  return {
    bindings,
    status,
    loaded,
    dropped,
    dismissDropped,
    load,
    retry,
    keysOf,
    aria,
    text,
    problem,
    bind,
    resetAll,
  }
})
