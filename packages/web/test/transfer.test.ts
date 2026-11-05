// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import ExportConnectionsDialog from '../src/connections/ExportConnectionsDialog.vue'
import ImportConnectionsDialog from '../src/connections/ImportConnectionsDialog.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useSessionStore } from '../src/stores/session'
import { commandTitle, useCommandsStore } from '../src/stores/commands'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('export', () => {
  it('downloads the connections, asking for the password before including secrets in team mode', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mm')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    })
    const { calls } = mockApi({
      'POST connections/export': () => [
        200,
        {
          format: 'mongo-manager-connections',
          version: 1,
          exportedAt: '2026-09-26T10:00:00.000Z',
          connections: [{}, {}],
        },
      ],
    })
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true }
    const { wrapper } = mountApp(ExportConnectionsDialog)
    expect(document.body.textContent).not.toContain('Your password')
    await check(byLabel('Include passwords and keys'))
    expect(document.body.textContent).toContain('plain text')
    await typeInto(byLabel('Your password'), 'pw')
    button('Download').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual({ includeSecrets: true, password: 'pw' })
    expect(created).toHaveBeenCalledTimes(1)
    expect(clicked).toEqual(['mongo-manager-connections-2026-09-26.json'])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('import', () => {
  const pick = async (content: string) => {
    const input = byLabel('Connections file (.json)')
    Object.defineProperty(input, 'files', {
      value: [new File([content], 'c.json', { type: 'application/json' })],
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }

  it('imports a connections file', async () => {
    const file = {
      format: 'mongo-manager-connections',
      version: 1,
      connections: [{ name: 'A', favorite: false, readOnly: false, settings: { hosts: [{ host: 'h' }] } }],
    }
    const { calls } = mockApi({ 'POST connections/import': () => [200, { created: 1 }] })
    const { wrapper } = mountApp(ImportConnectionsDialog)
    await pick(JSON.stringify(file))
    button('Import').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toEqual(file)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('rejects other files without calling the server and lists server issues', async () => {
    const { calls } = mockApi({
      'POST connections/import': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ path: 'connections.0.settings.hosts', message: 'Too small' }],
        },
      ],
    })
    mountApp(ImportConnectionsDialog)
    await pick('{"hello": 1}')
    button('Import').click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'This is not a Mongo Manager connections file.',
    )
    expect(calls).toHaveLength(0)
    await pick(JSON.stringify({ format: 'mongo-manager-connections', version: 1, connections: [{}] }))
    button('Import').click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'connections.0.settings.hosts: Too small',
    )
  })
})

describe('palette commands', () => {
  it('opens connections and the new-connection dialog from the palette', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [
        200,
        [
          {
            id: 'c1',
            name: 'Prod',
            group: 'Team',
            color: null,
            favorite: false,
            readOnly: false,
            settings: {},
            uri: '',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: null,
            access: 'admin',
            permissions: [],
          },
        ],
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    const commands = useCommandsStore()
    const open = commands.search('Prod')[0]!
    expect(commandTitle(open)).toBe('Open connection: Prod')
    await open.run()
    expect(useTabsStore().active?.params).toEqual({ connectionId: 'c1' })
    expect(commands.search('import').map(commandTitle)).toContain('Import connections')
    await commands.search('New connection')[0]!.run()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('New connection'),
    )
  })
})
