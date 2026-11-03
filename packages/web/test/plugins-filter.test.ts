import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { PluginAdminView } from '@mongo-manager/shared/browser'
import PluginsView from '../src/admin/PluginsView.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/** User request 2026-10-28: the Plugins page filtered by state and where a plugin came from, searched. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const DIGEST = 'ab'.repeat(32)
const plugin = (
  id: string,
  name: Record<string, string>,
  over: Partial<PluginAdminView> = {},
  description?: Record<string, string>,
  tab?: Record<string, string>,
  permissions: string[] = ['documents:read'],
): PluginAdminView => ({
  id,
  source: 'bundled',
  manifest: {
    id,
    name,
    description,
    version: '1.0.0',
    entry: 'index.html',
    permissions,
    contributes: {
      collectionTabs: tab ? [{ id: 't', title: tab, icon: 'map' }] : [],
      documentActions: [],
      sidebarPanels: [],
      cellRenderers: [],
    },
    settings: {},
  } as never,
  digest: DIGEST,
  fileCount: 1,
  bytes: 10,
  enabled: false,
  approvedPermissions: [],
  approvedCurrent: false,
  newPermissions: [],
  settings: {},
  installedBy: null,
  installedAt: 0,
  updatedAt: 0,
  error: null,
  updatedFrom: null,
  readme: false,
  scan: null,
  origin: null,
  approvalCarried: false,
  ...over,
})
const on = { enabled: true, approvedCurrent: true, approvedPermissions: ['documents:read' as const] }
const PLUGINS = [
  plugin('geojson-map', { en: 'Map', tr: 'Harita' }, on, { en: 'Shows GeoJSON on a map' }),
  plugin('mock-data', { en: 'Mock data' }, {}, { en: 'Fills a collection with made-up documents' }),
  plugin('charts', { en: 'Charts', tr: 'Grafikler' }, { ...on, enabled: false }, undefined, {
    en: 'Field chart',
    tr: 'Alan grafiği',
  }),
  plugin(
    'shell-ext',
    { en: 'Shell extras' },
    { source: 'upload', approvedPermissions: ['documents:read'], approvedCurrent: false },
    undefined,
    undefined,
    ['documents:write'],
  ),
  plugin('broken', { en: 'x' }, { manifest: null, digest: null, error: 'bad', source: 'folder' }),
]

/** The page over a list the server may change (`now.plugins`), as an action or a scan does. */
async function page(plugins = PLUGINS, extra: Parameters<typeof mockApi>[0] = {}) {
  const now = { plugins }
  mockApi({ 'GET plugins/manage': () => [200, { enabled: true, plugins: now.plugins }], ...extra })
  mountApp(PluginsView)
  await flushPromises()
  return now
}
const shown = () => [...document.querySelectorAll<HTMLElement>('[data-plugin]')].map((c) => c.dataset.plugin)
const status = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-plugin-status-filter] [role="radio"]')].find((b) =>
    b.textContent!.trim().startsWith(label),
  )!
const statuses = () =>
  [...document.querySelectorAll('[data-plugin-status-filter] [role="radio"]')].map((b) =>
    b.textContent!.trim(),
  )
const searchField = () => document.querySelector<HTMLInputElement>('[data-plugin-search] input')!
async function search(text: string) {
  searchField().value = text
  searchField().dispatchEvent(new Event('input'))
  await nextTick()
}
const source = () => document.querySelector<HTMLSelectElement>('[data-plugin-source-filter] select')!
async function pickSource(value: string) {
  source().value = value
  source().dispatchEvent(new Event('change'))
  await nextTick()
}
const summary = () => document.querySelector('[data-plugin-count]')!.textContent!.trim()

