import { ref } from 'vue'
import { defineStore } from 'pinia'

/** Phase 3d-3a U10: a toast may offer actions (Undo, Show progress). */
export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  message: string
  actions?: ToastAction[]
}

export type ToastCloseReason = 'timeout' | 'dismiss' | 'action'

/** What keeps a toast from timing out: the pointer on it, or the focus in it. */
export type ToastHold = 'hover' | 'focus'

/** A toast's time out: the time it has left, and what holds it now. */
interface Clock {
  timer: ReturnType<typeof setTimeout> | undefined
  left: number
  since: number
  holds: Set<ToastHold>
}

export const useToastStore = defineStore('toasts', () => {
  const toasts = ref<Toast[]>([])
  const onClose = new Map<number, (reason: ToastCloseReason) => void>()
  const clocks = new Map<number, Clock>()
  let seq = 0

  function close(id: number, reason: ToastCloseReason): void {
    if (!toasts.value.some((t) => t.id === id)) return
    toasts.value = toasts.value.filter((t) => t.id !== id)
    clearTimeout(clocks.get(id)?.timer)
    clocks.delete(id)
    const cb = onClose.get(id)
    onClose.delete(id)
    cb?.(reason)
  }

  function dismiss(id: number): void {
    close(id, 'dismiss')
  }

  function push(input: {
    kind: Toast['kind']
    message: string
    timeoutMs?: number
    actions?: ToastAction[]
    onClose?: (reason: ToastCloseReason) => void
  }): number {
    const id = ++seq
    // At most five at once: the oldest go first.
    for (const old of toasts.value.slice(0, -4)) close(old.id, 'dismiss')
    toasts.value = [
      ...toasts.value,
      { id, kind: input.kind, message: input.message, ...(input.actions ? { actions: input.actions } : {}) },
    ]
    if (input.onClose) onClose.set(id, input.onClose)
    // A toast with an action stays a little longer: there is something to do.
    const clock: Clock = {
      timer: undefined,
      left: input.timeoutMs ?? (input.kind === 'error' ? 8000 : input.actions ? 6000 : 4000),
      since: 0,
      holds: new Set(),
    }
    clocks.set(id, clock)
    run(id, clock)
    return id
  }

  /** W4.4: actions learnt after the toast was shown (a restore's report says what it wrote). */
  function setActions(id: number, actions: ToastAction[]): void {
    toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, actions } : t))
  }

  function run(id: number, clock: Clock): void {
    clock.since = Date.now()
    clock.timer = setTimeout(() => close(id, 'timeout'), clock.left)
  }

  /**
   * Keeps a toast while it is pointed at or has the focus, so its action can be reached (review
   * 2026-10-13, I1, WCAG 2.2.1: an Undo timed out before a keyboard got to it).
   */
  function hold(id: number, why: ToastHold): void {
    const clock = clocks.get(id)
    if (!clock) return
    if (clock.holds.size === 0) {
      clearTimeout(clock.timer)
      clock.timer = undefined
      clock.left = Math.max(0, clock.left - (Date.now() - clock.since))
    }
    clock.holds.add(why)
  }

  /** Lets a held toast go on with the time it had left, once nothing holds it. */
  function release(id: number, why: ToastHold): void {
    const clock = clocks.get(id)
    if (!clock || !clock.holds.delete(why) || clock.holds.size > 0) return
    run(id, clock)
  }

  function runAction(id: number, index: number): void {
    const action = toasts.value.find((t) => t.id === id)?.actions?.[index]
    if (!action) return
    close(id, 'action')
    action.run()
  }

  return { toasts, push, setActions, dismiss, runAction, hold, release }
})
