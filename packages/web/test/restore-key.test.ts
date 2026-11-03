import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ArchiveSummary, RestorePlan } from '@mongo-manager/shared'
import BackupRestoreSheet from '../src/backup/BackupRestoreSheet.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, typeInto } from './support/dom'
import { KEY, KIT } from './support/schedules'

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
const settle = async (ms = 400) => {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}
const text = () => document.body.textContent ?? ''
const CONNS = [
  {
    id: 'c1',
    name: 'Prod',
    access: 'editor',
    permissions: ['documents:read', 'documents:write', 'jobs:run'],
    export: true,
  },
]
const SUMMARY: ArchiveSummary = {
  container: 'mmbak',
  serverVersion: '8.2.6',
  toolVersion: 'mongo-manager 2.0.0',
  mongoManager: null,
  namespaces: [{ db: 'shop', coll: 'orders', type: 'collection', indexes: 1, ttl: [], capped: false }],
}
const PLAN: RestorePlan = {
  planHash: 'b'.repeat(64),
  summary: SUMMARY,
  namespaces: [
    {
      from: { db: 'shop', coll: 'orders' },
      to: { db: 'shop', coll: 'orders' },
      type: 'collection',
      exists: false,
      documents: null,
      action: 'create',
      ttl: [],
      confirmName: false,
    },
  ],
  missingRules: [],
  mayAddRules: false,
  tools: { available: false },
  checks: [],
  refusals: [],
}
const KEPT = {
  id: 'b1',
  name: 'shop-20261004-020000.mmbak',
  jobId: 'j',
  connectionId: 'c1',
  scope: { kind: 'database', db: 'shop', views: true },
  engine: 'builtin',
  format: 'mmbak',
  masked: false,
  anonymous: false,
  size: 100,
  sha256: 'x',
  namespaces: 1,
  startedAt: 1,
  finishedAt: 2,
  expiresAt: Date.now() + 1e7,
  copies: [],
}

describe('restoring a backup-key file (phase 3d-3c spec §5)', () => {
  it('opens with the caller’s own key and says with which', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': () => [
        200,
        {
          state: 'ready',
          summary: SUMMARY,
          openedWith: { kind: 'key', fingerprint: 'K-1a2b3c4d', name: 'Key 1' },
        },
      ],
      'POST connections/c1/restore/plan': () => [200, PLAN],
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    await settle()
    // UI review: the key's name already says "Key"; the line names it once.
    expect(text()).toContain('Opened with Key 1, your backup key (K-1a2b3c4d)')
  })

  it('asks for the kit, says when one does not fit, imports the key on request, and restores with it', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [KEPT]],
      'POST backups/inspect': (body) => {
        const kit = (body as { kit?: string }).kit
        if (!kit) return [200, { state: 'key', fingerprint: 'K-1a2b3c4d', password: false }]
        if (!kit.includes('MMKEY1-'))
          return [400, { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'backup_key' } }]
        return [
          200,
          { state: 'ready', summary: SUMMARY, openedWith: { kind: 'kit', fingerprint: 'K-1a2b3c4d' } },
        ]
      },
      'POST backup-keys/import': () => [201, KEY({ id: 'k9', name: 'Key 1', state: 'imported' })],
      'POST connections/c1/restore/plan': () => [200, PLAN],
    })
    mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', backupId: 'b1' } })
    mountApp(ToastHost)
    await settle()
    expect(text()).toContain('This backup was made with backup key K-1a2b3c4d')
    await typeInto(byLabel<HTMLTextAreaElement>('Recovery kit'), 'not a kit at all')
    button('Open').click()
    await settle()
    expect(text()).toContain('This kit belongs to another key')
    await typeInto(byLabel<HTMLTextAreaElement>('Recovery kit'), KIT)
    await check(byLabel('Import this key, so its backups open directly next time'))
    button('Open').click()
    await settle()
    expect(text()).toContain('Opened with the recovery kit of K-1a2b3c4d')
    expect(calls.find((c) => c.path === 'backup-keys/import')?.body).toEqual({ kit: KIT })
    expect(text()).toContain('Key 1 was imported.')
    expect(
      (calls.filter((c) => c.path === 'connections/c1/restore/plan').at(-1)?.body as { kit?: string }).kit,
    ).toBe(KIT)
  })
})
