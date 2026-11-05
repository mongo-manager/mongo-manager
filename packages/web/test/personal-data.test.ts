// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { QueryObserver, onlineManager } from '@tanstack/vue-query'
import { h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { rulesEpoch } from '../src/masking/rulesEpoch'
import PersonalDataCard from '../src/workspace/tabs/PersonalDataCard.vue'
import AccessCard from '../src/workspace/tabs/AccessCard.vue'
import { useSessionStore } from '../src/stores/session'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp, type Handler } from './support/app'
import { offered, openPicker, pick, pickerEmpty } from './support/pickers'

/** Phase 3b spec §2.1-2.2: the personal-data rules card and the restricted grant. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

const RULES = [{ db: 'crm', coll: 'users', field: 'email' }]
const SCHEMA = {
  sampled: 3,
  truncated: false,
  fields: [
    { path: 'email', keys: ['email'], count: 3, types: { string: 3 } },
    { path: 'phone', keys: ['phone'], count: 2, types: { string: 2 } },
    { path: 'address', keys: ['address'], count: 3, types: { object: 3 } },
    { path: 'address.city', keys: ['address', 'city'], count: 3, types: { string: 3 } },
    { path: 'cards', keys: ['cards'], count: 1, types: { array: 1 } },
    { path: 'cards[]', keys: ['cards', null], count: 2, types: { object: 2 } },
    { path: 'cards[].number', keys: ['cards', null, 'number'], count: 2, types: { string: 2 } },
    // A key with a dot is no part of a path a rule can name.
    { path: 'a.b', keys: ['a.b'], count: 1, types: { int: 1 } },
  ],
}
/** The server's rules, a PUT made on them (409 when `base` is not what is stored). */
function server(
  first: Array<{ db: string; coll: string; field: string }> = RULES,
  extra: Record<string, Handler> = {},
) {
  let stored = first
  const handlers = mockApi({
    'GET connections/c1/personal-fields': () => [200, { rules: stored }],
    'PUT connections/c1/personal-fields': (body) => {
      const { rules, base } = body as { rules: typeof stored; base?: typeof stored }
      if (base && JSON.stringify(base) !== JSON.stringify(stored))
        return [409, { code: 'CONFLICT', message: 'changed' }]
      stored = rules
      return [200, { rules }]
    },
    'GET connections/c1/databases': () => [
      200,
      {
        databases: [
          { name: 'crm', sizeOnDisk: 1, empty: false },
          { name: 'shop', sizeOnDisk: 1, empty: false },
        ],
        totalSize: 2,
      },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [
        { name: 'users', type: 'collection', options: {}, readOnly: false },
        { name: 'active', type: 'view', options: { viewOn: 'users', pipeline: [] }, readOnly: true },
      ],
    ],
    'GET connections/c1/databases/shop/collections': () => [
      200,
      [{ name: 'orders', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
    ...extra,
  })
  return { ...handlers, stored: () => stored, change: (next: typeof stored) => (stored = next) }
}
const team = () =>
  (useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never)
const localMode = () =>
  (useSessionStore().status = { mode: 'local', setupRequired: false, authenticated: true } as never)
const mountCard = async () => {
  const mounted = mountApp(PersonalDataCard, { props: { connection: { id: 'c1', name: 'M' } } })
  await flushPromises()
  return mounted
}
const cells = (marker: string) =>
  [...document.querySelectorAll(`[${marker}]`)].map((x) => x.textContent?.trim())
const puts = (calls: Array<{ method: string; path: string; body?: unknown }>) =>
  calls.filter((c) => c.method === 'PUT' && c.path === 'connections/c1/personal-fields')

describe('PersonalDataCard (phase 3b §2.1; user request 2026-10-24)', () => {
  it('lists the rules by database, collection and field', async () => {
    team()
    server([...RULES, { db: '*', coll: '*', field: 'ssn' }])
    await mountCard()
    expect(cells('data-rule-db-cell')).toEqual(['crm', '*'])
    expect(cells('data-rule-coll-cell')).toEqual(['users', '*'])
    expect(cells('data-rule-row')).toEqual(['email', 'ssn'])
  })

  it('takes a rule picked, never typed: a database, a collection of it, a field of its documents', async () => {
    team()
    const { calls, stored } = server()
    await mountCard()
    // Nothing to type a name into, and no Save to forget.
    expect(document.querySelectorAll('[data-personal-data] input')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Save')
    // The collection and field come once what holds them is chosen.
    expect(document.querySelector('[data-rule-coll]')).toBeNull()
    expect(document.querySelector('[data-rule-field]')).toBeNull()
    await openPicker('data-rule-db')
    expect(offered()).toEqual(['crm', 'shop'])
    await pick('data-rule-db', 'crm')
    await openPicker('data-rule-coll')
    // A view holds no data of its own: its source's rules reach it.
    expect(offered()).toEqual(['users'])
    await pick('data-rule-coll', 'users')
    await openPicker('data-rule-field')
    // The fields of a sample of its documents, as a rule names them: arrays are transparent, a field
    // already listed is not offered again, a key with a dot cannot be named.
    expect(offered()).toEqual(['phone', 'address', 'address.city', 'cards', 'cards.number'])
    await pick('data-rule-field', 'address.city')
    // Saved at once, made on the rules as they were read.
    expect(puts(calls)).toHaveLength(1)
    expect(puts(calls)[0]!.body).toEqual({
      rules: [...RULES, { db: 'crm', coll: 'users', field: 'address.city' }],
      base: RULES,
    })
    expect(stored()).toHaveLength(2)
    expect(cells('data-rule-row')).toEqual(['email', 'address.city'])
    expect(document.querySelector('[data-rules-status]')!.textContent).toContain('Saved')
  })

  it('asks for a collection again when another database is picked', async () => {
    team()
    server()
    await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    expect(document.querySelector('[data-rule-field]')).not.toBeNull()
    await pick('data-rule-db', 'shop')
    expect(document.querySelector('[data-rule-field]')).toBeNull()
    await openPicker('data-rule-coll')
    expect(offered()).toEqual(['orders'])
  })

  it('says so when the fields of a collection cannot be read', async () => {
    team()
    server(RULES, {
      'POST connections/c1/databases/crm/collections/users/schema': () => [
        403,
        { code: 'FORBIDDEN', message: 'no' },
      ],
    })
    await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await openPicker('data-rule-field')
    expect(offered()).toEqual([])
    expect(pickerEmpty()).toBe('The fields of this collection could not be read.')
  })

  it('removes a rule at once', async () => {
    team()
    const { calls } = server([...RULES, { db: 'crm', coll: 'users', field: 'phone' }])
    await mountCard()
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove crm.users.email"]')!.click()
    await flushPromises()
    expect(puts(calls)[0]!.body).toEqual({
      rules: [{ db: 'crm', coll: 'users', field: 'phone' }],
      base: [...RULES, { db: 'crm', coll: 'users', field: 'phone' }],
    })
    expect(cells('data-rule-row')).toEqual(['phone'])
  })

  it('makes its change on the rules as they are when they changed meanwhile, losing none', async () => {
    team()
    const { calls, stored, change } = server()
    await mountCard()
    // Another admin adds a rule after this card read them.
    change([...RULES, { db: 'shop', coll: 'orders', field: 'iban' }])
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    expect(puts(calls)).toHaveLength(2)
    expect(stored()).toEqual([
      ...RULES,
      { db: 'shop', coll: 'orders', field: 'iban' },
      { db: 'crm', coll: 'users', field: 'phone' },
    ])
    expect(cells('data-rule-row')).toEqual(['email', 'iban', 'phone'])
  })

  it('shows the rules as stored again, and says why, when a change is not saved', async () => {
    team()
    server(RULES, {
      'PUT connections/c1/personal-fields': () => [500, { code: 'INTERNAL', message: 'down' }],
    })
    await mountCard()
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove crm.users.email"]')!.click()
    await flushPromises()
    expect(cells('data-rule-row')).toEqual(['email'])
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Something went wrong'),
    })
  })

  // Spec 3c §11 risk 13 (W5).
  it('says what a rule costs: guarded queries may not use an index (spec 3c §11 risk 13)', async () => {
    team()
    server([])
    const { wrapper } = await mountCard()
    const note = wrapper.find('[data-rule-cost]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('index')
  })

  // Review of the Monitoring redesign (I-3), abuse case: when the stored rules cannot be read, the
  // card must not offer anything to change — a save would replace every stored rule.
  it('offers nothing to change and saves nothing while the stored rules are not read', async () => {
    team()
    let fail = true
    const { calls } = server(RULES, {
      'GET connections/c1/personal-fields': () =>
        fail ? [500, { code: 'INTERNAL', message: 'down' }] : [200, { rules: RULES }],
    })
    const { wrapper } = await mountCard()
    expect(wrapper.text()).not.toContain('No personal field is listed yet.')
    expect(wrapper.find('[role="alert"]').text()).toContain('Something went wrong')
    expect(document.querySelector('[data-rule-pickers]')).toBeNull()
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    fail = false
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Retry')!
      .trigger('click')
    await flushPromises()
    expect(cells('data-rule-row')).toEqual(['email'])
    expect(document.querySelector('[data-rule-pickers]')).not.toBeNull()
  })

  // User request 2026-10-24: one person in local mode — the rules hide the values from them; no switch.
  it('has no "hide from me" switch in local mode, and says the values are hidden from you', async () => {
    localMode()
    server()
    const { wrapper } = await mountCard()
    expect(wrapper.find('[data-hide-from-me]').exists()).toBe(false)
    expect(wrapper.text()).toContain('In local mode their values are hidden from you')
  })

  it('lets an administrator of a team hide the values from themselves too', async () => {
    team()
    let hidden = false
    const { calls } = server(RULES, {
      'GET connections/c1/personal-fields': () => [200, { rules: RULES, hiddenFromMe: hidden }],
      'PUT connections/c1/personal-fields/self': (body) => {
        hidden = (body as { hidden: boolean }).hidden
        return [200, { hidden }]
      },
    })
    const { wrapper } = await mountCard()
    const toggle = () => wrapper.find<HTMLInputElement>('[data-hide-from-me] input[role="switch"]')
    expect(wrapper.find('[data-hide-from-me]').text()).toContain('Hide them from me too')
    expect(toggle().element.checked).toBe(false)
    await toggle().setValue(true)
    // It stays where it was put while saving (review 2026-10-13, minor 9: it snapped back).
    await nextTick()
    expect(toggle().element.checked).toBe(true)
    await flushPromises()
    expect(calls.find((c) => c.path === 'connections/c1/personal-fields/self')).toMatchObject({
      method: 'PUT',
      body: { hidden: true },
    })
    // What is shown follows: the connection's lists and data are read again — not the rules, this
    // card's to set (third review, M3).
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBeGreaterThan(1),
    )
    expect(
      calls.filter((c) => c.method === 'GET' && c.path === 'connections/c1/personal-fields').length,
    ).toBe(1)
    expect(toggle().element.checked).toBe(true)
  })

  // Review 2026-10-13 (minor 4): with no rules there is nothing to hide.
  it('has no such switch where no rule is saved yet', async () => {
    team()
    server([], { 'GET connections/c1/personal-fields': () => [200, { rules: [], hiddenFromMe: false }] })
    const { wrapper } = await mountCard()
    expect(wrapper.find('[data-hide-from-me]').exists()).toBe(false)
  })
})

describe('PersonalDataCard, reviewed (2026-10-24)', () => {
  /** A server whose PUTs are held until let go: what is sent while one runs. */
  function held() {
    const waiting: Array<() => void> = []
    let stored = RULES
    mockApi({
      'GET connections/c1/personal-fields': () => [200, { rules: stored }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => {
            const { rules, base } = body as { rules: typeof stored; base?: typeof stored }
            if (base && JSON.stringify(base) !== JSON.stringify(stored))
              return resolve([409, { code: 'CONFLICT', message: 'changed' }])
            stored = rules
            resolve([200, { rules }])
          }),
        ),
      'GET connections/c1/databases': () => [
        200,
        { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
      ],
      'GET connections/c1/databases/crm/collections': () => [
        200,
        [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
      ],
      'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
    })
    return {
      release: async () => {
        waiting.shift()?.()
        await flushPromises()
      },
      stored: () => stored,
      waiting: () => waiting.length,
    }
  }

  it('saves picks made while one is saved, each in turn and none lost', async () => {
    team()
    const put = held()
    await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await pick('data-rule-field', 'address')
    // One at a time: the second waits for the first.
    expect(put.waiting()).toBe(1)
    expect(cells('data-rule-row')).toEqual(['email', 'phone', 'address'])
    await put.release()
    expect(put.waiting()).toBe(1)
    await put.release()
    expect(put.stored()).toEqual([
      ...RULES,
      { db: 'crm', coll: 'users', field: 'phone' },
      { db: 'crm', coll: 'users', field: 'address' },
    ])
  })

  // Review I2: a change made while a failed save read the rules again was queued and never sent.
  it('saves a change made while a failed one is read again', async () => {
    team()
    let answer: ((v: [number, unknown]) => void) | null = null
    let reads = 0
    let stored = RULES
    mockApi({
      'GET connections/c1/personal-fields': () => {
        reads++
        // The read after the failure is held: a pick is made meanwhile.
        if (reads === 2) return new Promise((resolve) => (answer = resolve))
        return [200, { rules: stored }]
      },
      'PUT connections/c1/personal-fields': (body) => {
        const { rules } = body as { rules: typeof stored }
        if (rules.some((r) => r.field === 'phone')) return [500, { code: 'INTERNAL', message: 'down' }]
        stored = rules
        return [200, { rules }]
      },
      'GET connections/c1/databases': () => [
        200,
        { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
      ],
      'GET connections/c1/databases/crm/collections': () => [
        200,
        [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
      ],
      'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
    })
    await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    expect(answer).not.toBeNull()
    await pick('data-rule-field', 'address')
    answer!([200, { rules: stored }])
    await flushPromises()
    await flushPromises()
    expect(stored).toEqual([...RULES, { db: 'crm', coll: 'users', field: 'address' }])
    expect(cells('data-rule-row')).toEqual(['email', 'address'])
  })

  it('gives up after three refusals in a row, and says so', async () => {
    team()
    const { calls } = server(RULES, {
      'PUT connections/c1/personal-fields': () => [409, { code: 'CONFLICT', message: 'changed' }],
    })
    await mountCard()
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove crm.users.email"]')!.click()
    await flushPromises()
    expect(puts(calls)).toHaveLength(3)
    expect(cells('data-rule-row')).toEqual(['email'])
    expect(useToastStore().toasts.at(-1)?.kind).toBe('error')
  })

  // Minor 5: a name `*` would make a rule over every collection (or database); a key `*` or `**` one
  // over every field; MongoDB's own collections hold no one's data.
  it("offers no name a rule would read as a wildcard, nor MongoDB's own collections, nor keys with $", async () => {
    team()
    server(RULES, {
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'crm', sizeOnDisk: 1, empty: false },
            { name: '*', sizeOnDisk: 1, empty: false },
          ],
          totalSize: 2,
        },
      ],
      'GET connections/c1/databases/crm/collections': () => [
        200,
        [
          { name: 'users', type: 'collection', options: {}, readOnly: false },
          { name: '*', type: 'collection', options: {}, readOnly: false },
          { name: 'system.profile', type: 'collection', options: {}, readOnly: true },
        ],
      ],
      'POST connections/c1/databases/crm/collections/users/schema': () => [
        200,
        {
          sampled: 1,
          truncated: false,
          fields: [
            { path: 'name', keys: ['name'], count: 1, types: { string: 1 } },
            { path: '*', keys: ['*'], count: 1, types: { string: 1 } },
            { path: 'a.**', keys: ['a', '**'], count: 1, types: { string: 1 } },
            // Inside a path a key `*` or `**` would read as a wildcard: `*.email` names every email one level down.
            { path: '*.email', keys: ['*', 'email'], count: 1, types: { string: 1 } },
            { path: '**.phone', keys: ['**', 'phone'], count: 1, types: { string: 1 } },
            { path: '$x', keys: ['$x'], count: 1, types: { string: 1 } },
          ],
        },
      ],
    })
    await mountCard()
    await openPicker('data-rule-db')
    expect(offered()).toEqual(['crm'])
    await pick('data-rule-db', 'crm')
    await openPicker('data-rule-coll')
    expect(offered()).toEqual(['users'])
    await pick('data-rule-coll', 'users')
    await openPicker('data-rule-field')
    expect(offered()).toEqual(['name'])
  })

  // Minor 7: a failed read of the fields could not be tried again but by picking another collection.
  it('reads the fields again when their picker is opened after a failure', async () => {
    team()
    let fail = true
    server(RULES, {
      'POST connections/c1/databases/crm/collections/users/schema': () =>
        fail ? [500, { code: 'INTERNAL', message: 'down' }] : [200, SCHEMA],
    })
    await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await openPicker('data-rule-field')
    expect(pickerEmpty()).toBe('The fields of this collection could not be read.')
    document.querySelector<HTMLButtonElement>('[data-rule-field] button')!.click()
    await flushPromises()
    fail = false
    await openPicker('data-rule-field')
    expect(offered()).toContain('phone')
  })

  // Minor 6: a refused switch stayed where it was put, saying the values were hidden while shown.
  it('puts the switch back when hiding from me is refused', async () => {
    team()
    server(RULES, {
      'GET connections/c1/personal-fields': () => [200, { rules: RULES, hiddenFromMe: false }],
      'PUT connections/c1/personal-fields/self': () => [500, { code: 'INTERNAL', message: 'down' }],
    })
    const { wrapper } = await mountCard()
    const toggle = () => wrapper.find<HTMLInputElement>('[data-hide-from-me] input[role="switch"]')
    await toggle().setValue(true)
    await flushPromises()
    expect(toggle().element.checked).toBe(false)
    expect(useToastStore().toasts.at(-1)?.kind).toBe('error')
  })

  it('reads what is shown again after a save while the values are hidden from me, keeping the switch', async () => {
    team()
    const { calls } = server(RULES, {
      'GET connections/c1/personal-fields': () => [200, { rules: RULES, hiddenFromMe: true }],
    })
    const { wrapper } = await mountCard()
    const reads = calls.filter((c) => c.path === 'connections/c1/databases').length
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await flushPromises()
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBeGreaterThan(reads)
    expect(wrapper.find<HTMLInputElement>('[data-hide-from-me] input[role="switch"]').element.checked).toBe(
      true,
    )
  })

  // 2026-10-26: a request on its way (a validation rules save) learns the rules changed.
  it('counts each change of what is hidden from me', async () => {
    team()
    server(RULES, {
      'GET connections/c1/personal-fields': () => [200, { rules: RULES, hiddenFromMe: true }],
    })
    await mountCard()
    const before = rulesEpoch()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await flushPromises()
    expect(rulesEpoch()).toBeGreaterThan(before)
  })
})

describe('PersonalDataCard, second review (2026-10-24)', () => {
  const unloadHeld = () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }
  const crmUsers = {
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
  } as Record<string, Handler>

  // Minor 1: changes waiting their turn were lost when the page was left, the rule meant to hide data
  // never saved.
  it('holds the page while changes are saved, and saves them after its card is gone', async () => {
    team()
    const waiting: Array<() => void> = []
    let stored = RULES
    mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: stored }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => {
            stored = (body as { rules: typeof stored }).rules
            resolve([200, { rules: stored }])
          }),
        ),
    })
    const { wrapper } = await mountCard()
    expect(unloadHeld()).toBe(false)
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await pick('data-rule-field', 'address')
    expect(unloadHeld()).toBe(true)
    // The tab closed meanwhile: what was asked is saved all the same.
    wrapper.unmount()
    waiting.shift()!()
    await flushPromises()
    waiting.shift()!()
    await flushPromises()
    expect(stored).toEqual([
      ...RULES,
      { db: 'crm', coll: 'users', field: 'phone' },
      { db: 'crm', coll: 'users', field: 'address' },
    ])
    expect(unloadHeld()).toBe(false)
  })

  // Minor 2: a view whose read failed kept what it showed before the values were hidden.
  it('drops what a view could not read again once a rule hides values from me', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    queryClient.setQueryData(['connections', 'c1', 'probe'], 'shown before')
    const probe = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c1', 'probe'],
      queryFn: () => Promise.reject(new Error('gone')),
      retry: false,
      staleTime: Infinity,
    })
    const stop = probe.subscribe(() => {})
    // A view read slowly: while it is, what no one watches is gone already (a view opened meanwhile
    // would show it).
    let slowDone: (v: string) => void = () => {}
    queryClient.setQueryData(['connections', 'c1', 'slow'], 'slow before')
    const slow = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c1', 'slow'],
      queryFn: () => new Promise<string>((resolve) => (slowDone = resolve)),
      staleTime: Infinity,
    })
    const stopSlow = slow.subscribe(() => {})
    queryClient.setQueryData(['connections', 'c1', 'aside'], 'kept aside')
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c1', 'aside'])).toBeUndefined()
    slowDone('slow after')
    await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c1', 'probe'])).toBeUndefined()
    expect(queryClient.getQueryData(['connections', 'c1', 'slow'])).toBe('slow after')
    stop()
    stopSlow()
  })

  // Minor 3: a rule saved while "hide from me" was being turned on refreshed nothing.
  it('reads what is shown again after a save made while the values are being hidden from me', async () => {
    team()
    let answer: ((v: [number, unknown]) => void) | null = null
    const { calls } = server(RULES, {
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: RULES, hiddenFromMe: false }],
      'PUT connections/c1/personal-fields/self': () => new Promise((resolve) => (answer = resolve)),
    })
    const { wrapper } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await wrapper.find<HTMLInputElement>('[data-hide-from-me] input[role="switch"]').setValue(true)
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    // Saved before the switch is: the switch, once saved, reads every view again (third review, N1).
    const reads = calls.filter((c) => c.path === 'connections/c1/databases').length
    answer!([200, { hidden: true }])
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBeGreaterThan(reads)
  })

  // Nit 5: saved, then its rules not read again: the switch went back to what it was.
  it('keeps the switch where it was saved though the rules are not read again', async () => {
    team()
    let reads = 0
    server(RULES, {
      'GET connections/c1/personal-fields': () =>
        ++reads === 1
          ? [200, { rules: RULES, hiddenFromMe: false }]
          : [500, { code: 'INTERNAL', message: 'down' }],
      'PUT connections/c1/personal-fields/self': () => [200, { hidden: true }],
    })
    const { wrapper } = await mountCard()
    const toggle = () => wrapper.find<HTMLInputElement>('[data-hide-from-me] input[role="switch"]')
    await toggle().setValue(true)
    // Every view read again, not the rules: the switch stays where it was saved.
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(reads).toBe(1)
    expect(toggle().element.checked).toBe(true)
    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(1)
  })

  // Nit 9: the first open said "no other field" before the read had begun.
  it('says the fields are being read, from the moment the picker opens', async () => {
    team()
    server(RULES, {
      'POST connections/c1/databases/crm/collections/users/schema': () => new Promise(() => {}),
    })
    await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await openPicker('data-rule-field')
    expect(pickerEmpty()).toBe('Reading the fields of its documents…')
  })
})

