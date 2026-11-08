// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { CopyPlan, JobView } from '@mongo-manager/shared'
import CopyWizard from '../src/transfer/CopyWizard.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel } from './support/dom'

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
  { id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true },
  { id: 'c2', name: 'Dev', access: 'admin', permissions: ALL, export: true },
  { id: 'c3', name: 'Read', access: 'viewer', permissions: ['documents:read'], export: false },
]
const PLAN: CopyPlan = {
  planHash: 'f'.repeat(64),
  collections: [
    {
      source: 'orders',
      target: 'orders',
      exists: false,
      count: null,
      path: 'stream',
      sharded: false,
      ttlIndexes: ['ttl'],
      fullSort: false,
    },
  ],
  views: [],
  masked: false,
  missingRules: ['shop.orders.email'],
  mayAddRules: false,
  deployment: 'different',
  refusals: ['confirm_ttl', 'confirm_personal'],
}
const JOB = {
  id: 'j1',
  kind: 'data.copy',
  connectionId: 'c1',
  targetConnectionId: 'c2',
  db: 'shop',
  coll: 'orders',
  target: 'shop.orders',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
} satisfies JobView

const PLAN_PATH = 'POST connections/c1/databases/shop/collections/orders/copy/plan'

describe('copy wizard (phase 3d-2 spec §3.1)', () => {
  it('lists writable targets only, asks for the confirmations the plan names, and starts with the plan hash', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      [PLAN_PATH]: (body) => {
        const b = body as { confirmTtl?: boolean; confirmPersonal?: boolean }
        return [
          200,
          { ...(b.confirmTtl && b.confirmPersonal ? { ...PLAN, refusals: [] } : PLAN), mayAddRules: true },
        ]
      },
      'POST connections/c1/databases/shop/collections/orders/copy': () => [202, { job: JOB }],
      'GET transfer/presets': () => [200, { presets: [] }],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const select = document.querySelector<HTMLSelectElement>('[data-test="target-connection"] select')!
    const names = [...select.options].map((o) => o.textContent ?? '')
    expect(names.some((o) => o.includes('Read'))).toBe(false)
    expect(names.some((o) => o.includes('Dev'))).toBe(true)
    select.value = 'c2'
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('shop.orders.email')
    expect(document.body.textContent).toContain('ttl')
    expect(button('Copy').disabled).toBe(true)
    document.querySelector<HTMLInputElement>('[data-test="confirm-ttl"] input')!.click()
    await flushPromises()
    document.querySelector<HTMLInputElement>('[data-test="confirm-personal"] input')!.click()
    await flushPromises()
    expect(button('Copy').disabled).toBe(false)
    // Rules added to the target: in local mode they hide values from the local user there too, so
    // what every view shows is read again (review 2026-10-13, minor 6).
    byLabel(i18n.global.t('dataTransfer.copy.addRules')).click()
    await flushPromises()
    const listed = calls.filter((c) => c.method === 'GET' && c.path === 'connections').length
    button('Copy').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'GET' && c.path === 'connections').length).toBeGreaterThan(listed)
    const start = calls.find((c) => c.path.endsWith('/copy'))!
    expect(start.body).toMatchObject({
      planHash: PLAN.planHash,
      confirmTtl: true,
      confirmPersonal: true,
      source: { kind: 'collection' },
      target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
      mode: 'insert',
    })
  })

  it('starts a comparison in compare mode', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'POST connections/c1/databases/shop/collections/orders/compare': () => [
        202,
        { job: { ...JOB, kind: 'data.compare' } },
      ],
    })
    mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders', compare: true } })
    await flushPromises()
    const select = document.querySelector<HTMLSelectElement>('[data-test="target-connection"] select')!
    select.value = 'c2'
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    button('Next').click()
    await flushPromises()
    const ignore = document.querySelector<HTMLInputElement>('[data-test="compare-ignore"]')!
    ignore.value = 'updatedAt, meta.at'
    ignore.dispatchEvent(new Event('input'))
    await flushPromises()
    button('Compare').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/compare'))!.body).toEqual({
      target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
      filter: {},
      ignore: ['updatedAt', 'meta.at'],
    })
  })

  // Security audit 2026-10-16 (Important 3): what a masked copy leaves out is said, in both languages.
  for (const locale of ['en', 'tr'] as const)
    it(`names the definitions a masked copy leaves out (${locale})`, async () => {
      i18n.global.locale.value = locale
      mockApi({
        'GET connections': () => [200, CONNS],
        [PLAN_PATH]: () => [
          200,
          {
            ...PLAN,
            collections: [
              { ...PLAN.collections[0]!, validatorLeftOut: true, indexesLeftOut: ['vip', 'gold'] },
            ],
            viewsLeftOut: ['vipView'],
          },
        ],
        'GET transfer/presets': () => [200, { presets: [] }],
      })
      mountApp(CopyWizard, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
      await flushPromises()
      const next = i18n.global.t('dataTransfer.next')
      button(next).click()
      await flushPromises()
      const select = document.querySelector<HTMLSelectElement>('[data-test="target-connection"] select')!
      select.value = 'c2'
      select.dispatchEvent(new Event('change'))
      await flushPromises()
      button(next).click()
      await flushPromises()
      button(next).click()
      await flushPromises()
      const text = document.body.textContent ?? ''
      const t = i18n.global.t
      expect(text).toContain(t('dataTransfer.copy.validatorLeftOut', { name: 'orders' }))
      expect(text).toContain(t('dataTransfer.copy.indexesLeftOut', { name: 'orders', list: 'vip, gold' }))
      expect(text).toContain(t('dataTransfer.copy.viewsLeftOut', { names: 'vipView' }))
    })
})
