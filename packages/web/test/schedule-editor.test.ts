import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, type Component } from 'vue'
import WhatStep from '../src/schedules/WhatStep.vue'
import WhenStep from '../src/schedules/WhenStep.vue'
import {
  bodyOf,
  comparable,
  draftFrom,
  newDraft,
  type ScheduleDraft,
} from '../src/schedules/useScheduleDraft'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'
import { SCHEDULE } from './support/schedules'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [
  { id: 'c1', name: 'Production', access: 'editor', permissions: ALL, export: true },
  { id: 'c2', name: 'Reporting', access: 'viewer', permissions: ['documents:read'], export: false },
]
const mountStep = (component: Component, draft: ScheduleDraft, props: object = {}) =>
  mountApp(component, { props: { draft, ...props } })
const words = () => document.querySelector('[data-test="words"]')!.textContent?.trim()

describe('the schedule draft (phase 3d-3c spec §1.2)', () => {
  it('turns a draft into the request the routes take, and a saved schedule back into a draft', () => {
    const d = newDraft({ connectionId: 'c1', db: 'shop' })
    Object.assign(d, { name: 'shop backups', timeZone: 'Europe/Berlin', destinations: ['d1'] })
    expect(bodyOf(d)).toEqual({
      name: 'shop backups',
      connectionId: 'c1',
      dump: {
        scope: { kind: 'database', db: 'shop', views: true },
        engine: 'builtin',
        indexes: true,
        options: true,
        anonymous: false,
      },
      format: 'mmbak',
      cadence: { kind: 'daily', times: ['02:00'] },
      timeZone: 'Europe/Berlin',
      destinations: ['d1'],
      keepOnServer: false,
      retention: { last: 7, daily: 14, weekly: 8, monthly: 12 },
      // W4.4: no restore drill unless asked.
      drill: null,
    })
    const cron = draftFrom(
      SCHEDULE({
        cadence: { kind: 'cron', expression: '0 3 * * 1-5' },
        dump: {
          scope: { kind: 'collection', db: 'shop', coll: 'orders' },
          engine: 'builtin',
          indexes: false,
          options: true,
          anonymous: true,
        },
      }),
    )
    expect(bodyOf(cron)).toMatchObject({
      cadence: { kind: 'cron', expression: '0 3 * * 1-5' },
      dump: { scope: { kind: 'collection', db: 'shop', coll: 'orders' }, indexes: false, anonymous: true },
    })
    // Final review minor 21: editing keeps the engine a schedule was saved with.
    const dumped = draftFrom(
      SCHEDULE({
        dump: {
          scope: { kind: 'database', db: 'shop', views: true },
          engine: 'tools',
          indexes: true,
          options: true,
          anonymous: false,
        },
      }),
    )
    expect(bodyOf(dumped).dump.engine).toBe('tools')
    const weekly = newDraft()
    Object.assign(weekly, { kind: 'weekly', days: [5, 1, 1] })
    expect(bodyOf(weekly).cadence).toEqual({ kind: 'weekly', days: [1, 5], time: '02:00' })
    // A suggested name the user never touched is no change.
    const before = comparable(d)
    d.name = 'another suggestion'
    d.nameTouched = false
    expect(comparable(d)).toBe(before)
  })
})

describe('What (spec §5 editor)', () => {
  it('offers only connections the user may back up, and names the schedule after its scope until a name is typed', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases': () => [
        200,
        {
          databases: [
            { name: 'shop', sizeOnDisk: 1, empty: false },
            { name: 'admin', sizeOnDisk: 1, empty: false },
          ],
          totalSize: 2,
        },
      ],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection', options: {}, readOnly: false },
          { name: 'open_orders', type: 'view', options: {}, readOnly: false },
        ],
      ],
    })
    const draft = reactive(newDraft())
    mountStep(WhatStep, draft)
    await flushPromises()
    const connection = byLabel<HTMLSelectElement>('Connection')
    expect([...connection.options].map((o) => o.textContent?.trim())).toEqual([
      'Choose a connection',
      'Production',
    ])
    await choose(connection, 'c1')
    await flushPromises()
    const db = byLabel<HTMLSelectElement>('Database')
    expect([...db.options].map((o) => o.value)).toEqual(['', 'shop'])
    await choose(db, 'shop')
    await flushPromises()
    expect(draft.name).toBe('shop backups')
    await check(byLabel('orders'), false)
    expect(draft.collections).toEqual(['open_orders'])
    await typeInto(byLabel('Name'), 'Nightly shop')
    document.querySelector<HTMLInputElement>('input[name="scope"][value="collection"]')!.click()
    await flushPromises()
    expect(draft.scope).toBe('collection')
    expect(draft.name).toBe('Nightly shop')
    await check(byLabel('Anonymous'))
    expect(draft.anonymous).toBe(true)
  })
})

