// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { defineComponent, h, onMounted, onUnmounted } from 'vue'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'

// Review I3 (2026-10-10): a shell tab's session lives while the tab is open, whichever tab shows.
const { life } = vi.hoisted(() => ({ life: { mounted: [] as string[], unmounted: [] as string[] } }))
vi.mock('../src/workspace/tabs/ShellTab.vue', () => ({
  __esModule: true,
  default: defineComponent({
    props: {
      connectionId: { type: String, default: '' },
      db: { type: String, default: '' },
      tabId: { type: String, default: '' },
    },
    setup(props) {
      onMounted(() => life.mounted.push(props.db!))
      onUnmounted(() => life.unmounted.push(props.db!))
      return () => h('div', { 'data-fake-shell': props.db })
    },
  }),
}))

import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  useTabsStore().bindUser('local')
  life.mounted.length = 0
  life.unmounted.length = 0
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('shell tabs', () => {
  it('keep their session while another tab shows, and end it when closed', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, []],
      'GET connections/c1/library': () => [200, { items: [], truncated: false }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    const shell = tabs.open({ kind: 'shell', title: 'Shell', params: { connectionId: 'c1', db: 'shop' } })
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await flushPromises()
    expect(life.mounted).toEqual(['shop'])
    const visible = () =>
      (
        document
          .querySelector<HTMLElement>('[data-fake-shell="shop"]')!
          .closest('[data-workspace-frame]') as HTMLElement
      ).style.display !== 'none'
    expect(visible()).toBe(true)

    tabs.open({ kind: 'library', title: '' })
    await flushPromises()
    expect(life.unmounted).toEqual([])
    expect(visible()).toBe(false)

    tabs.activate(shell)
    await flushPromises()
    expect(life.mounted).toEqual(['shop'])
    expect(visible()).toBe(true)

    tabs.close(shell)
    await flushPromises()
    expect(life.unmounted).toEqual(['shop'])
  })
})
