import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { useWorkspaceCommands } from '../src/workspace/commands'
import { useCommandsStore } from '../src/stores/commands'
import { useTabsStore } from '../src/stores/tabs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useSessionStore } from '../src/stores/session'
import { mockApi, mountApp } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const Host = defineComponent({
  setup() {
    useWorkspaceCommands()
    return () => h('div')
  },
})

// Phase 3e-2 final gate: a command run from the palette right after the page loads, before the
// connection list arrived, did nothing at all; it waits for the list now.
describe('palette commands run before the connection list arrived', () => {
  it('opens the live sync wizard once the list is in', async () => {
    let answer!: () => void
    const arrived = new Promise<void>((r) => (answer = r))
    mockApi({
      'GET connections': async () => {
        await arrived
        return [200, [{ id: 'c1', name: 'Prod', export: true, shell: true, permissions: ['documents:read'] }]]
      },
    })
    const session = useSessionStore()
    session.status = { mode: 'local' } as never
    mountApp(Host)
    useTabsStore().open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const run = useCommandsStore()
      .commands.find((c) => c.id === 'data.liveSync')!
      .run()
    answer()
    await run
    await flushPromises()
    expect(useWorkspaceDialogs().current).toMatchObject({
      kind: 'liveSync',
      connectionId: 'c1',
      coll: 'orders',
    })
  })
})
