import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, SECRET_MASK, type ConnectionSettings } from '@mongo-manager/shared'
import ConnectionDialog from '../src/connections/ConnectionDialog.vue'
import ImportConnectionsDialog from '../src/connections/ImportConnectionsDialog.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import DsMenu from '../src/ds/DsMenu.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { formFromDto, emptyForm } from '../src/connections/formModel'
import { applyUri } from '../src/connections/uriFill'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useTreeStore } from '../src/stores/tree'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import type { ConnectionDto } from '../src/api/connections'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'

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

const TLS_OFF = { enabled: false, allowInvalidHostnames: false, allowInvalidCertificates: false }
const settings = (extra: Partial<ConnectionSettings> = {}): ConnectionSettings => ({
  scheme: 'mongodb',
  hosts: [{ host: 'db1', port: 27017 }],
  auth: { mechanism: 'DEFAULT', username: 'ada', password: SECRET_MASK },
  tls: {
    ...TLS_OFF,
    enabled: true,
    caPem: 'CA-PEM',
    certificateKeyPem: SECRET_MASK,
    certificateKeyPassword: SECRET_MASK,
  },
  options: {},
  ...extra,
})
const dto = (extra: Partial<ConnectionDto> = {}): ConnectionDto => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: settings(),
  uri: 'mongodb://db1:27017',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  ...extra,
})
const ME = {
  mode: 'team',
  user: { id: 'u1', username: 'ada', role: 'admin' },
  permissions: [...PERMISSIONS],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: {},
}

