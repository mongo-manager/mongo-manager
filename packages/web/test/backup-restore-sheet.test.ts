// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ArchiveSummary, RestorePlan } from '@mongo-manager/shared'
import BackupRestoreSheet from '../src/backup/BackupRestoreSheet.vue'
import { useJobsStore } from '../src/jobs/store'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [
  { id: 'c1', name: 'Prod', access: 'admin', permissions: ALL, export: true },
  { id: 'c2', name: 'Dev', access: 'admin', permissions: ALL, export: true },
]
const SUMMARY: ArchiveSummary = {
  container: 'mmbak',
  serverVersion: '8.2.6',
  toolVersion: 'mongo-manager 2.0.0',
  mongoManager: null,
  namespaces: [
    { db: 'shop', coll: 'orders', type: 'collection', indexes: 3, ttl: ['at_ttl'], capped: false },
    { db: 'shop', coll: 'v', type: 'view', indexes: 0, ttl: [], capped: false, viewOn: 'orders' },
  ],
}
const PLAN = (over: Partial<RestorePlan> = {}): RestorePlan => ({
  planHash: 'b'.repeat(64),
  summary: SUMMARY,
  namespaces: [
    {
      from: { db: 'shop', coll: 'orders' },
      to: { db: 'shop', coll: 'orders' },
      type: 'collection',
      exists: true,
      documents: 1200,
      action: 'replace',
      ttl: ['at_ttl'],
      confirmName: true,
    },
    {
      from: { db: 'shop', coll: 'v' },
      to: { db: 'shop', coll: 'v' },
      type: 'view',
      exists: false,
      documents: null,
      action: 'create',
      ttl: [],
      confirmName: false,
    },
  ],
  missingRules: [],
  mayAddRules: true,
  tools: { available: true },
  checks: [{ key: 'conflict', level: 'warn', params: { count: 1 } }],
  refusals: [],
  ...over,
})
const KEPT = {
  id: 'b1',
  name: 'shop-20261003.archive.gz',
  jobId: 'j',
  connectionId: 'c1',
  scope: { kind: 'database', db: 'shop', views: true },
  engine: 'builtin',
  format: 'gzip',
  masked: false,
  anonymous: false,
  size: 100,
  sha256: 'x',
  namespaces: 2,
  startedAt: 1,
  finishedAt: 2,
  expiresAt: Date.now() + 1e7,
}
const job = (id: string, state = 'running') => ({
  id,
  kind: 'backup.restore',
  state,
  connectionId: 'c1',
  db: 'shop',
  coll: '*',
  target: 'shop.mmbak',
  targetConnectionId: null,
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: state === 'running' ? null : 2,
  mine: true,
  cancellable: state === 'running',
})
const settle = async (ms = 400) => {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function drop(file: File) {
  const zone = document.querySelector<HTMLElement>('[data-test="drop-zone"]')!
  const dt = { files: [file], types: ['Files'] }
  zone.dispatchEvent(Object.assign(new Event('drop', { bubbles: true }), { dataTransfer: dt }))
}
function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input'))
}

