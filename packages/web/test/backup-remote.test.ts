import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import BackupsCard from '../src/backup/BackupsCard.vue'
import BackupSendSheet from '../src/backup/BackupSendSheet.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const CONNS = [
  {
    id: 'c1',
    name: 'Prod',
    access: 'editor',
    permissions: ['documents:read', 'documents:write', 'jobs:run', 'data:export'],
    export: true,
  },
]
const BACKUP = {
  id: 'b1',
  name: 'shop-20261003-120000.mmbak',
  jobId: 'j1',
  connectionId: 'c1',
  scope: { kind: 'database', db: 'shop' },
  engine: 'builtin',
  format: 'mmbak',
  masked: false,
  anonymous: false,
  size: 1000,
  sha256: 'a'.repeat(64),
  namespaces: 1,
  startedAt: 1,
  finishedAt: Date.now() - 3_600_000,
  expiresAt: Date.now() + 3_600_000,
  copies: [
    {
      id: 'k1',
      destinationId: 'd1',
      destinationName: 'Offsite S3',
      state: 'complete',
      sent: 1000,
      size: 1000,
      error: null,
      completedAt: 2,
    },
    {
      id: 'k2',
      destinationId: 'd2',
      destinationName: 'NAS',
      state: 'failed',
      sent: 300,
      size: 1000,
      error: 'NAS: The destination is full',
      completedAt: null,
    },
  ],
}
const DESTS = [{ id: 'd1', name: 'Offsite S3', type: 's3', level: 'browse', policy: { encryptedOnly: true } }]
const REMOTE = {
  items: [
    {
      key: 'mongo-manager/2026/10/mm-20261003-120000-aaaaaaaa.mmbak',
      name: 'mm-20261003-120000-aaaaaaaa.mmbak',
      size: 1000,
      createdAt: Date.now() - 86_400_000,
      format: 'mmbak',
      archived: false,
      state: 'complete',
      copyId: 'k1',
      sender: 'alice',
      mine: true,
      scope: { kind: 'database', db: 'shop' },
      connectionId: 'c1',
      masked: false,
      anonymous: false,
    },
    {
      key: 'mongo-manager/2026/09/mm-20260901-000000-bbbbbbbb.archive.gz',
      name: 'mm-20260901-000000-bbbbbbbb.archive.gz',
      size: 5000,
      createdAt: null,
      format: 'gzip',
      archived: true,
      state: 'foreign',
      copyId: null,
      sender: null,
      mine: false,
      scope: null,
      connectionId: null,
      masked: null,
      anonymous: null,
    },
  ],
  cursor: null,
}
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Backups card with destinations (phase 3d-3b V6)', () => {
  it('shows copy badges with retry, and sends to a destination', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [BACKUP]],
      'GET backups/usage': () => [200, { used: 1000, quota: 10_000, ttlHours: 24, chunkMb: 64 }],
      'GET backup-destinations': () => [200, DESTS],
      'POST backup-copies/k2/retry': () => [
        202,
        { job: { id: 'j2', kind: 'backup.send', state: 'running' } },
      ],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Offsite S3')
    expect(text).toContain('Not sent to NAS')
    button('Retry').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'backup-copies/k2/retry')).toBe(true)
  })

  it('switches to a destination, lists its backups with their states, and explains archived ones', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 10_000, ttlHours: 24, chunkMb: 64 }],
      'GET backup-destinations': () => [200, DESTS],
      'GET backup-destinations/d1/backups': () => [200, REMOTE],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[role="tab"][data-source="d1"]')!.click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('mm-20261003-120000-aaaaaaaa.mmbak')
    expect(text).toContain('alice')
    expect(text).toContain('From another installation')
    expect(text).toContain('Archived — thaw it (Thaw…) before restoring')
  })

  // Phase 3d-3b UI review: an unreachable destination showed "Something went wrong (…)".
  it('says why a destination cannot be listed, in the reader’s language', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 10_000, ttlHours: 24, chunkMb: 64 }],
      'GET backup-destinations': () => [200, DESTS],
      'GET backup-destinations/d1/backups': () => [
        400,
        { code: 'VALIDATION', message: 'connect ECONNREFUSED', details: { reason: 'connect' } },
      ],
    })
    i18n.global.locale.value = 'tr'
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[role="tab"][data-source="d1"]')!.click()
    await flushPromises()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Sunucuya ulaşılamıyor.')
    expect(alert?.textContent).not.toContain('ECONNREFUSED')
  })

  it('deletes a remote copy with a 5-second undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 10_000, ttlHours: 24, chunkMb: 64 }],
      'GET backup-destinations': () => [200, DESTS],
      'GET backup-destinations/d1/backups': () => [200, REMOTE],
      'DELETE backup-destinations/d1/backups/k1': () => [204],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    mountApp(ToastHost)
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[role="tab"][data-source="d1"]')!.click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-remote-row] [data-action="delete"]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await vi.advanceTimersByTimeAsync(5_100)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'backup-destinations/d1/backups/k1')).toBe(
      true,
    )
    vi.useRealTimers()
  })
})

// Phase 3d-3b UI review: the send dialog had no test, no word on what sending does, and a title
// that carried the whole file name.
describe('send dialog (V6)', () => {
  it('names the file, says what sending does, offers only where it is not yet, and sends', async () => {
    const { calls } = mockApi({
      'GET backup-destinations': () => [
        200,
        [
          ...DESTS,
          { id: 'd3', name: 'Archive', type: 'folder', level: 'send', policy: { encryptedOnly: true } },
        ],
      ],
      'POST backups/b1/send': () => [202, { job: { id: 'j3', kind: 'backup.send', state: 'running' } }],
    })
    const closed = vi.fn()
    mountApp(BackupSendSheet, { props: { backup: BACKUP, onClose: closed } })
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h2')!.textContent).toBe('Send to destinations')
    expect(dialog.textContent).toContain(BACKUP.name)
    // Final review C27: what is checked, without promising a read-back everywhere.
    expect(dialog.textContent).toContain('It counts as sent once its size matches')
    // Offsite S3 already holds a complete copy.
    expect(dialog.querySelector('[data-destination="d1"]')).toBeNull()
    dialog.querySelector<HTMLButtonElement>('[data-destination="d3"]')!.click()
    await flushPromises()
    button('Send').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'backups/b1/send')!.body).toEqual({
      destinationIds: ['d3'],
      deleteLocal: false,
    })
    expect(closed).toHaveBeenCalled()
  })
})
