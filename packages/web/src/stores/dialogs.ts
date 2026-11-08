// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  /** When set, the user must type this exactly (e.g. a collection name) before confirming. */
  requireText?: string
  /** Wave 3 second review: when it aborts, the question goes as a "no" (a plugin's, past its time). */
  signal?: AbortSignal
}

export interface PromptOptions extends ConfirmOptions {
  input: {
    type: 'password' | 'text'
    label: string
    value?: string
    /** Defaults to current-password for passwords; new-password when setting someone's password. */
    autocomplete?: 'current-password' | 'new-password' | 'off'
    /** Password strength (2026-10-28): a new account password, with the meter (and whose it is). */
    strength?: { username: string }
  }
}

interface Pending extends ConfirmOptions {
  id: number
  input?: PromptOptions['input']
  /** The prompt's current text (bound in DialogHost). */
  value: string
  resolve(result: boolean): void
}

/** Promise-queued dialogs: every confirm() settles exactly once, in order (spec §7). */
export const useDialogStore = defineStore('dialogs', () => {
  const queue = ref<Pending[]>([])
  let seq = 0
  const current = computed(() => queue.value[0] ?? null)

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      if (options.signal?.aborted) return resolve(false)
      const pending: Pending = { ...options, id: ++seq, value: '', resolve }
      queue.value = [...queue.value, pending]
      options.signal?.addEventListener(
        'abort',
        () => {
          // The queue holds reactive copies: compared by id.
          if (!queue.value.some((p) => p.id === pending.id)) return
          queue.value = queue.value.filter((p) => p.id !== pending.id)
          resolve(false)
        },
        { once: true },
      )
    })
  }

  /** Like confirm(), with one input; resolves to the text, or null when cancelled. */
  function prompt(options: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      const pending: Pending = {
        ...options,
        id: ++seq,
        value: options.input.value ?? '',
        resolve: (ok) => resolve(ok ? pending.value : null),
      }
      queue.value = [...queue.value, pending]
    })
  }

  function settle(result: boolean): void {
    const [head, ...rest] = queue.value
    if (!head) return
    queue.value = rest
    head.resolve(result)
  }

  return { queue, current, confirm, prompt, settle }
})