async function workspace(handlers: Record<string, Handler>, mode: 'local' | 'team' = 'local') {
  const api = mockApi({
    'GET auth/status': () => [200, { mode, setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, { ...ME, mode }],
    'GET connections': () => [
      200,
      [dto(), dto({ id: 'c2', name: 'Other', settings: settings({ hosts: [{ host: 'db2' }] }) })],
    ],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await flushPromises()
  return { ...api, router }
}

/** The sections are under "Advanced options" (user request 2026-10-16): opened first when closed. */
async function section(name: string): Promise<void> {
  const toggle = document.querySelector<HTMLButtonElement>('[data-advanced-toggle]')
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    toggle.click()
    await flushPromises()
  }
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((b) => b.textContent?.trim() === name)!
    .click()
  await flushPromises()
}

describe('form model (Important 1, 2)', () => {
  it('pasting a URI while editing keeps TLS PEMs and the stored password', () => {
    const form = formFromDto(dto())
    applyUri(form, {
      ...settings({ replicaSet: 'rs0' }),
      auth: { mechanism: 'DEFAULT', username: 'ada' },
      tls: { ...TLS_OFF, enabled: true },
    })
    expect(form.replicaSet).toBe('rs0')
    expect(form.auth.password).toBe(SECRET_MASK)
    expect([form.tls.caPem, form.tls.certificateKeyPem, form.tls.certificateKeyPassword]).toEqual([
      'CA-PEM',
      SECRET_MASK,
      SECRET_MASK,
    ])
  })

  it('a URI for another user does not inherit the stored password', () => {
    const form = formFromDto(dto())
    applyUri(form, { ...settings(), auth: { mechanism: 'DEFAULT', username: 'bob' } })
    expect(form.auth.password).toBe('')
  })

  it('duplicating drops masked mechanism-property values', () => {
    const aws = dto({
      settings: settings({
        auth: {
          mechanism: 'MONGODB-AWS',
          username: 'AKIA',
          password: SECRET_MASK,
          mechanismProperties: `AWS_SESSION_TOKEN:${SECRET_MASK},SERVICE_NAME:x`,
        },
      }),
    })
    const copy = formFromDto(aws, { duplicateName: (n) => n })
    expect(copy.auth.mechanismProperties).toBe('SERVICE_NAME:x')
  })
})

describe('workspace dialogs (Important 3, 4)', () => {
  it('Ctrl+K does not open the palette over a workspace dialog, and a new dialog gets a fresh form', async () => {
    await workspace({})
    const dialogs = useWorkspaceDialogs()
    dialogs.open({ kind: 'connection', connection: dto() })
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Edit connection'),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    dialogs.open({ kind: 'connection' })
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('New connection'),
    )
    expect(byLabel('Name').value).toBe('')
  })

  it('sign-out closes workspace dialogs and forgets the tree state', async () => {
    let signedIn = true
    await workspace(
      {
        'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: signedIn }],
        'POST auth/logout': () => {
          signedIn = false
          return [204]
        },
      },
      'team',
    )
    const dialogs = useWorkspaceDialogs()
    const tree = useTreeStore()
    tree.setExpanded('x', true)
    dialogs.open({ kind: 'connection', connection: dto() })
    await flushPromises()
    // UI redesign R1 revision 2 §3.2: Sign out is the account menu's last item.
    ;(document.querySelector('button[aria-label^="Account menu"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Sign out')!
      .click()
    await flushPromises()
    expect(dialogs.current).toBeNull()
    expect(tree.expanded.size).toBe(0)
  })
})

describe('connection editor details', () => {
  it('lists server issues for fields no section shows, and srv clears direct connection (Important 5)', async () => {
    const { calls } = mockApi({
      'POST connections': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ path: 'settings.tls.enabled', message: 'Expected boolean' }],
        },
      ],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Name'), 'X')
    await section('Server')
    await check(byLabel('Direct connection (skip replica set discovery)'))
    await choose(byLabel<HTMLSelectElement>('Scheme'), 'mongodb+srv')
    await typeInto(byLabel('Host'), 'cluster0.example.net')
    button('Save and connect').click()
    await flushPromises()
    expect(calls.at(-1)!.body).not.toHaveProperty('settings.directConnection')
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('tls.enabled: Expected boolean')
  })

  it('selects a masked secret on focus so typing replaces it (Minor 1)', async () => {
    mountApp(ConnectionDialog, { props: { connection: dto() } })
    await section('Authentication')
    const password = byLabel('Password')
    password.focus()
    password.dispatchEvent(new FocusEvent('focus'))
    await nextTick()
    expect([password.selectionStart, password.selectionEnd]).toEqual([0, SECRET_MASK.length])
  })

  it('forgets the pinned SSH host key when the SSH host changes, and restores it when changed back (Minor 2)', async () => {
    const ssh = {
      enabled: true,
      host: 'jump',
      port: 22,
      username: 'u',
      method: 'password' as const,
      password: SECRET_MASK,
      hostFingerprint: 'SHA256:old',
    }
    mountApp(ConnectionDialog, { props: { connection: dto({ settings: settings({ ssh }) }) } })
    await section('SSH tunnel')
    await typeInto(byLabel('SSH host'), 'other')
    expect(byLabel('Host key fingerprint').value).toBe('')
    await typeInto(byLabel('SSH host'), 'jump')
    expect(byLabel('Host key fingerprint').value).toBe('SHA256:old')
  })

  it('moves between sections with the arrow keys (Minor 8)', async () => {
    mountApp(ConnectionDialog)
    // The sections are under Advanced options (user request 2026-10-16).
    ;(document.querySelector('[data-advanced-toggle]') as HTMLButtonElement).click()
    await flushPromises()
    const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
    tabs()[0]!.focus()
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    const panel = document.querySelector('[role="tabpanel"]')!
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[1]!.id)
  })

  it('explains a refused secret reuse in the current language (Minor 9)', async () => {
    i18n.global.locale.value = 'tr'
    mockApi({
      'PATCH connections/c1': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'English text', details: { reason: 'masked_secret_reuse' } },
      ],
    })
    mountApp(ConnectionDialog, { props: { connection: dto() } })
    // Saving an edit needs a change (user report 2026-10-16).
    await typeInto(byLabel('Ad'), 'Prod 2')
    button('Kaydet').click()
    await flushPromises()
    const alert = document.querySelector('[role="alert"]')!.textContent!
    expect(alert).not.toContain('English text')
    expect(alert).toContain('yeniden girin')
  })

  it('closes an untouched editor at once (Minor 10)', async () => {
    const { wrapper } = mountApp(ConnectionDialog)
    mountApp(DialogHost)
    ;(document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('asks before discarding unsaved edits (Minor 10)', async () => {
    const { wrapper } = mountApp(ConnectionDialog)
    mountApp(DialogHost)
    await typeInto(byLabel('Name'), 'changed')
    ;(document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(document.body.textContent).toContain('Discard your changes?')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('renames open connection tabs after a save (Minor 11)', async () => {
    await workspace({ 'PATCH connections/c1': () => [200, dto({ name: 'Renamed' })] })
    const tabs = useTabsStore()
    tabs.open({ kind: 'connection', title: 'Prod', params: { connectionId: 'c1' } })
    useWorkspaceDialogs().open({
      kind: 'connection',
      connection: dto({ settings: settings({ tls: TLS_OFF, auth: { mechanism: 'none' } }) }),
    })
    await vi.waitFor(
      () => expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Edit connection'),
      { timeout: 10_000 },
    )
    await typeInto(byLabel('Name'), 'Renamed')
    // The dialog's own Save: under a loaded run the overview behind it has loaded its widget
    // settings too, with a Save of their own first on the page.
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Save')!
      .click()
    // The save is a chain of requests: under a loaded run one round of promises is not all of it.
    await vi.waitFor(() => expect(tabs.tabs.find((t) => t.kind === 'connection')?.title).toBe('Renamed'), {
      timeout: 10_000,
    })
    // Room for a busy parallel run: the dialog is a lazily loaded chunk.
  }, 20_000)
})

describe('tree and sidebar', () => {
  it('drops the last collection and refreshes the database list (Minor 3), keeping keyboard focus in the tree (Minor 7)', async () => {
    // The tree and the connection tab both read the database list, so count reads after the drop.
    let dropped = false
    let readsAfterDrop = 0
    await workspace({
      'GET connections/c1/databases': () => {
        if (dropped) readsAfterDrop++
        return [
          200,
          { databases: dropped ? [] : [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 0 },
        ]
      },
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
      ],
      'DELETE connections/c1/databases/shop/collections/orders': () => {
        dropped = true
        return [204]
      },
    })
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        (i) => i.getAttribute('aria-label') === label,
      )!
    item('Prod').querySelector<HTMLElement>('[data-test="connection"]')!.click()
    await flushPromises()
    item('shop').focus()
    item('shop').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    item('orders').focus()
    ;(document.querySelector('button[aria-label="Actions for orders"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Drop')!
      .click()
    await flushPromises()
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'orders')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(readsAfterDrop).toBeGreaterThan(0)
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'))
  })

  it('offers Retry when the connection list fails (Minor 5)', async () => {
    let up = false
    await workspace({ 'GET connections': () => (up ? [200, []] : [500, { code: 'INTERNAL', message: 'x' }]) })
    expect(document.querySelector('nav [role="alert"]')).not.toBeNull()
    up = true
    button('Retry').click()
    await flushPromises()
    expect(document.body.textContent).toContain('No connections yet.')
  })

  it('closes the menu when the page scrolls or resizes (Minor 6)', async () => {
    const { wrapper } = mountApp(DsMenu, { props: { label: 'Menu', items: [{ id: 'a', label: 'A' }] } })
    ;(wrapper.vm as unknown as { openMenu(): Promise<void> }).openMenu()
    await nextTick()
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('import safety (Minor 4)', () => {
  const pick = async (file: File) => {
    const input = byLabel('Connections file (.json)')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }

  it('refuses oversized files without reading them', async () => {
    const { calls } = mockApi({})
    mountApp(ImportConnectionsDialog)
    const big = new File(['x'], 'big.json')
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 })
    const text = vi.spyOn(big, 'text')
    await pick(big)
    button('Import').click()
    await flushPromises()
    expect(text).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('too large')
  })

  it('warns that masked secrets in the file are not imported', async () => {
    mockApi({ 'POST connections/import': () => [200, { created: 1 }] })
    mountApp(ImportConnectionsDialog)
    const file = {
      format: 'mongo-manager-connections',
      version: 1,
      connections: [
        {
          name: 'A',
          settings: {
            hosts: [{ host: 'h' }],
            auth: { mechanism: 'DEFAULT', username: 'u', password: SECRET_MASK },
          },
        },
      ],
    }
    await pick(new File([JSON.stringify(file)], 'c.json'))
    button('Import').click()
    await flushPromises()
    expect(
      useToastStore()
        .toasts.map((t) => t.message)
        .join(' '),
    ).toContain('passwords')
  })

  it('says how many connections came without timeoutMS, in the app’s language', async () => {
    mockApi({ 'POST connections/import': () => [200, { created: 2, refusedOptionsDropped: 2 }] })
    mountApp(ImportConnectionsDialog)
    const file = {
      format: 'mongo-manager-connections',
      version: 1,
      connections: [{ name: 'A', settings: { hosts: [{ host: 'h' }] } }],
    }
    await pick(new File([JSON.stringify(file)], 'c.json'))
    button('Import').click()
    await flushPromises()
    const said = () =>
      useToastStore()
        .toasts.map((t) => t.message)
        .join(' ')
    expect(said()).toContain('2 connections were imported without timeoutMS')
    // A dialog of its own, in Turkish: the English one is gone.
    document.body.innerHTML = ''
    useToastStore().toasts.splice(0)
    i18n.global.locale.value = 'tr'
    mockApi({ 'POST connections/import': () => [200, { created: 1, refusedOptionsDropped: 1 }] })
    mountApp(ImportConnectionsDialog)
    const input = byLabel('Bağlantı dosyası (.json)')
    Object.defineProperty(input, 'files', {
      value: [new File([JSON.stringify(file)], 'c.json')],
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    button('İçe aktar').click()
    await flushPromises()
    expect(said()).toContain('1 bağlantı timeoutMS olmadan içe aktarıldı')
  })
})

describe('form model helpers', () => {
  it('still exposes an empty form', () => {
    expect(emptyForm().hosts).toHaveLength(1)
  })
})