describe('the Plugins page’s filters', () => {
  it('count the plugins in each state', async () => {
    await page()
    expect(statuses()).toEqual(['All (5)', 'Enabled (1)', 'Needs attention (3)', 'Disabled (1)'])
    expect(status('All').getAttribute('aria-checked')).toBe('true')
    expect(shown()).toEqual(['geojson-map', 'mock-data', 'charts', 'shell-ext', 'broken'])
    expect(summary()).toBe('5 plugins')
  })

  it('show only the enabled ones', async () => {
    await page()
    status('Enabled').click()
    await nextTick()
    expect(shown()).toEqual(['geojson-map'])
    expect(summary()).toBe('1 of 5 plugins')
  })

  it('show those waiting for an approval, changed or broken, as needing attention', async () => {
    await page()
    status('Needs attention').click()
    await nextTick()
    expect(shown()).toEqual(['mock-data', 'shell-ext', 'broken'])
    status('Disabled').click()
    await nextTick()
    expect(shown()).toEqual(['charts'])
  })

  it('show those from one source', async () => {
    await page()
    expect([...source().options].map((o) => o.textContent!.trim())).toEqual([
      'Any source',
      'Shipped with Mongo Manager',
      'Uploaded',
      'Folder',
    ])
    await pickSource('upload')
    expect(shown()).toEqual(['shell-ext'])
    await pickSource('folder')
    expect(shown()).toEqual(['broken'])
  })

  it('find a plugin by its name, description, id or what it adds', async () => {
    await page()
    await search('mock')
    expect(shown()).toEqual(['mock-data'])
    await search('geojson')
    expect(shown()).toEqual(['geojson-map'])
    await search('made-up')
    expect(shown()).toEqual(['mock-data'])
    await search('field chart')
    expect(shown()).toEqual(['charts'])
    // Every word, anywhere: not the phrase as typed.
    await search('map shows')
    expect(shown()).toEqual(['geojson-map'])
    // Every word, not any of them.
    await search('mock charts')
    expect(shown()).toEqual([])
    // Its id, which its name does not hold.
    await search('shell-ext')
    expect(shown()).toEqual(['shell-ext'])
    await search('  ')
    expect(shown()).toHaveLength(5)
  })

  it('find Turkish words typed without their marks or capitals', async () => {
    i18n.global.locale.value = 'tr'
    await page()
    await search('ALAN GRAFIGI')
    expect(shown()).toEqual(['charts'])
    await search('harita')
    expect(shown()).toEqual(['geojson-map'])
  })

  it('combine the state, the source and the search', async () => {
    await page()
    status('Needs attention').click()
    await pickSource('bundled')
    await search('data')
    expect(shown()).toEqual(['mock-data'])
    expect(summary()).toBe('1 of 5 plugins')
  })

  it('say when nothing matches, and clear every filter at once', async () => {
    await page()
    status('Enabled').click()
    await pickSource('upload')
    await search('nothing like it')
    expect(shown()).toEqual([])
    expect(document.querySelector('[data-plugins-no-match]')!.textContent).toContain('No plugin matches')
    button('Clear filters').click()
    await nextTick()
    expect(shown()).toHaveLength(5)
    expect(status('All').getAttribute('aria-checked')).toBe('true')
    expect(source().value).toBe('')
    expect(searchField().value).toBe('')
  })

  it('offer no filters while there is no plugin', async () => {
    await page([])
    expect(document.querySelector('[data-plugin-filters]')).toBeNull()
  })

  it('say the states in the user’s language', async () => {
    i18n.global.locale.value = 'tr'
    await page()
    expect(statuses()).toEqual(['Tümü (5)', 'Etkin (1)', 'İşlem bekleyen (3)', 'Devre dışı (1)'])
    expect(summary()).toBe('5 eklenti')
    status('Etkin').click()
    await nextTick()
    expect(summary()).toBe('1 / 5 eklenti')
  })

  // Final review: the states are named, each count among the plugins the source and search leave.
  it('count, by state, the plugins the source and the search leave', async () => {
    await page()
    expect(document.querySelector('[data-plugin-status-filter]')!.getAttribute('aria-label')).toBe(
      'Show plugins',
    )
    await pickSource('upload')
    expect(statuses()).toEqual(['All (1)', 'Enabled (0)', 'Needs attention (1)', 'Disabled (0)'])
    await pickSource('')
    await search('map')
    expect(statuses()).toEqual(['All (1)', 'Enabled (1)', 'Needs attention (0)', 'Disabled (0)'])
  })

  // Final review: what a plugin asks for, its version, and a Turkish capital typed in English.
  it('find a plugin by what it asks for, by its version, and with a Turkish capital in English', async () => {
    const later = plugin('later', { en: 'Later' })
    await page([...PLUGINS, { ...later, manifest: { ...later.manifest!, version: '2.4.1' } }])
    await search('change documents')
    expect(shown()).toEqual(['shell-ext'])
    await search('2.4.1')
    expect(shown()).toEqual(['later'])
    await search('FİLLS')
    expect(shown()).toEqual(['mock-data'])
  })

  // Final review: a plugin the server adds (an upload, an install, a scan) is never hidden by a filter.
  it('show a plugin the server adds, the filters cleared', async () => {
    const now = await page(PLUGINS, {
      'POST plugins/scan': () => {
        now.plugins = [...PLUGINS, plugin('fresh', { en: 'Fresh one' }, { source: 'folder' })]
        return [200, { enabled: true, plugins: now.plugins }]
      },
    })
    status('Enabled').click()
    await search('map')
    button('Scan again').click()
    await flushPromises()
    expect(shown()).toContain('fresh')
    expect(status('All').getAttribute('aria-checked')).toBe('true')
    expect(searchField().value).toBe('')
  })

  it('keep the filters when the server adds a plugin they show', async () => {
    const now = await page(PLUGINS, {
      'POST plugins/scan': () => {
        now.plugins = [...PLUGINS, plugin('fresh', { en: 'Fresh map' }, { ...on, source: 'folder' })]
        return [200, { enabled: true, plugins: now.plugins }]
      },
    })
    status('Enabled').click()
    await search('map')
    button('Scan again').click()
    await flushPromises()
    expect(shown()).toEqual(['geojson-map', 'fresh'])
    expect(status('Enabled').getAttribute('aria-checked')).toBe('true')
  })

  // Final review: a card that leaves the list with the focus in it hands the focus on.
  it('moves the focus to the next plugin when the one in hand leaves the list', async () => {
    const ids = ['geojson-map', 'second', 'third']
    const three = [
      PLUGINS[0]!,
      plugin('second', { en: 'Second' }, on),
      plugin('third', { en: 'Third' }, on),
      ...PLUGINS.slice(1),
    ]
    const now = await page(
      three,
      Object.fromEntries(
        ids.map((id) => [
          `POST plugins/${id}/disable`,
          () => {
            now.plugins = now.plugins.map((p) => (p.id === id ? { ...p, enabled: false } : p))
            return [200, now.plugins.find((p) => p.id === id)]
          },
        ]),
      ),
    )
    status('Enabled').click()
    await nextTick()
    const disable = async (id: string) => {
      const b = [...document.querySelectorAll<HTMLButtonElement>(`[data-plugin="${id}"] button`)].find(
        (x) => x.textContent!.trim() === 'Disable',
      )!
      b.focus()
      b.click()
      await flushPromises()
      await nextTick()
    }
    const nameOf = (id: string) => document.querySelector(`[data-plugin="${id}"] [data-plugin-name]`)
    // One in the middle: to the one after it, now in its place.
    await disable('second')
    expect(shown()).toEqual(['geojson-map', 'third'])
    expect(document.activeElement).toBe(nameOf('third'))
    // The last one: to the one before it.
    await disable('third')
    expect(shown()).toEqual(['geojson-map'])
    expect(document.activeElement).toBe(nameOf('geojson-map'))
    // The only one left: to the way back to every plugin.
    await disable('geojson-map')
    expect(shown()).toEqual([])
    expect(document.activeElement?.textContent?.trim()).toBe('Clear filters')
    expect(document.activeElement?.closest('[data-plugins-no-match]')).not.toBeNull()
  })

  // Final review: the count is said once the typing stops, not at every key.
  it('says the count once the typing stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await page()
      const said = () => document.querySelector('[data-plugin-announce]')!.textContent!.trim()
      expect(document.querySelector('[data-plugin-count]')!.getAttribute('role')).toBeNull()
      expect(document.querySelector('[data-plugin-announce]')!.getAttribute('role')).toBe('status')
      await search('m')
      await search('mo')
      await search('moc')
      expect(said()).toBe('')
      vi.advanceTimersByTime(600)
      await nextTick()
      expect(said()).toBe('1 of 5 plugins')
    } finally {
      vi.useRealTimers()
    }
  })
})

