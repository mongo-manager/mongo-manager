// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import DsConfirmHost from '../src/ds/DsConfirmHost.vue'
import { confirmGuard } from '../src/ds/confirmGuard'
import { useDialogStore } from '../src/stores/dialogs'
import { mountApp } from './support/app'

// Security audit 2026-10-16: a plugin put a button where the app's Confirm appears — a double-click
// on it answered the app's question too. The app's confirmation takes its Confirm only after a
// moment, and only from a press that began once it could be pressed.
const ARM = 600
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  confirmGuard.armMs = ARM
})
afterEach(() => {
  confirmGuard.armMs = 0
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-test="confirm"]')!
/**
 * A mouse's click on the button: moved onto it (unless `move` is false), a press (unless `press` is
 * false), then the click.
 */
function mouseClick(el: HTMLElement, press = true, move = press): void {
  if (move) el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
  if (press) el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
}
const untrusted = <T extends Event>(event: T): T => {
  Object.defineProperty(event, 'isTrusted', { value: false })
  return event
}
/** Enter or Space on the focused button: a click with no pointer (detail 0). */
const keyClick = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))

async function ask(message = 'Change it?') {
  let settled: boolean | undefined
  void useDialogStore()
    .confirm({ title: 'Plugin wants to change a document', message })
    .then((v) => (settled = v))
  await flushPromises()
  return { settled: () => settled }
}