describe('PersonalDataCard, third review (2026-10-24)', () => {
  const crmUsers = {
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
  } as Record<string, Handler>

  // M1: saved, then the rules could not be read: it said "not saved" and dropped what came after.
  it('never calls a saved change unsaved when the rules cannot be read after it', async () => {
    team()
    const waiting: Array<() => void> = []
    let stored = RULES
    let fail = false
    mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () =>
        fail ? [500, { code: 'INTERNAL', message: 'down' }] : [200, { rules: stored }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => {
            stored = (body as { rules: typeof stored }).rules
            resolve([200, { rules: stored }])
          }),
        ),
    })
    const { wrapper, queryClient } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await pick('data-rule-field', 'address')
    wrapper.unmount()
    // Another refresh dropped the rules no one watches now, and the server cannot read them for a while.
    queryClient.removeQueries({ queryKey: ['connections', 'c1', 'personal-fields'] })
    fail = true
    waiting.shift()!()
    await flushPromises()
    waiting.shift()?.()
    await flushPromises()
    expect(stored).toEqual([
      ...RULES,
      { db: 'crm', coll: 'users', field: 'phone' },
      { db: 'crm', coll: 'users', field: 'address' },
    ])
    expect(useToastStore().toasts.filter((x) => x.kind === 'error')).toEqual([])
  })

  // M2: a list of names read again in vain was reset: the connection read as gone, the card with it.
  it('keeps the lists of names a refresh could not read again', async () => {
    localMode()
    let reads = 0
    server(RULES, {
      ...crmUsers,
      'GET connections/c1/databases': () =>
        ++reads === 1
          ? [200, { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 }]
          : [500, { code: 'INTERNAL', message: 'down' }],
    })
    const { queryClient } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await vi.waitFor(() => expect(reads).toBe(2))
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c1', 'databases'])).toBeDefined()
    expect(document.querySelector('[data-rule-field]')).not.toBeNull()
  })

  // M3: a read of the rules begun before a save, answered after it, showed them as before the save.
  it('shows a rule saved though a read begun before it answers after', async () => {
    team()
    let stored = RULES
    let hold = false
    let answer: (() => void) | null = null
    server(RULES, {
      ...crmUsers,
      'GET connections/c1/personal-fields': () => {
        const then = stored
        if (!hold) return [200, { rules: then }]
        hold = false
        return new Promise((resolve) => (answer = () => resolve([200, { rules: then }])))
      },
      'PUT connections/c1/personal-fields': (body) => {
        stored = (body as { rules: typeof stored }).rules
        return [200, { rules: stored }]
      },
    })
    const { queryClient } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    // A read of the rules begins (the window took the focus again) and hangs.
    hold = true
    const stale = queryClient.refetchQueries({ queryKey: ['connections', 'c1', 'personal-fields'] })
    await flushPromises()
    await pick('data-rule-field', 'phone')
    answer!()
    await stale
    await flushPromises()
    expect(cells('data-rule-row')).toEqual(['email', 'phone'])
  })

  // M4: a view read again in the same millisecond as before looked not read again, and was reset.
  it('keeps a view read again within the same millisecond', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 24, 12, 0, 0))
    try {
      let quickReads = 0
      queryClient.setQueryData(['connections', 'c1', 'quick'], 'quick before')
      const quick = new QueryObserver(queryClient, {
        queryKey: ['connections', 'c1', 'quick'],
        // Read again once, at once; a reset would read it a second time, which never answers.
        queryFn: () => (++quickReads === 1 ? Promise.resolve('quick after') : new Promise<string>(() => {})),
        staleTime: Infinity,
      })
      const stop = quick.subscribe(() => {})
      await pick('data-rule-field', 'phone')
      for (let i = 0; i < 5; i++) await flushPromises()
      expect(queryClient.getQueryData(['connections', 'c1', 'quick'])).toBe('quick after')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // N1: the save after "hide from me" is saved refreshes the views, as the switch says they are hidden.
  it('reads what is shown again after a save made once the values are hidden from me', async () => {
    team()
    let releasePut: (() => void) | null = null
    let stored = RULES
    const { calls } = server(RULES, {
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: stored, hiddenFromMe: false }],
      'PUT connections/c1/personal-fields/self': () => [200, { hidden: true }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) => {
          releasePut = () => {
            stored = (body as { rules: typeof stored }).rules
            resolve([200, { rules: stored }])
          }
        }),
    })
    const { wrapper } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await wrapper.find<HTMLInputElement>('[data-hide-from-me] input[role="switch"]').setValue(true)
    for (let i = 0; i < 5; i++) await flushPromises()
    const reads = calls.filter((c) => c.path === 'connections/c1/databases').length
    releasePut!()
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(calls.filter((c) => c.path === 'connections/c1/databases').length).toBeGreaterThan(reads)
  })

  // N2: two cards of one connection saved at once, each on the other's rules, refused in turn.
  it('saves the changes of two cards of one connection in turn, neither refused', async () => {
    team()
    const waiting: Array<() => void> = []
    let stored = RULES
    let refused = 0
    mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: stored }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => {
            const { rules, base } = body as { rules: typeof stored; base?: typeof stored }
            if (base && JSON.stringify(base) !== JSON.stringify(stored)) {
              refused++
              return resolve([409, { code: 'CONFLICT', message: 'changed' }])
            }
            stored = rules
            resolve([200, { rules }])
          }),
        ),
    })
    // Two cards in one app, as two tabs of one connection are.
    mountApp({
      setup: () => () => [
        h(PersonalDataCard, { connection: { id: 'c1', name: 'M' } }),
        h(PersonalDataCard, { connection: { id: 'c1', name: 'M' } }),
      ],
    })
    await flushPromises()
    const [first, second] = [...document.querySelectorAll('[data-personal-data]')]
    for (const [card, field] of [
      [first!, 'phone'],
      [second!, 'address'],
    ] as const) {
      const within = async (marker: string, name: string) => {
        card.querySelector<HTMLButtonElement>(`[${marker}] button`)!.click()
        await flushPromises()
        ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((o) => o.querySelector('span')?.textContent?.trim() === name)!
          .click()
        await flushPromises()
      }
      await within('data-rule-db', 'crm')
      await within('data-rule-coll', 'users')
      await within('data-rule-field', field)
    }
    // One at a time across both cards.
    expect(waiting).toHaveLength(1)
    waiting.shift()!()
    await flushPromises()
    expect(waiting).toHaveLength(1)
    waiting.shift()!()
    await flushPromises()
    expect(refused).toBe(0)
    expect(stored).toEqual([
      ...RULES,
      { db: 'crm', coll: 'users', field: 'phone' },
      { db: 'crm', coll: 'users', field: 'address' },
    ])
  })
})

