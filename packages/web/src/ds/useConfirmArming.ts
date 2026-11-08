// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { confirmGuard } from './confirmGuard'

/**
 * Security audit 2026-10-16: a confirmation takes its Confirm only after a moment with no press —
 * every press of a pointer or a key (outside its own fields) while it waits starts the moment again
 * (review of the security pass, I2: "click fast, many times" confirmed with the first press after
 * it) — and a pointer's click only from a press that began once Confirm could be pressed: never the
 * rest of a double-click begun on what was under it (a plugin's button). A click that comes with no
 * pointer press — Enter or Space on the focused Confirm, a screen reader's (I3) — is taken once the
 * moment passed. Saying no is never held back.
 *
 * Second review: a pointer's click counts only once the pointer moved onto Confirm after it could be
 * pressed (the least move will do; a touch or a pen enters it as it taps) — "click, wait a second,
 * click" with the pointer resting where Confirm appears no longer confirms. What the page's own
 * script makes up (`isTrusted` false) is no press, key or move of the user's.
 *
 * W6.3: shared by the app's confirmation dialog and the assistant's change cards, so both answer to
 * the same rules.
 */
export function useConfirmArming(opts: {
  /** A question is showing (the moment runs only then). */
  active: () => boolean
  /** Carries out the confirmation (called once Confirm may be pressed and is). */
  submit: () => void
}) {
  const armed = ref(false)
  /** Each start of the moment, so the bar that shows it starts again too. */
  const arming = ref(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  /** The pointer press going on (or whose click is being dispatched): whether it began too early. */
  let press: { early: boolean } | null = null
  /** An Enter in a field during the moment: taken once Confirm may be pressed. */
  let pendingSubmit = false
  /** Whether the pointer moved onto Confirm since it could be pressed. */
  let movedOnto = false

  function arm(): void {
    movedOnto = false
    armed.value = true
    if (pendingSubmit) {
      pendingSubmit = false
      opts.submit()
    }
  }
  function startMoment(): void {
    clearTimeout(timer)
    armed.value = confirmGuard.armMs <= 0
    if (armed.value) return
    arming.value++
    timer = setTimeout(arm, confirmGuard.armMs)
  }
  /** A new question (or none): the moment starts again from nothing. */
  function reset(): void {
    pendingSubmit = false
    clearTimeout(timer)
    armed.value = false
    if (opts.active()) startMoment()
  }
  const editable = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  function pointerDown(event: PointerEvent): void {
    if (event.isTrusted === false) return
    press = { early: !opts.active() || !armed.value }
    if (opts.active() && !armed.value) startMoment()
  }
  /**
   * The press is over once its click (if any) went: cleared after the events of this one. On Android
   * a touch's click can come after this timeout: it then counts as a click with no pointer press (as
   * a key's) — harmless, since any press while Confirm waited started the moment again.
   */
  function pointerUp(): void {
    setTimeout(() => (press = null), 0)
  }
  function keyDown(event: KeyboardEvent): void {
    if (event.isTrusted === false) return
    if (opts.active() && !armed.value && !editable(event.target)) startMoment()
  }
  /** The pointer on Confirm (moving, or entering it as a touch or a pen taps), once it may be pressed. */
  function pointerOnto(event: PointerEvent): void {
    if (event.isTrusted !== false && armed.value) movedOnto = true
  }
  /** Enter in a field: now, or once the moment passed. */
  function formSubmit(): void {
    if (armed.value) opts.submit()
    else pendingSubmit = true
  }
  /**
   * A pointer's click counts only from a press that began once Confirm could be pressed, the pointer
   * moved onto it since; a click with no pointer press (a key's, a screen reader's) once it may be.
   */
  function confirmClick(): void {
    if (!armed.value || press?.early) return
    if (press && !movedOnto) return
    opts.submit()
  }
  onMounted(() => {
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('pointercancel', pointerUp, true)
    window.addEventListener('keydown', keyDown, true)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', pointerDown, true)
    window.removeEventListener('pointerup', pointerUp, true)
    window.removeEventListener('pointercancel', pointerUp, true)
    window.removeEventListener('keydown', keyDown, true)
    clearTimeout(timer)
  })
  return { armed, arming, reset, pointerOnto, formSubmit, confirmClick }
}