describe('the app’s confirmation (security audit 2026-10-16)', () => {
  it('takes no Confirm for a moment after it shows: a double-click begun elsewhere never lands on it', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    expect(confirmButton().disabled).toBe(true)
    mouseClick(confirmButton())
    keyClick(confirmButton())
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
    vi.advanceTimersByTime(ARM - 50)
    await nextTick()
    expect(confirmButton().disabled).toBe(true)
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(confirmButton().disabled).toBe(false)
    mouseClick(confirmButton())
    await flushPromises()
    expect(answer.settled()).toBe(true)
  })

  it('ignores a click whose press began before it could be pressed', async () => {
    mountApp(DsConfirmHost)
    // Pressed before the question showed, released on Confirm once it shows.
    window.dispatchEvent(new PointerEvent('pointerdown'))
    const answer = await ask()
    vi.advanceTimersByTime(ARM)
    await nextTick()
    mouseClick(confirmButton(), false)
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
    // A fresh press, then its click: taken.
    mouseClick(confirmButton())
    await flushPromises()
    expect(answer.settled()).toBe(true)
  })

  it('ignores a click whose press began while it could not be pressed yet', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    vi.advanceTimersByTime(ARM / 2)
    confirmButton().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    vi.advanceTimersByTime(ARM)
    await nextTick()
    mouseClick(confirmButton(), false)
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
  })

  it('takes Enter or Space on Confirm once it may be pressed (the keyboard’s way, focus starting elsewhere)', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    // Focus starts away from Confirm.
    expect(document.activeElement).not.toBe(confirmButton())
    vi.advanceTimersByTime(ARM)
    await nextTick()
    keyClick(confirmButton())
    await flushPromises()
    expect(answer.settled()).toBe(true)
  })

  it('waits again for each question that follows', async () => {
    mountApp(DsConfirmHost)
    const first = await ask('First?')
    const second = await ask('Second?')
    vi.advanceTimersByTime(ARM)
    await nextTick()
    mouseClick(confirmButton())
    await flushPromises()
    expect(first.settled()).toBe(true)
    await nextTick()
    // The second shows at once, under the same pointer: a second click of a double-click.
    expect(document.body.textContent).toContain('Second?')
    mouseClick(confirmButton())
    await flushPromises()
    expect(second.settled()).toBeUndefined()
    vi.advanceTimersByTime(ARM)
    await nextTick()
    mouseClick(confirmButton())
    await flushPromises()
    expect(second.settled()).toBe(true)
  })

  // Review of the security pass (Minor): an Enter in the field during the first moment was dropped
  // silently. It is kept, and taken once Confirm may be pressed; typing does not hold Confirm back.
  it('keeps an Enter in its field until Confirm may be pressed, then takes it', async () => {
    mountApp(DsConfirmHost)
    let value: string | null | undefined
    void useDialogStore()
      .prompt({ title: 'Password', message: '', input: { type: 'password', label: 'Password', value: 'x' } })
      .then((v) => (value = v))
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-test="prompt-input"] input')!
    vi.advanceTimersByTime(ARM / 2)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(value).toBeUndefined()
    vi.advanceTimersByTime(ARM / 2)
    await flushPromises()
    expect(value).toBe('x')
  })

  // Review of the security pass (I2): "click fast, many times" — the first press after the moment
  // confirmed. While presses keep coming, Confirm does not become pressable.
  it('waits for a moment with no press at all, however many presses come before', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(ARM - 100)
      // A pointer's press, then a key's: either starts the moment again.
      if (i % 2) document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      await nextTick()
      expect(confirmButton().disabled).toBe(true)
      mouseClick(confirmButton(), false)
    }
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
    // It shows that it is getting ready, not that it is broken.
    expect(document.querySelector('[data-confirm-arming]')).not.toBeNull()
    vi.advanceTimersByTime(ARM)
    await nextTick()
    expect(confirmButton().disabled).toBe(false)
    expect(document.querySelector('[data-confirm-arming]')).toBeNull()
    mouseClick(confirmButton())
    await flushPromises()
    expect(answer.settled()).toBe(true)
  })

  // Review of the security pass (I3): a screen reader's press (Firefox with NVDA or JAWS) is a click
  // with detail 1 and no pointer press at all — it was refused in every confirmation.
  it('takes a screen reader’s click, which comes with no pointer press', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    vi.advanceTimersByTime(ARM)
    await nextTick()
    confirmButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await flushPromises()
    expect(answer.settled()).toBe(true)
    const second = await ask()
    vi.advanceTimersByTime(ARM)
    await nextTick()
    confirmButton().dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: '' }))
    await flushPromises()
    expect(second.settled()).toBe(true)
  })

  it('refuses the click of a press still going on that began before it could be pressed', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    confirmButton().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    vi.advanceTimersByTime(ARM * 3)
    await nextTick()
    // Released on Confirm long after.
    confirmButton().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
    confirmButton().dispatchEvent(
      new PointerEvent('click', { bubbles: true, pointerType: 'mouse', detail: 1 }),
    )
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
    // That press over, a screen reader's click is taken.
    vi.advanceTimersByTime(10)
    confirmButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await flushPromises()
    expect(answer.settled()).toBe(true)
  })

  it('cancels at once: saying no is never held back', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    mouseClick(document.querySelector<HTMLButtonElement>('[data-test="cancel"]')!)
    await flushPromises()
    expect(answer.settled()).toBe(false)
  })

  // Second review (Minor): "click, wait a second, click" — the pointer resting where Confirm appears
  // confirmed with the next click. A pointer's click counts once the pointer moved onto Confirm.
  it('takes a pointer’s click once the pointer moved onto Confirm after it could be pressed', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    // Resting on it all along: moved there while it waited, then still.
    confirmButton().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    vi.advanceTimersByTime(ARM)
    await nextTick()
    mouseClick(confirmButton(), true, false)
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
    // The least move on it, and the click is taken.
    mouseClick(confirmButton())
    await flushPromises()
    expect(answer.settled()).toBe(true)
  })

  it('takes a tap (a touch or a pen comes onto Confirm as it presses)', async () => {
    mountApp(DsConfirmHost)
    for (const pointerType of ['touch', 'pen']) {
      const answer = await ask()
      vi.advanceTimersByTime(ARM)
      await nextTick()
      const button = confirmButton()
      button.dispatchEvent(new PointerEvent('pointerenter', { pointerType }))
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType }))
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType }))
      button.dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType, detail: 1 }))
      await flushPromises()
      expect(answer.settled(), pointerType).toBe(true)
      vi.advanceTimersByTime(10)
    }
  })

  // Second review (Minor): what the page's own script makes up is no user's press or move.
  it('takes no made-up press, key or move into account', async () => {
    mountApp(DsConfirmHost)
    const answer = await ask()
    vi.advanceTimersByTime(ARM - 100)
    document.body.dispatchEvent(untrusted(new PointerEvent('pointerdown', { bubbles: true })))
    document.body.dispatchEvent(untrusted(new KeyboardEvent('keydown', { key: ' ', bubbles: true })))
    vi.advanceTimersByTime(100)
    await nextTick()
    // Neither started the moment again.
    expect(confirmButton().disabled).toBe(false)
    confirmButton().dispatchEvent(untrusted(new PointerEvent('pointermove', { bubbles: true })))
    mouseClick(confirmButton(), true, false)
    await flushPromises()
    expect(answer.settled()).toBeUndefined()
  })
})
