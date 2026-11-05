// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useToastStore } from '../src/stores/toasts'
import { mountApp } from './support/app'

/**
 * Review 2026-10-13 (I1, WCAG 2.2.1): a toast is not timed out while it is pointed at or has the focus,
 * so its Undo can be reached; the time left runs on once it has neither.
 */
describe('a toast held while pointed at or focused', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('waits while held, and runs on with the time it had left', () => {
    const store = useToastStore()
    const closed: string[] = []
    const id = store.push({ kind: 'info', message: 'm', timeoutMs: 1000, onClose: (r) => closed.push(r) })
    vi.advanceTimersByTime(600)
    store.hold(id, 'hover')
    store.hold(id, 'focus')
    vi.advanceTimersByTime(10_000)
    store.release(id, 'hover')
    vi.advanceTimersByTime(10_000)
    expect(store.toasts.map((t) => t.id)).toEqual([id])
    store.release(id, 'focus')
    vi.advanceTimersByTime(399)
    expect(store.toasts).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(store.toasts).toEqual([])
    expect(closed).toEqual(['timeout'])
  })

  it('is held by the pointer and by the focus on the toast host', async () => {
    mountApp(ToastHost)
    const store = useToastStore()
    store.push({ kind: 'info', message: 'm', actions: [{ label: 'Undo', run: () => {} }] })
    await flushPromises()
    const toast = () => document.querySelector<HTMLElement>('[data-toast]')
    toast()!.dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(toast()).not.toBeNull()
    const undo = toast()!.querySelector('button')!
    undo.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    toast()!.dispatchEvent(new MouseEvent('mouseleave'))
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(toast()).not.toBeNull()
    undo.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(toast()).toBeNull()
  })
})