describe('PersonalDataCard, fourth review (2026-10-24)', () => {
  const crmUsers = {
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
  } as Record<string, Handler>
  const within = async (card: Element, marker: string, name: string) => {
    card.querySelector<HTMLButtonElement>(`[${marker}] button`)!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((o) => o.querySelector('span')?.textContent?.trim() === name)!
      .click()
    await flushPromises()
  }

  // m1: the lists of databases and collections carry sizes and options the rules hide: kept, they
  // showed them once the values were hidden from me.
  it('keeps the lists of names, but none of the sizes or options they carried', async () => {
    localMode()
    let reads = 0
    server(RULES, {
      ...crmUsers,
      'GET connections/c1/databases': () =>
        ++reads === 1
          ? [200, { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 }]
          : [500, { code: 'INTERNAL', message: 'down' }],
    })
    const { queryClient } = await mountCard()
    queryClient.setQueryData(['connections', 'c2', 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
      totalSize: 7,
    })
    queryClient.setQueryData(
      ['connections', 'c2', 'databases', 'shop', 'collections'],
      [
        {
          name: 'recent',
          type: 'view',
          options: { viewOn: 'orders', pipeline: [{ $match: { email: 'a@x' } }] },
        },
        { name: 'orders', type: 'collection', options: { validator: { email: { $ne: 'b@x' } } } },
      ],
    )
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await vi.waitFor(() => expect(reads).toBe(2))
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c1', 'databases'])).toEqual({
      databases: [{ name: 'crm', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
    expect(queryClient.getQueryData(['connections', 'c2', 'databases', 'shop', 'collections'])).toEqual([
      { name: 'recent', type: 'view', options: { viewOn: 'orders' } },
      { name: 'orders', type: 'collection', options: {} },
    ])
  })

  // n1: the lane was the whole page's: an app's save held another's (two apps in tests, one in use).
  it('saves in one app though a save of another app waits', async () => {
    team()
    const waiting: Array<() => void> = []
    let stored = RULES
    const { calls } = mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: stored }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => {
            stored = (body as { rules: typeof stored }).rules
            resolve([200, { rules: stored }])
          }),
        ),
    })
    const apps = [await mountCard(), await mountCard()]
    const [first, second] = [...document.querySelectorAll('[data-personal-data]')]
    for (const card of [first!, second!]) {
      await within(card, 'data-rule-db', 'crm')
      await within(card, 'data-rule-coll', 'users')
    }
    await within(first!, 'data-rule-field', 'phone')
    await within(second!, 'data-rule-field', 'address')
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
    for (const go of waiting.splice(0)) go()
    await flushPromises()
    for (const app of apps) app.wrapper.unmount()
  })

  // n2: a change is saved to the connection it was made on, whatever the card shows when its turn comes.
  it('saves a change to the connection it was made on', async () => {
    team()
    const waiting: Array<() => void> = []
    const { calls } = mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: RULES }],
      'GET connections/c2/personal-fields': () => [200, { rules: [] }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => resolve([200, { rules: (body as { rules: unknown }).rules }])),
        ),
      'PUT connections/c2/personal-fields': (body) => [200, { rules: (body as { rules: unknown }).rules }],
    })
    const { wrapper } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await pick('data-rule-field', 'address')
    await wrapper.setProps({ connection: { id: 'c2', name: 'N' } })
    waiting.shift()!()
    await flushPromises()
    waiting.shift()!()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([
      'connections/c1/personal-fields',
      'connections/c1/personal-fields',
    ])
  })

  // n3: the rules dropped and not read again after a save: whether they hide values from me was lost,
  // and nothing shown followed.
  it('refreshes what is shown when it cannot tell the values are not hidden from me', async () => {
    team()
    const waiting: Array<() => void> = []
    let fail = false
    mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () =>
        fail ? [500, { code: 'INTERNAL', message: 'down' }] : [200, { rules: RULES, hiddenFromMe: true }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => resolve([200, { rules: (body as { rules: unknown }).rules }])),
        ),
    })
    const { wrapper, queryClient } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    wrapper.unmount()
    queryClient.removeQueries({ queryKey: ['connections', 'c1', 'personal-fields'] })
    queryClient.setQueryData(['connections', 'c1', 'aside'], 'kept aside')
    fail = true
    waiting.shift()!()
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c1', 'aside'])).toBeUndefined()
  })
})

