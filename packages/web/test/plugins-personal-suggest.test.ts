// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import type { PluginPermission, PluginRuntimeView } from '@mongo-manager/shared'
import PluginFrame from '../src/plugins/PluginFrame.vue'
import PersonalDataCard from '../src/workspace/tabs/PersonalDataCard.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { i18n } from '../src/i18n'
import { forgetAppInput } from '../src/plugins/appInput'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'

/**
 * Research 2026-10-28 (the personal data finder): a plugin suggests fields of its collection as
 * personal data. Nothing is saved on its word: the collection's Personal data section opens with
 * the fields listed as suggested, and an administrator adds each there — the card's own save.
 */
const TOKEN = '00000000-0000-4000-8000-0000000000bb'
const activation = { isActive: true }
beforeEach(() => {
  activation.isActive = true
  Object.defineProperty(navigator, 'userActivation', {
    value: activation,
    configurable: true,
    enumerable: true,
  })
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(TOKEN)
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  forgetAppInput()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const runtime = (permissions: PluginPermission[]): PluginRuntimeView => ({
  id: 'finder',
  version: '1.0.0',
  name: { en: 'Finder' },
  entry: 'index.html',
  permissions,
  contributes: {
    collectionTabs: [{ id: 'tab', title: { en: 'Tab' } }],
    documentActions: [],
    sidebarPanels: [],
    cellRenderers: [],
  } as never,
  settings: {},
})
const connection = (permissions: readonly string[]) => ({
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
  permissions: [...permissions],
  export: true,
})
const COLLECTIONS = [
  { name: 'users', type: 'collection', options: {}, readOnly: false },
  // MongoDB's own, listed as a collection: no rule names it all the same.
  { name: 'system.views', type: 'collection', options: {}, readOnly: false },
  { name: 'active', type: 'view', options: { viewOn: 'users', pipeline: [] }, readOnly: true },
]
function frame(o: { permissions?: PluginPermission[]; may?: readonly string[]; coll?: string } = {}) {
  const api = mockApi({
    'GET plugins/finder/ticket': () => [200, { base: 'about:', entry: 'blank', expiresAt: 0 }],
    'GET connections': () => [200, [connection(o.may ?? PERMISSIONS)]],
    'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [] }],
    'GET connections/c1/databases/crm/collections': () => [200, COLLECTIONS],
  })
  mountApp(PluginFrame, {
    props: {
      plugin: runtime(o.permissions ?? ['documents:read']),
      kind: 'collectionTab',
      contribution: 'tab',
      target: { connectionId: 'c1', db: 'crm', coll: o.coll ?? 'users' },
    },
  })
  mountApp(DialogHost)
  return api
}
const send = (data: object, source: Window) =>
  window.dispatchEvent(
    new MessageEvent('message', { data: { ...data, token: TOKEN }, origin: 'null', source }),
  )
async function iframe() {
  await flushPromises()
  const el = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
  const sent: Array<{ id: unknown; result?: unknown; error?: { code: string; message: string } }> = []
  vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
  await flushPromises()
  el.focus()
  return {
    ask: async (id: number, method: string, params?: unknown) => {
      send({ mm: 1, id, method, params }, el.contentWindow!)
      await flushPromises()
      return sent.find((m) => m.id === id)
    },
  }
}
const suggested = () => {
  const tabs = useTabsStore()
  return { tab: tabs.active, state: useCollectionViewsStore().stateFor(tabs.active!.id) }
}

describe('ui.suggestPersonalData', () => {
  it('opens the collection’s Personal data section with the fields suggested, saving nothing', async () => {
    const { calls } = frame()
    const { ask } = await iframe()
    const answer = await ask(1, 'ui.suggestPersonalData', { fields: ['email', 'contact.phone', 'email'] })
    expect(answer!.result).toBe(true)
    const { tab, state } = suggested()
    expect(tab!.params).toMatchObject({ connectionId: 'c1', db: 'crm', coll: 'users' })
    expect(state.section).toBe('personalData')
    // Each field once, named by the plugin.
    expect(state.personalSuggested).toEqual({ by: 'Finder (finder)', fields: ['email', 'contact.phone'] })
    expect(calls.some((c) => c.path.includes('personal-fields') && c.method !== 'GET')).toBe(false)
  })

  it('is for the connection’s administrators, on a collection, after a click in the plugin', async () => {
    frame({ may: PERMISSIONS.filter((p) => p !== 'connections:manage') })
    const first = await iframe()
    expect((await first.ask(1, 'ui.suggestPersonalData', { fields: ['email'] }))!.error!.code).toBe(
      'not_permitted',
    )
    document.body.innerHTML = ''
    // A view's values are its source's: its rules are named there.
    frame({ coll: 'active' })
    const view = await iframe()
    expect((await view.ask(2, 'ui.suggestPersonalData', { fields: ['email'] }))!.error!.code).toBe(
      'bad_params',
    )
    document.body.innerHTML = ''
    frame({ permissions: [] })
    const unread = await iframe()
    expect((await unread.ask(3, 'ui.suggestPersonalData', { fields: ['email'] }))!.error!.code).toBe(
      'not_permitted',
    )
    document.body.innerHTML = ''
    frame()
    const late = await iframe()
    activation.isActive = false
    expect((await late.ask(4, 'ui.suggestPersonalData', { fields: ['email'] }))!.error!.code).toBe(
      'no_activation',
    )
  })

  it('suggests nothing once the user clicked elsewhere while the collection was looked up', async () => {
    let release: () => void = () => {}
    mockApi({
      'GET plugins/finder/ticket': () => [200, { base: 'about:', entry: 'blank', expiresAt: 0 }],
      'GET connections': () => [200, [connection(PERMISSIONS)]],
      'GET connections/c1/personal-fields/applied': () => [200, { rules: [], patterns: [] }],
      'GET connections/c1/databases/crm/collections': () =>
        new Promise((resolve) => (release = () => resolve([200, COLLECTIONS]))),
    })
    mountApp(PluginFrame, {
      props: {
        plugin: runtime(['documents:read']),
        kind: 'collectionTab',
        contribution: 'tab',
        target: { connectionId: 'c1', db: 'crm', coll: 'users' },
      },
    })
    await flushPromises()
    const el = document.querySelector<HTMLIFrameElement>('[data-plugin-frame] iframe')!
    const sent: Array<{ id: unknown; error?: { code: string } }> = []
    vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation((d: unknown) => void sent.push(d as never))
    await flushPromises()
    el.focus()
    send({ mm: 1, id: 1, method: 'ui.suggestPersonalData', params: { fields: ['email'] } }, el.contentWindow!)
    await flushPromises()
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    release()
    // The look-up gives up on a slow list after a while: well within it here.
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(sent.find((m) => m.id === 1)?.error?.code).toBe('no_activation')
    expect(useTabsStore().tabs.some((t) => t.kind === 'collection')).toBe(false)
  })

  it('takes plain field paths only: no wildcard, operator, empty or spoofing name, at most 50', async () => {
    const rtl = String.fromCharCode(0x202e)
    const bad: unknown[] = [
      undefined,
      'email',
      [],
      [42],
      ['*'],
      ['a.*'],
      ['**.email'],
      ['$where'],
      ['a..b'],
      ['a.'],
      [`e${rtl}liame`],
      ['x'.repeat(129)],
      [`email${String.fromCharCode(0x200b)}`],
      [`email${String.fromCharCode(0xfeff)}`],
      ['email '],
      ['a. b'],
      Array.from({ length: 51 }, (_, i) => `f${i}`),
    ]
    // A frame may ask 10 a minute: a new one every few.
    let ask: Awaited<ReturnType<typeof iframe>>['ask'] = async () => undefined
    for (const [n, fields] of bad.entries()) {
      if (n % 5 === 0) {
        document.body.innerHTML = ''
        frame()
        ask = (await iframe()).ask
      }
      expect(
        (await ask(n + 1, 'ui.suggestPersonalData', { fields }))!.error?.code,
        JSON.stringify(fields),
      ).toBe('bad_params')
    }
    // Nor a collection named as a rule's wildcard, MongoDB's own, or one not known to be a collection.
    for (const coll of ['*', 'system.views', 'unlisted']) {
      document.body.innerHTML = ''
      frame({ coll })
      const error = (await (await iframe()).ask(99, 'ui.suggestPersonalData', { fields: ['email'] }))!.error
      expect(error?.code, coll).toBe('bad_params')
      // One the list does not name is said so, never taken for a view.
      if (coll === 'unlisted') expect(error!.message).toContain('not in its database’s list')
    }
    expect(useTabsStore().tabs.some((t) => t.kind === 'collection')).toBe(false)
  })
})

describe('the suggested fields on the Personal data card', () => {
  const RULES = [{ db: 'crm', coll: 'users', field: 'email' }]
  /** The collection's sampled fields: what the card offers a suggestion of. */
  const SCHEMA = {
    sampled: 3,
    truncated: false,
    fields: [
      { path: 'email', keys: ['email'], count: 3, types: { string: 3 } },
      { path: 'phone', keys: ['phone'], count: 3, types: { string: 3 } },
      { path: 'address', keys: ['address'], count: 3, types: { object: 3 } },
      { path: 'address.city', keys: ['address', 'city'], count: 3, types: { string: 3 } },
      { path: 'cards[].number', keys: ['cards', null, 'number'], count: 2, types: { string: 2 } },
      // One key with a dot: no path a, b.
      { path: 'a.b', keys: ['a.b'], count: 1, types: { string: 1 } },
    ],
  }
  function server(
    first: Array<{ db: string; coll: string; field: string }> = RULES,
    schema: () => [number, unknown] = () => [200, SCHEMA],
  ) {
    let stored = first
    return mockApi({
      'GET connections/c1/personal-fields': () => [200, { rules: stored }],
      'PUT connections/c1/personal-fields': (body) => {
        stored = (body as { rules: typeof stored }).rules
        return [200, { rules: stored }]
      },
      'GET connections/c1/databases/crm/collections': () => [200, COLLECTIONS],
      'POST connections/c1/databases/crm/collections/users/schema': () => schema(),
    })
  }
  const mountCard = async (fields: string[]) => {
    useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never
    const mounted = mountApp(PersonalDataCard, {
      props: {
        connection: { id: 'c1', name: 'M' },
        scope: { db: 'crm', coll: 'users' },
        suggested: { by: 'Finder', fields },
      },
    })
    await flushPromises()
    return mounted
  }
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('[data-suggested-field]')].map((r) => r.dataset.suggestedField)
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-personal-suggested] button')].find(
      (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    )!

  it('lists the fields not yet a rule, named by the plugin, and adds one on a click', async () => {
    const { calls } = server()
    await mountCard(['email', 'phone', 'address.city'])
    const block = document.querySelector('[data-personal-suggested]')!
    expect(block.textContent).toContain('Suggested by Finder')
    expect(rows()).toEqual(['phone', 'address.city'])
    button('Add phone as personal data').click()
    await flushPromises()
    const put = calls.filter((c) => c.method === 'PUT').at(-1)!
    expect((put.body as { rules: unknown[] }).rules).toEqual([
      ...RULES,
      { db: 'crm', coll: 'users', field: 'phone' },
    ])
    expect(rows()).toEqual(['address.city'])
  })

  it('adds them all on one click, in one save, then says so; dismissing tells the tab', async () => {
    const { calls } = server()
    const { wrapper } = await mountCard(['phone', 'address.city', 'cards.number'])
    button('Add all').click()
    await flushPromises()
    // One change, one save (review I6).
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    const last = calls.filter((c) => c.method === 'PUT').at(-1)!
    expect((last.body as { rules: Array<{ field: string }> }).rules.map((r) => r.field)).toEqual([
      'email',
      'phone',
      'address.city',
      'cards.number',
    ])
    expect(rows()).toEqual([])
    expect(document.querySelector('[data-personal-suggested]')!.textContent).toContain(
      'Each suggested field is a rule now',
    )
    button('Dismiss').click()
    expect(wrapper.emitted('dismissSuggested')).toHaveLength(1)
  })

  it('offers only a field a sample of the collection holds, and none a wider rule hides already', async () => {
    const zeroWidth = `phone${String.fromCharCode(0x200b)}`
    server([...RULES, { db: '*', coll: '*', field: 'address' }])
    await mountCard(['phone', zeroWidth, 'ghost', 'address.city'])
    // address.city: under *.*.address, hidden already.
    expect(rows()).toEqual(['phone', zeroWidth, 'ghost'])
    const state = (field: string) =>
      document.querySelector(`[data-suggested-field="${field}"]`)!.querySelector('[data-suggested-state]')
        ?.textContent
    expect(state('phone')).toBeUndefined()
    expect(state(zeroWidth)).toBe('Not in a sample of this collection: not offered')
    expect(state('ghost')).toBe('Not in a sample of this collection: not offered')
    expect(document.querySelectorAll('[data-personal-suggested] [aria-label^="Add "]')).toHaveLength(1)
  })

  it('offers no field a key with a dot only looks like, and says when the sample read part of the fields', async () => {
    server(RULES, () => [200, { ...SCHEMA, truncated: true }])
    await mountCard(['a.b', 'phone'])
    expect(document.querySelector('[data-suggested-field="a.b"] [data-suggested-state]')!.textContent).toBe(
      'Not in a sample of this collection: not offered',
    )
    expect(document.querySelector('[data-suggested-partial]')!.textContent).toContain(
      'The sample read only part of this collection’s fields',
    )
  })

  it('says when the collection’s fields could not be read, offering none, and reads them again', async () => {
    let fail = true
    server(RULES, () => (fail ? [500, { code: 'INTERNAL', message: 'x' }] : [200, SCHEMA]))
    await mountCard(['phone'])
    const block = document.querySelector('[data-personal-suggested]')!
    expect(block.textContent).toContain('The collection’s fields could not be read')
    expect(document.querySelectorAll('[data-personal-suggested] [aria-label^="Add "]')).toHaveLength(0)
    fail = false
    button('Retry').click()
    await flushPromises()
    expect(document.querySelectorAll('[data-personal-suggested] [aria-label^="Add "]')).toHaveLength(1)
  })

  it('adds no more than the rules that fit, and says so', async () => {
    const full = Array.from({ length: 199 }, (_, i) => ({ db: 'crm', coll: 'other', field: `f${i}` }))
    const { calls } = server(full)
    await mountCard(['phone', 'address.city'])
    expect(document.querySelector('[data-suggested-room]')!.textContent).toContain(
      'Only 1 more rule fits (200 at most).',
    )
    button('Add all').click()
    await flushPromises()
    const rules = (calls.filter((c) => c.method === 'PUT').at(-1)!.body as { rules: unknown[] }).rules
    expect(rules).toHaveLength(200)
  })

  it('takes the focus when it opens, a region named by its plugin', async () => {
    server()
    await mountCard(['phone'])
    const block = document.querySelector<HTMLElement>('[data-personal-suggested]')!
    expect(block.getAttribute('role')).toBe('region')
    expect(document.getElementById(block.getAttribute('aria-labelledby')!)!.textContent).toContain(
      'Suggested by Finder',
    )
    expect(document.activeElement).toBe(block)
  })

  it('says it in Turkish', async () => {
    server()
    i18n.global.locale.value = 'tr'
    await mountCard(['phone'])
    expect(document.querySelector('[data-personal-suggested]')!.textContent).toContain('Finder önerisi')
    expect(button('phone alanını kişisel veri olarak ekle')).toBeTruthy()
  })
})
