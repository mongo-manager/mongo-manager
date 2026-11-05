// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { DumpPlan } from '@mongo-manager/shared'
import BackupDumpSheet from '../src/backup/BackupDumpSheet.vue'
import WhereSection from '../src/backup/WhereSection.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const CONNS = [
  {
    id: 'c1',
    name: 'Prod',
    access: 'editor',
    permissions: ['documents:read', 'jobs:run', 'data:export'],
    export: true,
  },
]
const DESTS = [
  { id: 'd1', name: 'Offsite S3', type: 's3', level: 'send', policy: { encryptedOnly: true } },
  { id: 'd2', name: 'NAS', type: 'folder', level: 'send', policy: { encryptedOnly: false } },
]
const plan = (over: Partial<DumpPlan> = {}): DumpPlan => ({
  planHash: 'a'.repeat(64),
  namespaces: [
    { db: 'shop', coll: 'orders', type: 'collection', documents: 10, bytes: 1000, ttl: [], personal: [] },
  ],
  estimate: { bytes: 1000, fileBytes: 300, seconds: 1 },
  tools: { available: false, reason: 'not_admin' },
  masked: false,
  recommended: { format: 'gzip', engine: 'builtin', reason: null },
  checks: [],
  refusals: [],
  ...over,
})
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const settle = async () => {
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}

describe('Where (phase 3d-3b V5)', () => {
  it('offers the destinations, disables an incompatible one with its reason and fix, and sends the choice', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders', type: 'collection' }]],
      'GET backup-destinations': () => [200, DESTS],
      'POST connections/c1/backup/plan': () => [200, plan()],
      'POST connections/c1/backup': () => [202, { job: { id: 'j1', kind: 'backup.dump', state: 'running' } }],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    await settle()
    const s3 = document.querySelector<HTMLButtonElement>('[data-destination="d1"]')!
    expect(s3.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.textContent).toContain('Offsite S3 accepts encrypted backups only')
    document.querySelector<HTMLButtonElement>('[data-destination="d2"]')!.click()
    await settle()
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).toMatchObject({
      destinations: ['d2'],
    })
    expect(document.body.textContent).toContain('Delete the local copy after a verified upload')
    button('Encrypt').click()
    await settle()
    expect(document.querySelector('[data-destination="d1"]')!.getAttribute('aria-disabled')).toBe('false')
  })

  it('remembers the last choice per user', async () => {
    localStorage.setItem('mm:backup-where:anon', JSON.stringify(['d2']))
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET backup-destinations': () => [200, DESTS],
      'POST connections/c1/backup/plan': () => [200, plan()],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    await settle()
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).toMatchObject({
      destinations: ['d2'],
    })
  })

  it('says a destination check in words', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'GET backup-destinations': () => [200, DESTS],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({
          checks: [
            {
              key: 'destination',
              level: 'block',
              params: { name: 'NAS', reason: 'personal_plain' },
              fix: { kind: 'encrypt' },
            },
          ],
          refusals: ['destination_personal_plain'],
        }),
      ],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    expect(document.body.textContent).toContain(
      'NAS: an unencrypted backup with personal data cannot leave the server',
    )
  })
})

// Phase 3d-3b UI review: three encrypted-only destinations gave three identical sentences and three
// Encrypt buttons, and choosing a destination made "This server" look dropped.
describe('WhereSection', () => {
  const three = [
    { id: 'd1', name: 'Offsite S3', type: 's3', level: 'send', policy: { encryptedOnly: true } },
    { id: 'd2', name: 'NAS', type: 'folder', level: 'send', policy: { encryptedOnly: true } },
    { id: 'd3', name: 'Cloud', type: 'webdav', level: 'send', policy: { encryptedOnly: true } },
  ] as const
  const server = () =>
    [...document.querySelectorAll('[role="group"] span')].find((s) => s.textContent?.includes('This server'))!

  it('says once which destinations refuse a plain archive, with one fix', () => {
    mountApp(WhereSection, {
      props: {
        destinations: [...three],
        modelValue: [],
        deleteLocal: false,
        format: 'gzip',
        plainPersonal: false,
      },
    })
    const items = document.querySelectorAll('ul li')
    expect(items).toHaveLength(1)
    expect(items[0]!.textContent).toContain('Offsite S3, NAS, and Cloud accept encrypted backups only.')
    expect(document.querySelectorAll('ul li button')).toHaveLength(1)
  })

  it('keeps this server chosen until the local copy is set to go', () => {
    const { wrapper } = mountApp(WhereSection, {
      props: {
        destinations: [...three],
        modelValue: ['d2'],
        deleteLocal: false,
        format: 'mmbak',
        plainPersonal: false,
      },
    })
    expect(server().getAttribute('data-kept')).toBe('true')
    void wrapper.setProps({ deleteLocal: true })
    return flushPromises().then(() => expect(server().getAttribute('data-kept')).toBe('false'))
  })
})
