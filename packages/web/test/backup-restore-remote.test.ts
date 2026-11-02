import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { JobView } from '@mongo-manager/shared'
import BackupRestoreSheet from '../src/backup/BackupRestoreSheet.vue'
import { useJobsStore } from '../src/jobs/store'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const CONNS = [
  {
    id: 'c1',
    name: 'Prod',
    access: 'editor',
    permissions: ['documents:read', 'documents:write', 'jobs:run'],
    export: true,
  },
]
const DESTS = [{ id: 'd1', name: 'Offsite S3', type: 's3', level: 'send', policy: { encryptedOnly: true } }]
const KEY = 'mongo-manager/2026/10/mm-20261003-120000-aaaaaaaa.archive.gz'
const JOB: JobView = {
  id: 'jf',
  kind: 'backup.fetch',
  state: 'running',
  connectionId: 'c1',
  db: '*',
  coll: '*',
  target: 'x',
  targetConnectionId: null,
  progress: { done: 620, total: 1000 },
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
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

describe('restore from a destination (phase 3d-3b V7)', () => {
  it('fetches the picked backup, previews it as it arrives, and starts only once it is verified', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backup-destinations': () => [200, DESTS],
      'GET backup-destinations/d1/backups': () => [
        200,
        {
          items: [
            {
              key: KEY,
              name: 'mm-20261003-120000-aaaaaaaa.archive.gz',
              size: 1000,
              createdAt: 1,
              format: 'gzip',
              archived: false,
              state: 'complete',
              copyId: 'k1',
              sender: 'me',
              mine: true,
              scope: { kind: 'database', db: 'shop' },
              connectionId: 'c1',
              masked: false,
              anonymous: false,
            },
          ],
          cursor: null,
        },
      ],
      'POST backup-destinations/d1/backups/fetch': () => [
        202,
        { uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', job: JOB },
      ],
      'POST backups/inspect': () => [
        200,
        {
          state: 'ready',
          summary: {
            format: 'gzip',
            namespaces: [{ db: 'shop', coll: 'orders', type: 'collection', documents: null, bytes: null }],
            header: null,
          },
        },
      ],
    })
    const { wrapper } = mountApp(BackupRestoreSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    button('From a destination').click()
    await flushPromises()
    // UI review: the search said "Filter collections" while it filters backups.
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.placeholder).toBe(
      'Filter backups',
    )
    document.querySelector<HTMLButtonElement>('[data-remote-pick]')!.click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'backup-destinations/d1/backups/fetch')!.body).toEqual({
      connectionId: 'c1',
      key: KEY,
    })
    await vi.advanceTimersByTimeAsync(1100)
    await flushPromises()
    expect(document.body.textContent).toContain('Waiting for the download (62%)')
    useJobsStore().upsert({ ...JOB, state: 'done', progress: { done: 1000, total: 1000 }, finishedAt: 2 })
    await flushPromises()
    expect(document.body.textContent).not.toContain('Waiting for the download')
    wrapper.unmount()
    await flushPromises()
  })

  it('opens straight on a backup picked in the Backups card', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backup-destinations': () => [200, DESTS],
      'POST backup-destinations/d1/backups/fetch': () => [
        202,
        { uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', job: JOB },
      ],
      'POST backups/inspect': () => [200, { state: 'waiting', received: 100 }],
    })
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: KEY, name: 'x.archive.gz' } },
    })
    await flushPromises()
    expect(calls.some((c) => c.path === 'backup-destinations/d1/backups/fetch')).toBe(true)
    wrapper.unmount()
    await flushPromises()
  })

  it('says a failed download plainly', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backup-destinations': () => [200, DESTS],
      'POST backup-destinations/d1/backups/fetch': () => [
        202,
        { uploadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', job: JOB },
      ],
      'POST backups/inspect': () => [200, { state: 'waiting', received: 0 }],
    })
    const { wrapper } = mountApp(BackupRestoreSheet, {
      props: { connectionId: 'c1', remote: { destinationId: 'd1', key: KEY, name: 'x.archive.gz' } },
    })
    await flushPromises()
    useJobsStore().upsert({
      ...JOB,
      state: 'failed',
      error: 'The downloaded file differs from the one that was sent; it was removed',
      finishedAt: 2,
    })
    await flushPromises()
    expect(document.body.textContent).toContain('The downloaded file differs from the one that was sent')
    wrapper.unmount()
    await flushPromises()
  })
})