describe('PersonalDataCard, review of the scrub (2026-10-24)', () => {
  const crmUsers = {
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
  } as Record<string, Handler>
  const TIMEOUT: [number, unknown] = [
    502,
    { code: 'MONGO_ERROR', message: 'Server selection timed out', details: { kind: 'timeout' } },
  ]

  // I1: a scrub written as data set by hand turned a failed read into a success: a server that cannot
  // be reached read as connected, its error and Retry gone.
  it('scrubs a list whose read failed without calling it read', async () => {
    localMode()
    let reads = 0
    server(RULES, {
      ...crmUsers,
      'GET connections/c1/databases': () =>
        ++reads === 1
          ? [200, { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 }]
          : TIMEOUT,
    })
    const { queryClient } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await vi.waitFor(() => expect(reads).toBe(2))
    for (let i = 0; i < 5; i++) await flushPromises()
    const state = queryClient.getQueryState(['connections', 'c1', 'databases'])!
    expect(state.status).toBe('error')
    expect(state.data).toEqual({
      databases: [{ name: 'crm', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
  })

  // m1: a collection's collation, pre-images, capped size or time series hold no one's data.
  it('keeps the options of a collection that hold no values', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    queryClient.setQueryData(
      ['connections', 'c2', 'databases', 'shop', 'collections'],
      [
        {
          name: 'orders',
          type: 'collection',
          options: {
            collation: { locale: 'tr' },
            changeStreamPreAndPostImages: { enabled: true },
            capped: true,
            size: 1024,
            max: 10,
            validator: { email: { $ne: 'b@x' } },
            validationLevel: 'strict',
          },
        },
        {
          name: 'ticks',
          type: 'timeseries',
          options: { timeseries: { timeField: 't' }, expireAfterSeconds: 60 },
        },
      ],
    )
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases', 'shop', 'collections'])).toEqual([
      {
        name: 'orders',
        type: 'collection',
        options: {
          collation: { locale: 'tr' },
          changeStreamPreAndPostImages: { enabled: true },
          capped: true,
          size: 1024,
          max: 10,
        },
      },
      {
        name: 'ticks',
        type: 'timeseries',
        options: { timeseries: { timeField: 't' }, expireAfterSeconds: 60 },
      },
    ])
  })

  // m2: a read of a list no one watches, begun before the values were hidden, wrote them back after;
  // it lands now, and the list is scrubbed then (sixth review).
  it('scrubs a list no one watches after a read begun before lands', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let answer: (v: unknown) => void = () => {}
    const reading = queryClient
      .fetchQuery({
        queryKey: ['connections', 'c2', 'databases'],
        queryFn: () => new Promise((resolve) => (answer = resolve)),
      })
      .catch(() => undefined)
    queryClient.setQueryData(['connections', 'c2', 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
      totalSize: 7,
    })
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    answer({ databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }], totalSize: 7 })
    await reading
    await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
    // No one watches it: not read again until shown.
    expect(queryClient.getQueryState(['connections', 'c2', 'databases'])!.fetchStatus).toBe('idle')
  })

  // Nit: a card shown for another connection showed the first one's changes waiting as its own.
  it('shows only the changes made on the connection it shows', async () => {
    team()
    const waiting: Array<() => void> = []
    mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: RULES }],
      'GET connections/c2/personal-fields': () => [200, { rules: [] }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise((resolve) =>
          waiting.push(() => resolve([200, { rules: (body as { rules: unknown }).rules }])),
        ),
    })
    const { wrapper } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await wrapper.setProps({ connection: { id: 'c2', name: 'N' } })
    await flushPromises()
    expect(cells('data-rule-row')).toEqual([])
    waiting.shift()!()
    await flushPromises()
  })
})

