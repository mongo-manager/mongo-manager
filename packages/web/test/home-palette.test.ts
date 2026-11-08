// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import HomeView from '../src/workspace/HomeView.vue'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import ShortcutSheet from '../src/workspace/ShortcutSheet.vue'
import { paletteGroup } from '../src/workspace/paletteGroups'
import { i18n } from '../src/i18n'
import { useCommandsStore } from '../src/stores/commands'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { mockApi, mountApp } from './support/app'

const conn = (id: string, name: string, favorite = false) => ({
  id,
  name,
  group: null,
  color: null,
  favorite,
  readOnly: false,
  access: 'admin',
  permissions: [],
})
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('HomeView', () => {
  it('greets, lists favourites first, opens a connection and offers a new one without a second "Add connection"', async () => {
    mockApi({ 'GET connections': () => [200, [conn('a', 'Analytics'), conn('p', 'Production', true)]] })
    const session = useSessionStore()
    session.me = {
      mode: 'team',
      user: { id: 'u', username: 'ayse', role: 'admin' },
      permissions: ['connections:manage'],
      csrfToken: 'c',
      readOnly: false,
      twoFactor: {},
    } as never
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    expect(wrapper.get('h1').text()).toContain('ayse')
    const rows = wrapper.findAll('[data-test="home-connection"]')
    expect(rows.map((r) => r.text())).toEqual([
      expect.stringContaining('Production'),
      expect.stringContaining('Analytics'),
    ])
    expect(
      wrapper
        .findAll('button')
        .some((b) => b.text() === 'Add connection' || b.attributes('aria-label') === 'Add connection'),
    ).toBe(false)
    await rows[1]!.get('button').trigger('click')
    expect(useTabsStore().active?.params.connectionId).toBe('a')
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('New connection'))!
      .trigger('click')
    expect(useWorkspaceDialogs().current?.kind).toBe('connection')
  })
  it('switches language with everything on it', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    useSessionStore().me = {
      mode: 'local',
      user: { id: 'local', username: 'owner', role: 'admin' },
      permissions: ['connections:manage'],
      csrfToken: 'c',
      readOnly: false,
      twoFactor: {},
    } as never
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    i18n.global.locale.value = 'tr'
    await nextTick()
    expect(wrapper.text()).toContain('Yeni bağlantı')
    expect(wrapper.text()).not.toContain('New connection')
  })
})

describe('HomeView, checkpoint 1 feedback', () => {
  const manager = () =>
    (useSessionStore().me = {
      mode: 'local',
      user: { id: 'local', username: 'owner', role: 'admin' },
      permissions: ['connections:manage'],
      csrfToken: 'c',
      readOnly: false,
      twoFactor: {},
    } as never)

  it('opens the palette from its search field', async () => {
    mockApi({ 'GET connections': () => [200, [conn('a', 'Analytics')]] })
    manager()
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    await wrapper.get('[data-test="home-search"]').trigger('click')
    expect(wrapper.emitted('palette')).toHaveLength(1)
  })

  it('walks a new user through the first connection', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    manager()
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    const start = wrapper.get('[data-test="home-onboarding"]')
    expect(start.findAll('ol > li')).toHaveLength(3)
    await start
      .findAll('button')
      .find((b) => b.text().includes('Import connections'))!
      .trigger('click')
    expect(useWorkspaceDialogs().current?.kind).toBe('importConnections')
    expect(wrapper.find('[data-test="home-connection"]').exists()).toBe(false)
  })

  it('shows a reader no buttons it cannot use', async () => {
    mockApi({ 'GET connections': () => [200, []] })
    useSessionStore().me = {
      mode: 'team',
      user: { id: 'r', username: 'reader', role: 'viewer' },
      permissions: [],
      csrfToken: 'c',
      readOnly: false,
      twoFactor: {},
    } as never
    const { wrapper } = mountApp(HomeView)
    await flushPromises()
    expect(wrapper.findAll('button').some((b) => /New connection|Import connections/.test(b.text()))).toBe(
      false,
    )
  })
})

describe('CommandPalette groups', () => {
  it('sorts commands into Navigate, Actions and Saved queries and keeps the arrow order on screen', async () => {
    const commands = useCommandsStore()
    commands.register({ id: 'theme', title: 'Toggle theme', run: () => {} })
    commands.register({ id: 'connection.open:x', title: 'Open connection: X', run: () => {} })
    commands.register({ id: 'library.open:query:1', title: 'Saved: big orders', run: () => {} })
    commands.register({ id: 'shortcuts', title: 'Keyboard shortcuts', run: () => {} })
    expect(paletteGroup(commands.commands[0]!)).toBe('actions')
    expect(paletteGroup(commands.commands[1]!)).toBe('navigate')
    expect(paletteGroup(commands.commands[2]!)).toBe('saved')
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    const headings = [...document.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))
    expect(headings).toEqual(['Navigate', 'Actions', 'Saved queries'])
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.id)
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0])
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1])
    expect(document.querySelector(`#${options[2]}`)!.textContent).toContain('?')
    // Every command carries an icon, so the list scans at a glance.
    for (const o of document.querySelectorAll('[role="option"]'))
      expect(o.querySelector('svg')).not.toBeNull()
  })
})

describe('CommandPalette context (checkpoint 1 feedback)', () => {
  it('lists a command only where it can run: collection commands in a collection tab, connection ones in a connection tab', async () => {
    const commands = useCommandsStore()
    for (const id of ['theme', 'data.import', 'shell.open', 'backup.dump'])
      commands.register({ id, title: id, run: () => {} })
    const tabs = useTabsStore()
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    const shown = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim())
    expect(shown()).toEqual(['theme'])
    tabs.open({ kind: 'connection', title: 'P', params: { connectionId: 'c1' } })
    await nextTick()
    // User request 2026-10-11: a shell opens from a connection's tab too.
    expect(shown()).toEqual(['theme', 'shell.open', 'backup.dump'])
    tabs.open({
      kind: 'collection',
      title: 'shop.orders',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    await nextTick()
    expect(shown()).toEqual(['theme', 'data.import', 'shell.open', 'backup.dump'])
  })
})

describe('ShortcutSheet', () => {
  it('lists every group with its keys', () => {
    const { wrapper } = mountApp(ShortcutSheet)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Tabs')
    expect(dialog.querySelectorAll('kbd').length).toBeGreaterThan(20)
    expect(wrapper.exists()).toBe(true)
  })
})