/** User request 2026-10-31: the Plugins page uses its width — figures, a grid of cards, a side column. */
describe('the Plugins page laid out wide', () => {
  it('counts the plugins by state above them', async () => {
    await page()
    const figures = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-plugin-stats] [data-stat]')].map((s) => [
        s.dataset.stat,
        s.querySelector('dd')!.textContent!.trim(),
      ]),
    )
    expect(figures).toEqual({ installed: '5', enabled: '1', attention: '3', disabled: '1' })
    expect(document.querySelector('[data-plugin-stats]')!.textContent).toContain('Installed')
  })

  it('shows the plugins as a grid of cards, and installing and building beside them', async () => {
    await page(PLUGINS, {})
    const grid = document.querySelector('[data-plugin-grid]')!
    expect(grid.querySelectorAll('[data-plugin]')).toHaveLength(5)
    const aside = document.querySelector('aside[data-plugin-aside]')!
    expect(aside.querySelector('[data-plugin-build]')).not.toBeNull()
    expect(aside.textContent).toContain('How plugins run')
    // Each card ends in its actions: the name opens the details, Approve or Disable beside it.
    const card = grid.querySelector<HTMLElement>('[data-plugin="mock-data"]')!
    expect(card.querySelector('[data-plugin-actions]')!.textContent).toContain('Approve')
  })
})