describe('PersonalDataCard, last review (2026-10-24)', () => {
  const crmUsers = {
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
  } as Record<string, Handler>
  const OTHER = [{ db: 'crm', coll: 'users', field: 'iban' }]

  /** A change on c1 held then refused; the card then shows c2, whose rule is removed. */
  async function twoConnections() {
    team()
    let refuse: (() => void) | null = null
    const { calls } = mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: RULES }],
      'GET connections/c2/personal-fields': () => [200, { rules: OTHER }],
      'GET connections/c2/databases': () => [200, { databases: [], totalSize: 0 }],
      'PUT connections/c1/personal-fields': () =>
        new Promise((resolve) => (refuse = () => resolve([500, { code: 'INTERNAL', message: 'down' }]))),
      'PUT connections/c2/personal-fields': (body) => [200, { rules: (body as { rules: unknown }).rules }],
    })
    const { wrapper } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    await wrapper.setProps({ connection: { id: 'c2', name: 'N' } })
    await flushPromises()
    return { calls, refuse: () => refuse!() }
  }

  // Minor 2: one connection's change refused dropped another's waiting behind it.
  it("keeps another connection's changes when one is refused", async () => {
    const { calls, refuse } = await twoConnections()
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove crm.users.iban"]')!.click()
    await flushPromises()
    refuse()
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([
      'connections/c1/personal-fields',
      'connections/c2/personal-fields',
    ])
    // The refused change's own connection is read again.
    expect(
      calls.filter((c) => c.path === 'connections/c1/personal-fields' && c.method === 'GET').length,
    ).toBe(2)
  })

  // Nit: the card for c2 said "Saving…" for c1's change.
  it("says nothing of another connection's save", async () => {
    const { refuse } = await twoConnections()
    expect(document.querySelector('[data-rules-status]')!.textContent).not.toContain('Saving')
    refuse()
    await flushPromises()
  })

  // Minor 3: a first read of a list no one watches was let go: one waiting for it (a command asking
  // whether the server is connected) was told it is not. It lands, and is scrubbed.
  it('lets a first read of a list no one watches land, and scrubs it', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let answer: (v: unknown) => void = () => {}
    const reading = queryClient.fetchQuery({
      queryKey: ['connections', 'c2', 'databases'],
      queryFn: () => new Promise((resolve) => (answer = resolve)),
    })
    queryClient.setQueryData(['connections', 'c2', 'aside'], 'kept aside')
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    // The refresh ran while the read was on its way.
    expect(queryClient.getQueryData(['connections', 'c2', 'aside'])).toBeUndefined()
    answer({ databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }], totalSize: 7 })
    await expect(reading).resolves.toBeDefined()
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
  })
})