describe('restore sheet (spec §3.2, U4–U7)', () => {
  it('inspects while uploading, asks for the password, maps, and needs the typed name to replace', async () => {
    let inspects = 0
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'POST backups/uploads': () => [
        201,
        { uploadId: 'u1', name: 'shop.mmbak', size: 10, received: 0, complete: false },
      ],
      'PUT backups/uploads/u1': () => [200, { received: 10, complete: true }],
      'POST backups/inspect': (body) => {
        inspects++
        if (inspects === 1) return [200, { state: 'waiting', received: 0, size: 10 }]
        if (!(body as { password?: string }).password) return [200, { state: 'password' }]
        return [200, { state: 'ready', summary: SUMMARY }]
      },
      'POST connections/c1/restore/plan': (body) => {
        const b = body as { confirmNames: string[]; mode: string; confirmTtl: boolean }
        const refusals = [
          ...(b.confirmTtl ? [] : ['confirm_ttl']),
          ...(b.mode === 'replace' && !b.confirmNames.includes('shop.orders') ? ['confirm_name'] : []),
        ]
        return [200, PLAN({ refusals })]
      },
      'POST connections/c1/restore': () => [202, { job: job('j9') }],
    })
    const closed = vi.fn()
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', db: 'shop', onClose: closed } })
    await flushPromises()
    drop(new File([new Uint8Array(10)], 'shop.mmbak'))
    await settle(2500)
    // The password appears as soon as the inspection asks for it.
    type('[data-test="open-password"]', 'correct horse battery')
    button('Open').click()
    await settle()
    expect(document.body.textContent).toContain('Encrypted backup')
    expect(document.body.textContent).toContain('shop.orders')
    button('Next').click()
    await flushPromises()
    button('Next').click()
    await flushPromises()
    // Mode: replace; the typed name and the TTL confirmation are needed.
    document.querySelector<HTMLInputElement>('input[name="restore-mode"][value="replace"]')!.click()
    await settle()
    document.querySelector<HTMLInputElement>('[data-test="confirm-ttl"] input')!.click()
    type('[data-test="confirm-name-shop.orders"]', 'shop.orders')
    await settle()
    button('Next').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Replaces 1,200 documents')
    button('Start restore').click()
    await flushPromises()
    const start = calls.find((c) => c.path === 'connections/c1/restore')!
    expect(start.body).toMatchObject({
      planHash: 'b'.repeat(64),
      mode: 'replace',
      confirmTtl: true,
      confirmNames: ['shop.orders'],
      password: 'correct horse battery',
      dryRun: false,
    })
    expect(inspects).toBeGreaterThanOrEqual(3)
    expect(closed).toHaveBeenCalled()
    // The upload a restore reads is kept.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('says a wrong password plainly and lets the user try again', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': (body) =>
        (body as { password?: string }).password
          ? [400, { code: 'VALIDATION', message: 'x', details: { reason: 'backup_password' } }]
          : [200, { state: 'password' }],
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    await settle()
    type('[data-test="open-password"]', 'nope nope nope')
    button('Open').click()
    await settle()
    expect(document.body.textContent).toContain('The password is wrong, or the file is damaged.')
    expect(document.querySelector('[data-test="open-password"]')).not.toBeNull()
    // Said once: the keyboard goes back to the field, which is invalid and described by the message
    // (no second copy of it for screen readers — review of R3–R5, and the e2e found two).
    const field = document.querySelector<HTMLInputElement>('[data-test="open-password"]')!
    expect(document.activeElement).toBe(field)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(field.getAttribute('aria-describedby')!)!.textContent).toContain(
      'The password is wrong, or the file is damaged.',
    )
    expect(
      [...document.querySelectorAll('body *')].filter(
        (e) =>
          e.childElementCount === 0 && e.textContent === 'The password is wrong, or the file is damaged.',
      ),
    ).toHaveLength(1)
  })

  // Security review 2026-10-13 round 2 (I7): the server reads one backup at a time per user. A read
  // still busy is asked again a moment later, the password kept — never taken for a wrong one.
  it('asks again when the server is still reading a backup, keeping the password', async () => {
    let busy = 1
    const asked: Array<{ password?: string }> = []
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': (body) => {
        const b = body as { password?: string }
        asked.push(b)
        if (!b.password) return [200, { state: 'password' }]
        if (busy-- > 0)
          return [
            429,
            {
              code: 'RATE_LIMITED',
              message: 'x',
              details: { retryAfterMs: 500, reason: 'backup_read_busy' },
            },
          ]
        return [200, { state: 'ready', summary: SUMMARY, openedWith: { kind: 'password' } }]
      },
      [`POST connections/c1/restore/plan`]: () => [200, PLAN()],
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    await settle()
    type('[data-test="open-password"]', 'right one')
    button('Open').click()
    await settle(100)
    expect(document.body.textContent).not.toContain('The password is wrong')
    expect(document.body.textContent).not.toContain('Too many')
    await settle(700)
    expect(asked.filter((a) => a.password === 'right one')).toHaveLength(2)
    expect(document.querySelector('[data-test="open-password"]')).toBeNull()
  })

  it('asks for the restore plan again when the server is still reading the backup', async () => {
    let busy = 1
    let plans = 0
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': () => [200, { state: 'ready', summary: SUMMARY }],
      [`POST connections/c1/restore/plan`]: () => {
        plans++
        return busy-- > 0
          ? [
              429,
              {
                code: 'RATE_LIMITED',
                message: 'x',
                details: { retryAfterMs: 500, reason: 'backup_read_busy' },
              },
            ]
          : [200, PLAN()]
      },
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    await settle()
    await settle(1500)
    expect(plans).toBeGreaterThanOrEqual(2)
    expect(document.body.textContent).not.toContain('Too many')
  })

  it('bulk-renames the database and suggests a safe target (U5)', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': () => [200, { state: 'ready', summary: { ...SUMMARY, container: 'gzip' } }],
      'POST connections/c1/restore/plan': () => [200, PLAN({ refusals: ['confirm_ttl'] })],
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', db: 'shop', backupId: 'b1' } })
    await settle()
    button('Next').click()
    await flushPromises()
    button('Add _restored').click()
    await settle()
    const last = calls.filter((c) => c.path === 'connections/c1/restore/plan').at(-1)!
    expect(
      (last.body as { mapping: Array<{ to: { db: string } }> }).mapping.every(
        (m) => m.to.db === 'shop_restored',
      ),
    ).toBe(true)
  })

  it('shows a finished dry run and runs the real restore with the same settings (U6)', async () => {
    let starts = 0
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': () => [200, { state: 'ready', summary: { ...SUMMARY, container: 'gzip' } }],
      'POST connections/c1/restore/plan': () => [
        200,
        PLAN({ namespaces: [{ ...PLAN().namespaces[0]!, action: 'upsert', confirmName: false, ttl: [] }] }),
      ],
      'POST connections/c1/restore': () => [202, { job: job(`j${++starts}`) }],
      'GET transfer/jobs/j1/report': () => [
        200,
        {
          kind: 'restore',
          dryRun: true,
          namespaces: [{ read: 10, wouldMatch: 4, failed: 1, expiring: 3 }],
        },
      ],
    })
    const closed = vi.fn()
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1', onClose: closed } })
    await settle()
    for (let i = 0; i < 3; i++) {
      button('Next').click()
      await settle()
    }
    button('Dry run').click()
    await flushPromises()
    expect(closed).not.toHaveBeenCalled()
    useJobsStore().upsert(job('j1', 'done') as never)
    await settle()
    expect(document.body.textContent).toContain(
      'Dry run: 10 documents read, 4 would match, 1 would be refused',
    )
    // Backup review M10: what a TTL index deletes as soon as it is written.
    expect(document.querySelector('[data-test="dry-expiring"]')!.textContent).toContain(
      'A TTL index will delete 3 of them as soon as they are written',
    )
    button('Restore now with these settings').click()
    await flushPromises()
    const startsBodies = calls
      .filter((c) => c.path === 'connections/c1/restore')
      .map((c) => c.body as { dryRun: boolean })
    expect(startsBodies.map((b) => b.dryRun)).toEqual([true, false])
    expect(closed).toHaveBeenCalled()
  })

  // User report 2026-10-23: a target that cannot be reached is said as that, and never restored into
  // from a plan made while it still answered.
  it('says a target cannot be reached, with Retry, and never starts from an older plan', async () => {
    let up = true
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': () => [200, { state: 'ready', summary: { ...SUMMARY, container: 'gzip' } }],
      'POST connections/c1/restore/plan': () =>
        up
          ? [
              200,
              PLAN({
                namespaces: [{ ...PLAN().namespaces[0]!, action: 'upsert', confirmName: false, ttl: [] }],
              }),
            ]
          : [
              502,
              { code: 'MONGO_ERROR', message: 'Server selection timed out', details: { kind: 'timeout' } },
            ],
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    await settle()
    button('Next').click()
    await settle()
    // The server stops answering; a change plans again.
    up = false
    button('Add _restored').click()
    await settle()
    const alert = [...document.querySelectorAll('[role="alert"]')].find((a) =>
      a.textContent?.includes('No connection to this MongoDB server'),
    )!
    expect(alert.textContent).toContain('A restore writes into this connection')
    expect(document.body.textContent).not.toContain('The server did not answer in time.')
    button('Next').click()
    await settle()
    button('Next').click()
    await settle()
    expect(button('Start restore').disabled).toBe(true)
    expect(button('Dry run').disabled).toBe(true)
    button('Start restore').click()
    await flushPromises()
    expect(calls.some((c) => c.path === 'connections/c1/restore')).toBe(false)
    up = true
    button('Retry').click()
    await settle()
    expect(document.body.textContent).not.toContain('No connection to this MongoDB server')
    expect(button('Start restore').disabled).toBe(false)
  })

  it('polls less and less while the upload does not grow (final review I2)', async () => {
    let inspects = 0
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': () => {
        inspects++
        return [200, { state: 'waiting', received: 5, size: 10 }]
      },
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    await settle(20_000)
    // Once a second would be about 20; backing off to 8 s it is a handful.
    expect(inspects).toBeGreaterThan(2)
    expect(inspects).toBeLessThanOrEqual(8)
  })

  it('discards a partial upload when the sheet closes mid-way', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'POST backups/uploads': () => [
        201,
        { uploadId: 'u7', name: 'big', size: 10, received: 0, complete: false },
      ],
      'PUT backups/uploads/u7': () => new Promise(() => undefined),
      'POST backups/inspect': () => [200, { state: 'waiting', received: 0, size: 10 }],
      'DELETE backups/uploads/u7': () => [204],
    })
    const { wrapper } = mountApp(BackupRestoreSheet, { props: { connectionId: 'c1' } })
    await flushPromises()
    drop(new File([new Uint8Array(10)], 'big.archive'))
    await settle()
    wrapper.unmount()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'backups/uploads/u7')).toBe(true)
  })
})
