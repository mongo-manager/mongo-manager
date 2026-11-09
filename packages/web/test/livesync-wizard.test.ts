// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { CopyPlan, LiveSyncPlan } from '@mongo-manager/shared'
import LiveSyncWizard from '../src/livesync/LiveSyncWizard.vue'
import CopyWizard from '../src/transfer/CopyWizard.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useTabsStore } from '../src/stores/tabs'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'
import { SYNC } from './support/livesync'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ALL = ['documents:read', 'documents:write', 'databases:write', 'indexes:write', 'jobs:run']
const CONNS = [
  { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true, restricted: false },
  { id: 'c2', name: 'Reporting', access: 'admin', permissions: ALL, export: true },
  { id: 'c3', name: 'Read', access: 'viewer', permissions: ['documents:read'], export: false },
]
const COPY: CopyPlan = {
  planHash: 'c'.repeat(64),
  collections: [
    {
      source: 'orders',
      target: 'orders',
      exists: false,
      count: null,
      path: 'stream',
      sharded: false,
      ttlIndexes: [],
      fullSort: false,
    },
  ],
  views: [],
  masked: false,
  missingRules: [],
  mayAddRules: false,
  deployment: 'different',
  refusals: [],
} as unknown as CopyPlan
const PLAN = (over: Partial<LiveSyncPlan> = {}): LiveSyncPlan => ({
  planHash: 'a'.repeat(64),
  copy: COPY,
  masked: false,
  warnings: ['overwrite'],
  refusals: [],
  estimate: { documents: 1_200_000, bytes: 340 * 1024 * 1024, seconds: 120 },
  oplogWindowSeconds: 12_000,
  ...over,
})
/** The plan answers with a refusal until the body carries what it asks for. */
const planned =
  (asks: Record<string, (b: Record<string, unknown>) => boolean>, over: Partial<LiveSyncPlan> = {}) =>
  (body: unknown) => {
    const b = body as Record<string, unknown>
    return [
      200,
      PLAN({
        ...over,
        refusals: Object.entries(asks)
          .filter(([, ok]) => !ok(b))
          .map(([r]) => r),
      }),
    ] as [number, unknown]
  }