describe('PersonalDataCard, sixth review (2026-10-24)', () => {
  const crmUsers = {
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'crm', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/crm/collections': () => [
      200,
      [{ name: 'users', type: 'collection', options: {}, readOnly: false }],
    ],
    'POST connections/c1/databases/crm/collections/users/schema': () => [200, SCHEMA],
  } as Record<string, Handler>

  // Minor 1: a read of a list no one watches, with data, was let go: one waiting for it (whether the
  // server is connected) was given what it held before. It lands, and the list is scrubbed then.
  it('lets a read of a list no one watches land, with data held before, and scrubs it', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    queryClient.setQueryData(['connections', 'c2', 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
      totalSize: 7,
    })
    let answer: (v: unknown) => void = () => {}
    const reading = queryClient.fetchQuery({
      queryKey: ['connections', 'c2', 'databases'],
      queryFn: () => new Promise((resolve) => (answer = resolve)),
      staleTime: 0,
    })
    queryClient.setQueryData(['connections', 'c2', 'aside'], 'kept aside')
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    // The refresh ran while the read was on its way, and scrubbed the list at once.
    expect(queryClient.getQueryData(['connections', 'c2', 'aside'])).toBeUndefined()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
    const now = {
      databases: [
        { name: 'shop', sizeOnDisk: 9, empty: false },
        { name: 'new', sizeOnDisk: 1, empty: false },
      ],
      totalSize: 10,
    }
    answer(now)
    await expect(reading).resolves.toEqual(now)
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [
        { name: 'shop', sizeOnDisk: null, empty: false },
        { name: 'new', sizeOnDisk: null, empty: false },
      ],
      totalSize: null,
    })
  })

  // Minor 2: a view's first read on its way when a rule hid values was joined, not made again: what it
  // brought from before was shown and kept.
  it('reads a view again whose first read was on its way when values were hidden', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let reads = 0
    let first: (v: string) => void = () => {}
    const view = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c1', 'databases', 'crm', 'collections', 'users', 'documents', 'page'],
      queryFn: () =>
        ++reads === 1 ? new Promise<string>((resolve) => (first = resolve)) : Promise.resolve('masked'),
    })
    const stop = view.subscribe(() => {})
    await flushPromises()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    first('from before')
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(reads).toBe(2)
    expect(
      queryClient.getQueryData([
        'connections',
        'c1',
        'databases',
        'crm',
        'collections',
        'users',
        'documents',
        'page',
      ]),
    ).toBe('masked')
    stop()
  })

  // Nit 6: what the status line says, on the connection saved and on another.
  it('says "Saving…" on the connection saved, and nothing of it on another', async () => {
    team()
    let release: (() => void) | null = null
    mockApi({
      ...crmUsers,
      'GET connections/c1/personal-fields': () => [200, { rules: RULES }],
      'GET connections/c2/personal-fields': () => [200, { rules: [] }],
      'PUT connections/c1/personal-fields': (body) =>
        new Promise(
          (resolve) => (release = () => resolve([200, { rules: (body as { rules: unknown }).rules }])),
        ),
    })
    const { wrapper } = await mountCard()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    const status = () => document.querySelector('[data-rules-status]')!.textContent?.trim()
    expect(status()).toBe('Saving…')
    await wrapper.setProps({ connection: { id: 'c2', name: 'N' } })
    await flushPromises()
    expect(status()).toBe('A field you pick is saved at once; so is a rule you remove.')
    release!()
    await flushPromises()
  })
})

