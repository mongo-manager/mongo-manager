// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DsToastHost from '../src/ds/DsToastHost.vue'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

/** Seventh review of the floating window (I-1): the newest toast in view, the stack full too. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})

describe('the toasts’ newest in view', () => {
  it('scrolls to each one added, the stack full (five) too', async () => {
    mountApp(DsToastHost)
    const host = document.querySelector<HTMLElement>('[aria-live="polite"]')!
    let scrolled = 0
    host.scrollTo = (() => {
      scrolled++
    }) as typeof host.scrollTo
    const toasts = useToastStore()
    for (let i = 0; i < 5; i++) toasts.push({ kind: 'info', message: `n${i}` })
    await flushPromises()
    const before = scrolled
    toasts.push({ kind: 'info', message: 'the sixth' })
    await flushPromises()
    expect(toasts.toasts).toHaveLength(5)
    expect(scrolled).toBe(before + 1)
  })
})
