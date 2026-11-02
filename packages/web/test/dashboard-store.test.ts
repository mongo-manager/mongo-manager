import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DashboardSchema, type Dashboard } from '@mongo-manager/shared'
import { useDashboardStore } from '../src/stores/dashboard'
import { i18n } from '../src/i18n'
import { mockApi } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => vi.unstubAllGlobals())

const settle = () => new Promise((r) => setTimeout(r, 650))
const SAVED: Dashboard = {
  version: 1,
  widgets: [
    { id: '00000000-0000-4000-8000-000000000001', type: 'quick', size: 's', settings: {} },
    { id: '00000000-0000-4000-8000-000000000002', type: 'activity', size: 'xl', settings: {} },
  ],
}

describe('the Overview dashboard store (user review 2026-10-09)', () => {
  it('starts from today’s Overview when nothing is saved, and saves nothing for it', async () => {
    const { calls } = mockApi({ 'GET me/dashboard': () => [200, { dashboard: null }] })
    const store = useDashboardStore()
    await store.load('u1')
    expect(store.widgets.map((w) => w.type)).toEqual([
      'continue',
      'pinned',
      'attention',
      'connections',
      'queries',
      'activity',
      'quick',
      'nextActions',
    ])
    expect(store.status).toBe('ready')
    await settle()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('shows what was saved', async () => {
    mockApi({ 'GET me/dashboard': () => [200, { dashboard: SAVED }] })
    const store = useDashboardStore()
    await store.load('u1')
    expect(store.widgets).toEqual(SAVED.widgets)
  })

  it('changes at once and saves the whole layout once, a moment after the last change', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const store = useDashboardStore()
    await store.load('u1')
    const added = store.add('aiUsage', {}, 'm')!
    store.resize(added, 'l')
    store.move(added, 0)
    store.setCollapsed('00000000-0000-4000-8000-000000000001', true)
    expect(store.widgets.map((w) => w.type)).toEqual(['aiUsage', 'quick', 'activity'])
    expect(store.widgets[0]!.size).toBe('l')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    await settle()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body).toEqual({ version: 1, widgets: store.widgets })
    store.remove(added)
    store.configure('00000000-0000-4000-8000-000000000002', {})
    await settle()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
    expect(store.widgets.map((w) => w.type)).toEqual(['quick', 'activity'])
  })

  // Review of the e2e gaps (I1): a change left the half second before Done, or before the page went
  // away, was never saved.
  it('saves at once when the editing ends, and as the page goes away', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const fetches = vi.spyOn(globalThis, 'fetch')
    const store = useDashboardStore()
    await store.load('u1')
    store.beginEdit()
    store.add('aiUsage', {}, 'm')
    store.endEdit()
    await Promise.resolve()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    store.move(store.widgets.at(-1)!.id, 0)
    window.dispatchEvent(new Event('pagehide'))
    await Promise.resolve()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect((puts[1]!.body as Dashboard).widgets[0]!.type).toBe('aiUsage')
    // Sent so that it outlives the page.
    expect(fetches.mock.calls.at(-1)![1]).toMatchObject({ method: 'PUT', keepalive: true })
    await settle()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
  })

  it('takes no more than 30 widgets', async () => {
    mockApi({
      'GET me/dashboard': () => [200, { dashboard: { version: 1, widgets: [] } }],
      'PUT me/dashboard': () => [200, {}],
    })
    const store = useDashboardStore()
    await store.load('u1')
    const server = (i: number) => ({ connectionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })
    for (let i = 0; i < 30; i++) expect(store.add('serverStatus', server(i), 's')).not.toBeNull()
    expect(store.add('serverStatus', server(30), 's')).toBeNull()
    expect(store.widgets).toHaveLength(30)
    // Its save done here, never in the next test.
    await store.flush()
  })

  // User report 2026-10-27 ("aynı sunucu durumu Demo ekleyebiliyorum saçma olmuş").
  it('takes the same widget once: added, set to what another shows, or put back', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: { version: 1, widgets: [] } }],
      'PUT me/dashboard': () => [200, {}],
    })
    const store = useDashboardStore()
    await store.load('u1')
    const A = { connectionId: '00000000-0000-4000-8000-00000000000a' }
    const B = { connectionId: '00000000-0000-4000-8000-00000000000b' }
    const first = store.add('serverStatus', A)
    expect(first).not.toBeNull()
    expect(store.add('serverStatus', A)).toBeNull()
    expect(store.add('quick')).not.toBeNull()
    expect(store.add('quick')).toBeNull()
    const second = store.add('serverStatus', B)!
    store.configure(second, A)
    expect(store.widgets.find((w) => w.id === second)!.settings).toEqual(B)
    // A widget is never the same as itself: one of a kind takes new settings (the queries' view).
    const queries = store.add('queries', { view: 'saved' })!
    store.configure(queries, { view: 'recent' })
    expect(store.widgets.find((w) => w.id === queries)!.settings).toEqual({ view: 'recent' })
    store.remove(queries)
    const removed = store.widgets.find((w) => w.id === first)!
    store.remove(first!)
    store.add('serverStatus', A)
    store.restore(removed, 0)
    expect(store.widgets.filter((w) => w.type === 'serverStatus')).toHaveLength(2)
    await store.flush()
    const saved = calls.filter((c) => c.method === 'PUT').at(-1)!.body as Dashboard
    expect(DashboardSchema.safeParse(saved).success).toBe(true)
  })

  it('never saves over a layout it could not load', async () => {
    const { calls } = mockApi({ 'GET me/dashboard': () => [500, { code: 'INTERNAL', message: 'x' }] })
    const store = useDashboardStore()
    await store.load('u1')
    expect(store.status).toBe('unavailable')
    expect(store.widgets.length).toBeGreaterThan(0)
    store.add('quick', {}, 's')
    await settle()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('keeps the changes when a save fails, and says so', async () => {
    mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': () => [500, { code: 'INTERNAL', message: 'x' }],
    })
    const store = useDashboardStore()
    await store.load('u1')
    store.remove('00000000-0000-4000-8000-000000000001')
    await settle()
    expect(store.widgets.map((w) => w.type)).toEqual(['activity'])
    expect(store.saveFailed).toBe(true)
  })

  it('carries over the old Overview choices once, then forgets them', async () => {
    localStorage.setItem('mm:overview:u1', JSON.stringify({ hidden: ['quick'], collapsed: ['activity'] }))
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: null }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const store = useDashboardStore()
    await store.load('u1')
    expect(store.widgets.some((w) => w.type === 'quick')).toBe(false)
    expect(store.widgets.find((w) => w.type === 'activity')!.collapsed).toBe(true)
    await settle()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect(localStorage.getItem('mm:overview:u1')).toBeNull()
  })

  it('goes back to today’s Overview on reset', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'DELETE me/dashboard': () => [204],
    })
    const store = useDashboardStore()
    await store.load('u1')
    await store.resetToDefault()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    expect(store.widgets.map((w) => w.type)[0]).toBe('continue')
  })

  it('forgets the user on sign-out', async () => {
    mockApi({ 'GET me/dashboard': () => [200, { dashboard: SAVED }] })
    const store = useDashboardStore()
    await store.load('u1')
    store.reset()
    expect(store.widgets).toEqual([])
    expect(store.status).toBe('idle')
  })

  it('places a widget at a position and a column, and frees it again', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const store = useDashboardStore()
    await store.load('u1')
    const [quick, activity] = SAVED.widgets.map((w) => w.id)
    store.place(activity!, 0, 7)
    expect(store.widgets.map((w) => [w.type, w.col])).toEqual([
      ['activity', 7],
      ['quick', undefined],
    ])
    store.setColumn(quick!, 1)
    expect(store.widgets[1]!.col).toBe(1)
    store.place(activity!, 1, null)
    expect(store.widgets.map((w) => w.type)).toEqual(['quick', 'activity'])
    expect('col' in store.widgets[1]!).toBe(false)
    // A column out of the grid is never kept.
    store.setColumn(quick!, 13)
    store.setColumn(quick!, 0)
    expect(store.widgets[0]!.col).toBe(1)
    await settle()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('puts back the layout as it was when editing began, saving it once', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const store = useDashboardStore()
    await store.load('u1')
    store.beginEdit()
    const [quick, activity] = SAVED.widgets.map((w) => w.id)
    store.move(activity!, 0)
    store.resize(quick!, 'xl')
    store.setColumn(quick!, 4)
    store.add('aiUsage', {}, 'm')
    store.remove(activity!)
    expect(store.changed).toBe(true)
    store.discardEdit()
    expect(store.widgets).toEqual(SAVED.widgets)
    expect(store.changed).toBe(false)
    expect(store.editing).toBe(false)
    await settle()
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body).toEqual(SAVED)
  })

  it('saves nothing when an edit with no change is cancelled', async () => {
    const { calls } = mockApi({ 'GET me/dashboard': () => [200, { dashboard: SAVED }] })
    const store = useDashboardStore()
    await store.load('u1')
    store.beginEdit()
    store.move(SAVED.widgets[0]!.id, 0)
    store.discardEdit()
    await settle()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    expect(store.editing).toBe(false)
  })

  it('takes back a reset to the default too', async () => {
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'DELETE me/dashboard': () => [204, undefined],
      'PUT me/dashboard': (body) => [200, { dashboard: body }],
    })
    const store = useDashboardStore()
    await store.load('u1')
    store.beginEdit()
    await store.resetToDefault()
    // W6.2: the default holds the next steps too.
    expect(store.widgets).toHaveLength(8)
    store.discardEdit()
    expect(store.widgets).toEqual(SAVED.widgets)
    await settle()
    expect(calls.filter((c) => c.method === 'PUT').at(-1)!.body).toEqual(SAVED)
  })

  it('sends one save at a time, the newest last, and resets only after (final review 6)', async () => {
    let release: () => void = () => undefined
    const bodies: unknown[] = []
    const { calls } = mockApi({
      'GET me/dashboard': () => [200, { dashboard: SAVED }],
      'PUT me/dashboard': (body) => {
        bodies.push(body)
        return bodies.length === 1
          ? new Promise((r) => (release = () => r([200, { dashboard: body }])))
          : [200, { dashboard: body }]
      },
      'DELETE me/dashboard': () => [204, undefined],
    })
    const store = useDashboardStore()
    await store.load('u1')
    const [quick] = SAVED.widgets.map((w) => w.id)
    store.resize(quick!, 'l')
    await settle()
    store.resize(quick!, 'xl')
    await settle()
    // The second waits for the first.
    expect(bodies).toHaveLength(1)
    const reset = store.resetToDefault()
    await settle()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    release()
    await reset
    expect(bodies).toHaveLength(2)
    expect((bodies[1] as Dashboard).widgets[0]!.size).toBe('xl')
    expect(calls.at(-1)!.method).toBe('DELETE')
  })

  it('shows the default and saves nothing over a layout of a newer version (final review 13)', async () => {
    const { calls } = mockApi({ 'GET me/dashboard': () => [200, { dashboard: null, newer: true }] })
    const store = useDashboardStore()
    await store.load('u1')
    expect(store.status).toBe('unavailable')
    expect(store.newer).toBe(true)
    store.add('aiUsage', {}, 'm')
    await settle()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})
