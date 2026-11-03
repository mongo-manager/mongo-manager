import { describe, expect, it } from 'vitest'
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
