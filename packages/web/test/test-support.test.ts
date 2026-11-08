// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountApp } from './support/app'

type Devtools = { __VUE_DEVTOOLS_PLUGINS__?: unknown[] }
const plugins = () => (globalThis as Devtools).__VUE_DEVTOOLS_PLUGINS__ ?? []

// CI 2026-10-18: an app a test mounted is not kept after it, for devtools that never come
// (test/support/setup.ts). vue-i18n 11.4.16 (2026-11-01 audit) no longer queues its plugin there, so a
// plugin is queued here the way a library would, and the next test must find the list empty.
describe('the test apps', () => {
  let queued = false

  it('queue devtools plugins while one is mounted', () => {
    mountApp(defineComponent({ render: () => h('p', 'here') }))
    const g = globalThis as Devtools
    ;(g.__VUE_DEVTOOLS_PLUGINS__ ??= []).push({ pluginDescriptor: { id: 'test' }, setupFn: () => {} })
    queued = plugins().length > 0
    expect(queued).toBe(true)
  })

  it('leave none queued for the next test', () => {
    expect(queued, 'run after the test that queues one').toBe(true)
    expect(plugins()).toEqual([])
  })
})

// CI 2026-11-05: a view loaded on first use (the document page) took more than vi.waitFor's default
// second to come while every package's tests ran at once (test/support/setup.ts).
describe('a wait in a test', () => {
  it('gives what it waits for five seconds unless it names its own time', async () => {
    const started = Date.now()
    await vi.waitFor(() => expect(Date.now() - started).toBeGreaterThan(1_500))
    await expect(vi.waitFor(() => expect(false).toBe(true), { timeout: 50 })).rejects.toThrow()
  })
})