describe('PersonalDataCard, seventh review (2026-10-24)', () => {
  // Minor: a read let go with its state put back brought back the list as it was before the scrub.
  it('scrubs a list again when a read on its way is let go', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    queryClient.setQueryData(['connections', 'c2', 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
      totalSize: 7,
    })
    const reading = queryClient
      .fetchQuery({
        queryKey: ['connections', 'c2', 'databases'],
        queryFn: () => new Promise(() => {}),
        staleTime: 0,
      })
      .catch(() => undefined)
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    await queryClient.cancelQueries({ queryKey: ['connections', 'c2', 'databases'] }, { revert: true })
    await reading
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
  })

  // Nit 5: a watched list's first read on its way is scrubbed when it lands.
  it('scrubs a watched list whose first read was on its way', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let first: (v: unknown) => void = () => {}
    const list = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c2', 'databases'],
      queryFn: () => new Promise((resolve) => (first = resolve)),
    })
    const stop = list.subscribe(() => {})
    await flushPromises()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    first({ databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }], totalSize: 7 })
    for (let i = 0; i < 5; i++) await flushPromises()
    expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
      databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
      totalSize: null,
    })
    stop()
  })

  // Nit 2: refreshes in a row while one first read is on its way read it anew once, not once each.
  it('reads a view anew once, however many refreshes met its first read', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let reads = 0
    let first: (v: string) => void = () => {}
    const key = ['connections', 'c1', 'databases', 'crm', 'collections', 'users', 'documents', 'page']
    const view = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () =>
        ++reads === 1 ? new Promise<string>((resolve) => (first = resolve)) : Promise.resolve('masked'),
    })
    const stop = view.subscribe(() => {})
    await flushPromises()
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    for (const field of ['phone', 'address', 'cards']) {
      await pick('data-rule-field', field)
      for (let i = 0; i < 5; i++) await flushPromises()
    }
    first('from before')
    for (let i = 0; i < 10; i++) await flushPromises()
    expect(reads).toBe(2)
    expect(queryClient.getQueryData(key)).toBe('masked')
    stop()
  })
})

describe('PersonalDataCard, eighth review (2026-10-24)', () => {
  // Nit: a watched list whose read again waits (offline) is scrubbed; that read, let go with its
  // state put back, brought the sizes back.
  it('scrubs a watched list again when its read again, waiting, is let go', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    queryClient.setQueryData(['connections', 'c2', 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
      totalSize: 7,
    })
    const list = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c2', 'databases'],
      queryFn: () => new Promise(() => {}),
      staleTime: Infinity,
    })
    const stop = list.subscribe(() => {})
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    // Its fields read while online.
    await openPicker('data-rule-field')
    onlineManager.setOnline(false)
    try {
      await pick('data-rule-field', 'phone')
      for (let i = 0; i < 5; i++) await flushPromises()
      expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
        databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
        totalSize: null,
      })
      await queryClient.cancelQueries({ queryKey: ['connections', 'c2', 'databases'] }, { revert: true })
      for (let i = 0; i < 5; i++) await flushPromises()
      expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
        databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
        totalSize: null,
      })
    } finally {
      stop()
      onlineManager.setOnline(true)
    }
  })

  // Review of 525b4f27: a read again begun after the rules lands with what the server says may be
  // shown; scrubbed on landing, sizes not hidden read as hidden.
  it("keeps what a watched list's read again, made after the rules, brings", async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    queryClient.setQueryData(['connections', 'c2', 'databases'], {
      databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
      totalSize: 7,
    })
    const now = { databases: [{ name: 'shop', sizeOnDisk: 9, empty: false }], totalSize: 9 }
    const list = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c2', 'databases'],
      queryFn: () => Promise.resolve(now),
      staleTime: Infinity,
    })
    const stop = list.subscribe(() => {})
    try {
      await pick('data-rule-db', 'crm')
      await pick('data-rule-coll', 'users')
      await openPicker('data-rule-field')
      onlineManager.setOnline(false)
      try {
        await pick('data-rule-field', 'phone')
        for (let i = 0; i < 5; i++) await flushPromises()
        // The read again waits: the list is scrubbed meanwhile.
        expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
          databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
          totalSize: null,
        })
      } finally {
        onlineManager.setOnline(true)
      }
      for (let i = 0; i < 5; i++) await flushPromises()
      expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual(now)
    } finally {
      stop()
    }
  })

  // Review of ee53447f: a list whose watchers are paused (a tree node closed) is not read again; the
  // read on its way was begun before the rules, and brought back what they hide when it landed.
  it('scrubs a list with paused watchers when a read begun before lands', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    const key = ['connections', 'c2', 'databases', 'shop', 'collections']
    queryClient.setQueryData(key, [{ name: 'orders', type: 'collection', options: {} }])
    const list = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => new Promise(() => {}),
      enabled: false,
    })
    const stop = list.subscribe(() => {})
    let first: (v: unknown) => void = () => {}
    const reading = queryClient
      .fetchQuery({ queryKey: key, queryFn: () => new Promise((resolve) => (first = resolve)), staleTime: 0 })
      .catch(() => undefined)
    try {
      await pick('data-rule-db', 'crm')
      await pick('data-rule-coll', 'users')
      await pick('data-rule-field', 'phone')
      for (let i = 0; i < 5; i++) await flushPromises()
      first([{ name: 'orders', type: 'collection', options: { validator: { email: { $ne: 'b@x' } } } }])
      await reading
      for (let i = 0; i < 5; i++) await flushPromises()
      expect(queryClient.getQueryData(key)).toEqual([{ name: 'orders', type: 'collection', options: {} }])
      // Its watchers paused: not read again until shown.
      expect(queryClient.getQueryState(key)!.fetchStatus).toBe('idle')
    } finally {
      stop()
    }
  })
})