describe('When (spec §1.3, §5 editor)', () => {
  it('says the cadence in words, lists the next five runs in the zone, and explains a refused cadence', async () => {
    const draft = reactive(newDraft())
    draft.timeZone = 'Europe/Berlin'
    mountStep(WhenStep, draft)
    await flushPromises()
    expect(words()).toBe('Every day at 02:00')
    expect(document.querySelectorAll('[data-run]')).toHaveLength(5)
    document.querySelector<HTMLInputElement>('input[name="cadence"][value="weekly"]')!.click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Tuesday"]')!.click()
    await flushPromises()
    expect(words()).toBe('Every Monday and Tuesday at 02:00')
    document.querySelector<HTMLInputElement>('input[name="cadence"][value="cron"]')!.click()
    await flushPromises()
    await typeInto(byLabel('Cron expression'), '*/30 * * * *')
    expect(document.body.textContent).toContain(
      'Runs must be at least an hour apart (two are 30 minutes apart).',
    )
    await typeInto(byLabel('Cron expression'), '0 2 * * 1-5')
    expect(words()).toBe('At 02:00 on Monday through Friday')
    await typeInto(byLabel('Time zone'), 'Mars/Olympus')
    expect(document.body.textContent).toContain('Not a time zone this browser knows.')
    expect(document.querySelectorAll('[data-run]')).toHaveLength(0)
  })

  it('takes up to four daily times, and at least one weekday', async () => {
    const draft = reactive(newDraft())
    mountStep(WhenStep, draft)
    await flushPromises()
    for (let i = 0; i < 4; i++)
      if (document.body.textContent?.includes('Add a time')) button('Add a time').click()
    await flushPromises()
    expect(draft.times).toHaveLength(4)
    expect(document.body.textContent).not.toContain('Add a time')
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove 02:00"]')!.click()
    await flushPromises()
    expect(draft.times).not.toContain('02:00')
    document.querySelector<HTMLInputElement>('input[name="cadence"][value="weekly"]')!.click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label="Monday"]')!.click()
    await flushPromises()
    expect(draft.days).toEqual([1])
  })

  it('groups the daily times under one name, each time named by its place (UI review)', async () => {
    const draft = reactive(newDraft())
    mountStep(WhenStep, draft)
    await flushPromises()
    button('Add a time').click()
    await flushPromises()
    const group = document.querySelector<HTMLFieldSetElement>('fieldset[data-times]')!
    expect(group.querySelector('legend')?.textContent?.trim()).toBe('Times of day')
    expect(
      [...group.querySelectorAll<HTMLInputElement>('input[type="time"]')].map((x) =>
        x.getAttribute('aria-label'),
      ),
    ).toEqual(['Time 1', 'Time 2'])
  })

  // Final review minor 13: every keystroke in the cron field was announced assertively, and the zone's
  // error was not tied to its field.
  it('announces the words and a problem once typing settles, and ties the zone’s error to its field', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const draft = reactive(newDraft())
    draft.kind = 'cron'
    draft.expression = '0 2 * * *'
    mountStep(WhenStep, draft)
    await flushPromises()
    expect(document.querySelector('aside[aria-live]')).toBeNull()
    expect(document.querySelector('aside [role="alert"]')).toBeNull()
    const live = document.querySelector<HTMLElement>('[data-test="when-live"]')!
    expect(live.getAttribute('aria-live')).toBe('polite')
    draft.expression = '*/30 * * * *'
    await flushPromises()
    expect(live.textContent).not.toContain('at least an hour apart')
    await vi.advanceTimersByTimeAsync(900)
    expect(live.textContent).toContain('at least an hour apart')
    const zone = document.querySelector<HTMLInputElement>('input[list]')!
    draft.timeZone = 'Mars/Olympus'
    await flushPromises()
    expect(document.getElementById(zone.getAttribute('aria-describedby')!)?.textContent).toContain(
      'Not a time zone this browser knows.',
    )
    vi.useRealTimers()
  })

  // Final review I5: changing a time re-created its field, so a keyboard user lost it mid-edit.
  it('keeps the same time field, and its focus, while the time changes', async () => {
    const draft = reactive(newDraft())
    mountStep(WhenStep, draft)
    await flushPromises()
    const time = document.querySelector<HTMLInputElement>('input[aria-label="Time 1"]')!
    time.focus()
    time.value = '03:30'
    time.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(draft.times).toEqual(['03:30'])
    expect(document.querySelector('input[aria-label="Time 1"]')).toBe(time)
    expect(document.activeElement).toBe(time)
  })

  // Final review minor 2: the cron field's problem in the reader's language.
  it('says a cron expression it cannot read in Turkish too', async () => {
    i18n.global.locale.value = 'tr'
    const draft = reactive(newDraft())
    draft.kind = 'cron'
    draft.expression = '0 25 * * *'
    mountStep(WhenStep, draft)
    await flushPromises()
    expect(document.body.textContent).toContain('Saat: 25, 0–23 aralığının dışında.')
  })

  it('changes a time, keeps the last weekday chosen, and takes the last day of the month', async () => {
    const draft = reactive(newDraft())
    mountStep(WhenStep, draft)
    await flushPromises()
    const time = document.querySelector<HTMLInputElement>('input[aria-label="Time 1"]')!
    time.value = '03:30'
    time.dispatchEvent(new Event('change'))
    // An emptied time field changes nothing.
    time.value = ''
    time.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(draft.times).toEqual(['03:30'])
    document.querySelector<HTMLInputElement>('input[name="cadence"][value="weekly"]')!.click()
    await flushPromises()
    const monday = document.querySelector<HTMLButtonElement>('button[aria-label="Monday"]')!
    monday.click()
    await flushPromises()
    expect(draft.days).toEqual([1])
    // At least one day: the last one cannot be turned off.
    monday.click()
    await flushPromises()
    expect(draft.days).toEqual([1])
    document.querySelector<HTMLInputElement>('input[name="cadence"][value="monthly"]')!.click()
    await flushPromises()
    // The monthly form's only select: the day of the month.
    const day = document.querySelector<HTMLSelectElement>('select')!
    day.value = 'last'
    day.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(draft.monthDay).toBe('last')
    expect(document.body.textContent).toContain('last day of every month')
    day.value = '15'
    day.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(draft.monthDay).toBe(15)
  })
})