describe('the live sync wizard (phase 3e-2 spec §5)', () => {
  it('plans a collection sync, asks to confirm the overwrite, starts it and opens the Live syncs tab', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/plan': planned({
        confirm_overwrite: (b) => b.confirmOverwrite === true,
      }),
      'POST connections/c1/live-syncs': () => [201, SYNC({ state: 'copying' })],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    mountApp(ToastHost)
    await flushPromises()
    const targets = [...byLabel<HTMLSelectElement>('Target connection').options].map((o) =>
      o.textContent?.trim(),
    )
    expect(targets.some((x) => x?.startsWith('Read'))).toBe(false)
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Copy first')
    button('Next').click()
    await flushPromises()
    const plan = calls.find((c) => c.path === 'connections/c1/live-syncs/plan')!
    expect(plan.body).toMatchObject({
      source: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
      startMode: 'copy',
      errorPolicy: 'pause',
    })
    expect(document.body.textContent).toContain('1.2M documents')
    expect(document.querySelector('[data-from]')!.textContent).toMatch(/Prod.*shop\.orders/)
    expect(document.querySelector('[data-to]')!.textContent).toMatch(/Reporting.*shop\.orders/)
    expect(document.body.textContent).toMatch(/keeps about 3 hr 20 min of changes/)
    expect(button('Start live sync').disabled).toBe(true)
    await check(byLabel('I understand: writes made on the target are overwritten'))
    await flushPromises()
    expect(button('Start live sync').disabled).toBe(false)
    button('Start live sync').click()
    await flushPromises()
    expect(
      calls.find((c) => c.method === 'POST' && c.path === 'connections/c1/live-syncs')!.body,
    ).toMatchObject({
      planHash: 'a'.repeat(64),
      confirmOverwrite: true,
    })
    expect(document.body.textContent).toContain('Live sync started')
    expect(useTabsStore().active?.kind).toBe('liveSyncs')
  })

  it('starts again in place of an earlier sync (final review m16)', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/plan': () => [200, PLAN()],
      'POST connections/c1/live-syncs': () => [201, SYNC({ state: 'catching_up' })],
    })
    mountApp(LiveSyncWizard, {
      props: {
        connectionId: 'c1',
        db: 'shop',
        coll: 'orders',
        preset: {
          target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
          startMode: 'merge',
          replaces: 'old',
        },
      },
    })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'connections/c1/live-syncs/plan')!.body).toMatchObject({
      startMode: 'merge',
      replaces: 'old',
    })
  })

  it('syncs chosen collections of a database, and follows new ones only when all are chosen', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection' },
          { name: 'users', type: 'collection' },
          { name: 'v', type: 'view' },
        ],
      ],
      'POST connections/c1/live-syncs/plan': () => [200, PLAN()],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    // A view is not offered: views follow only with an initial copy.
    expect(() => byLabel('v')).toThrow()
    expect(byLabel('Include collections created later').checked).toBe(true)
    await check(byLabel('orders'))
    expect(byLabel('Include collections created later').disabled).toBe(true)
    button('Next').click()
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    await typeInto(byLabel('Database'), 'copy')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'connections/c1/live-syncs/plan')!.body).toMatchObject({
      source: { connectionId: 'c1', db: 'shop', collections: ['orders'] },
      target: { connectionId: 'c2', db: 'copy' },
      followNew: false,
    })
  })

  it('says a long oplog window in days', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/plan': () => [200, PLAN({ oplogWindowSeconds: 400 * 86_400 })],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('The source keeps about 400 days of changes.')
  })

  it('needs the target’s name typed to replace it', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/plan': planned({
        confirm_overwrite: (b) => b.confirmOverwrite === true,
        confirm_target: (b) => b.startMode !== 'replace' || b.confirmTarget === 'orders',
      }),
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    await check(document.querySelector<HTMLInputElement>('input[type="radio"][value="replace"]')!)
    await typeInto(byLabel('Type the target collection’s name to replace it'), 'orders')
    button('Next').click()
    await flushPromises()
    await check(byLabel('I understand: writes made on the target are overwritten'))
    await flushPromises()
    expect(button('Start live sync').disabled).toBe(false)
  })

  it('shows each warning with its confirmation, and refusals in words', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/plan': planned(
        {
          confirm_overwrite: (b) => b.confirmOverwrite === true,
          confirm_oplog: (b) => b.confirmOplog === true,
          confirm_personal: (b) => b.confirmPersonal === true,
          loop: () => false,
        },
        {
          warnings: ['overwrite', 'oplog_window', 'personal_unruled', 'unique_masked'],
          copy: { ...COPY, missingRules: ['shop.orders.email'], mayAddRules: true } as never,
        },
      ),
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('may outlast the changes the source keeps')
    expect(text).toContain('shop.orders.email')
    expect(text).toContain('Unique indexes over personal data are not built')
    expect(text).toContain('Another live sync already goes the other way')
    await check(byLabel('I understand: writes made on the target are overwritten'))
    await check(byLabel('Start anyway: I will finish it before the history runs out'))
    await check(byLabel('Write personal data unmasked to the target'))
    await flushPromises()
    // The loop is not something a box can confirm.
    expect(button('Start live sync').disabled).toBe(true)
  })

  it('makes a sync from a source the user may not see personal data of anonymous, always', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [{ ...CONNS[0], restricted: true }, CONNS[1]]],
      'POST connections/c1/live-syncs/plan': () => [200, PLAN({ masked: true })],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Target connection'), 'c2')
    button('Next').click()
    await flushPromises()
    const anonymous = byLabel('Mask personal data (anonymous sync)')
    expect(anonymous.checked).toBe(true)
    expect(anonymous.disabled).toBe(true)
    button('Next').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/plan'))!.body).toMatchObject({ anonymous: true })
  })

  it('reviews a stopped sync and confirms it with the reviewed summary', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/live-syncs/ls1/review': () => [200, PLAN()],
      'POST connections/c1/live-syncs/ls1/confirm': () => [200, SYNC({ state: 'catching_up' })],
    })
    mountApp(LiveSyncWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', review: 'ls1' } })
    await flushPromises()
    expect(document.body.textContent).toContain('Review')
    button('Carry on').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'connections/c1/live-syncs/ls1/confirm')!.body).toMatchObject({
      planHash: 'a'.repeat(64),
    })
  })

  it('opens pre-filled from the copy wizard’s “Copy and keep in sync…”', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/databases/shop/collections/orders/copy/plan': () => [200, COPY],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    await choose(document.querySelector<HTMLSelectElement>('[data-test="target-connection"] select')!, 'c2')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    button('Copy and keep in sync…').click()
    expect(useWorkspaceDialogs().current).toMatchObject({
      kind: 'liveSync',
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
      preset: {
        target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
        startMode: 'copy',
        errorPolicy: 'skip',
      },
    })
  })
})