describe('PersonalDataCard, ninth review (2026-10-24)', () => {
  /**
   * A view another refresh waits for (read again, slowly), and a paused view whose read, begun before
   * the rules, lands while the refresh waits.
   */
  async function landsWhileWaiting(key: readonly unknown[], before: unknown, landing: unknown) {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let slowReads = 0
    let slowDone: () => void = () => {}
    const slow = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c1', 'slow'],
      queryFn: () =>
        ++slowReads === 1
          ? Promise.resolve('first')
          : new Promise<string>((resolve) => (slowDone = () => resolve('again'))),
      staleTime: Infinity,
    })
    const stopSlow = slow.subscribe(() => {})
    await flushPromises()
    queryClient.setQueryData(key, before)
    const paused = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => new Promise(() => {}),
      enabled: false,
    })
    const stopPaused = paused.subscribe(() => {})
    let first: (v: unknown) => void = () => {}
    const reading = queryClient
      .fetchQuery({ queryKey: key, queryFn: () => new Promise((resolve) => (first = resolve)), staleTime: 0 })
      .catch(() => undefined)
    await pick('data-rule-db', 'crm')
    await pick('data-rule-coll', 'users')
    await pick('data-rule-field', 'phone')
    for (let i = 0; i < 5; i++) await flushPromises()
    // The refresh waits for the slow view: the read begun before lands now.
    expect(slowReads).toBe(2)
    first(landing)
    await reading
    for (let i = 0; i < 5; i++) await flushPromises()
    slowDone()
    for (let i = 0; i < 5; i++) await flushPromises()
    return {
      queryClient,
      stop: () => {
        stopSlow()
        stopPaused()
      },
    }
  }

  it('scrubs a paused list whose read begun before lands while the refresh waits', async () => {
    const key = ['connections', 'c2', 'databases', 'shop', 'collections']
    const { queryClient, stop } = await landsWhileWaiting(
      key,
      [{ name: 'orders', type: 'collection', options: {} }],
      [{ name: 'orders', type: 'collection', options: { validator: { email: { $ne: 'b@x' } } } }],
    )
    try {
      expect(queryClient.getQueryData(key)).toEqual([{ name: 'orders', type: 'collection', options: {} }])
      // Read again when next shown (nit 2): what it holds is from before the rules — not now, its
      // watchers paused.
      expect(queryClient.getQueryState(key)!.isInvalidated).toBe(true)
      expect(queryClient.getQueryState(key)!.fetchStatus).toBe('idle')
    } finally {
      stop()
    }
  })

  it('scrubs a list no one watches at once, while the refresh waits for the views read again', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    let slowReads = 0
    let slowDone: () => void = () => {}
    const slow = new QueryObserver(queryClient, {
      queryKey: ['connections', 'c1', 'slow'],
      queryFn: () =>
        ++slowReads === 1
          ? Promise.resolve('first')
          : new Promise<string>((resolve) => (slowDone = () => resolve('again'))),
      staleTime: Infinity,
    })
    const stop = slow.subscribe(() => {})
    try {
      await flushPromises()
      queryClient.setQueryData(['connections', 'c2', 'databases'], {
        databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }],
        totalSize: 7,
      })
      await pick('data-rule-db', 'crm')
      await pick('data-rule-coll', 'users')
      await pick('data-rule-field', 'phone')
      for (let i = 0; i < 5; i++) await flushPromises()
      expect(slowReads).toBe(2)
      // The refresh still waits: a view opened now would show the list already without its sizes.
      expect(queryClient.getQueryData(['connections', 'c2', 'databases'])).toEqual({
        databases: [{ name: 'shop', sizeOnDisk: null, empty: false }],
        totalSize: null,
      })
      slowDone()
      await flushPromises()
    } finally {
      stop()
    }
  })

  // Review of 027748ea (minor 1): a watched list's first read, begun before the rules, is scrubbed
  // when it lands — every size, hidden or not — and read again at once, so it shows what may be shown.
  it('reads a watched list again at once after its first read, begun before, lands', async () => {
    localMode()
    server()
    const { queryClient } = await mountCard()
    const key = ['connections', 'c2', 'databases']
    let reads = 0
    let first: (v: unknown) => void = () => {}
    const after = { databases: [{ name: 'shop', sizeOnDisk: 9, empty: false }], totalSize: 9 }
    const list = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => (++reads === 1 ? new Promise((resolve) => (first = resolve)) : Promise.resolve(after)),
    })
    const stop = list.subscribe(() => {})
    try {
      await flushPromises()
      await pick('data-rule-db', 'crm')
      await pick('data-rule-coll', 'users')
      await pick('data-rule-field', 'phone')
      for (let i = 0; i < 5; i++) await flushPromises()
      first({ databases: [{ name: 'shop', sizeOnDisk: 7, empty: false }], totalSize: 7 })
      for (let i = 0; i < 8; i++) await flushPromises()
      expect(reads).toBe(2)
      expect(queryClient.getQueryData(key)).toEqual(after)
    } finally {
      stop()
    }
  })

  it('drops a paused view whose read begun before lands while the refresh waits', async () => {
    const key = ['connections', 'c2', 'databases', 'shop', 'collections', 'orders', 'documents', 'page']
    const { queryClient, stop } = await landsWhileWaiting(key, 'shown before', 'read before the rules')
    try {
      expect(queryClient.getQueryData(key)).toBeUndefined()
    } finally {
      stop()
    }
  })
})

describe('AccessCard restricted flag (phase 3b §2.2)', () => {
  const users = [
    { id: 'u1', username: 'bob', role: 'editor' },
    { id: 'u2', username: 'eve', role: 'editor' },
  ]

  it('offers "cannot see personal data", sends it, and keeps it apart from the shell', async () => {
    const { calls } = mockApi({
      'GET users': () => [200, users],
      'GET connections/c1/grants': () => [
        200,
        [
          { userId: 'u1', role: 'editor', shell: true, masked: false },
          { userId: 'u2', role: 'viewer', shell: false, masked: false },
        ],
      ],
      'PUT connections/c1/grants/u2': () => [204, undefined],
    })
    const { wrapper } = mountApp(AccessCard, { props: { connection: { id: 'c1', name: 'M' } } })
    await flushPromises()
    const [bob, eve] = wrapper.findAll('[data-grant-masked] input')
    // The shell is on for bob: the restriction must be lifted from the shell first.
    expect(bob!.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('cannot use the shell')
    await eve!.setValue(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ role: 'viewer', masked: true })
  })

  // Review of the Monitoring redesign (I-3), the same abuse case: with the grants unread, no select
  // offers "Inherit" as if it were the stored grant (a change would be made on a guess); Retry reads.
  it('offers no grant to change while the grants are not read', async () => {
    let fail = true
    const { calls } = mockApi({
      'GET users': () => [200, users],
      'GET connections/c1/grants': () =>
        fail ? [500, { code: 'INTERNAL', message: 'down' }] : [200, [{ userId: 'u1', role: 'viewer' }]],
    })
    const { wrapper } = mountApp(AccessCard, { props: { connection: { id: 'c1', name: 'M' } } })
    await flushPromises()
    expect(wrapper.findAll('select')).toHaveLength(0)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    fail = false
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Retry')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.findAll('select')).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith('grants')).length).toBe(2)
  })
})
