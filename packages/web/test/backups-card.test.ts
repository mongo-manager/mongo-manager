// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { BackupView, JobView } from '@mongo-manager/shared'
import BackupsCard from '../src/backup/BackupsCard.vue'
import JobRow from '../src/jobs/JobRow.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { useJobsStore } from '../src/jobs/store'
import { useJobOutcomes } from '../src/jobs/outcomes'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const NOW = Date.now()
const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [{ id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true }]
const B = (over: Partial<BackupView>): BackupView => ({
  id: 'b1',
  name: 'shop-20261003-143005.mmbak',
  jobId: 'j1',
  connectionId: 'c1',
  scope: { kind: 'database', db: 'shop', views: true },
  engine: 'builtin',
  format: 'mmbak',
  masked: false,
  anonymous: false,
  size: 5_000_000,
  sha256: 'x',
  namespaces: 4,
  startedAt: NOW - 3 * 3600_000,
  finishedAt: NOW - 3 * 3600_000 + 60_000,
  expiresAt: NOW + 21 * 3600_000,
  copies: [],
  ...over,
})
// The card and the toasts its undo lives in, as the workspace shows them.
/** A backup's row menu (UI redesign R3 leftovers: its actions are a "…" menu), opened. */
async function rowMenu(name: string): Promise<HTMLElement[]> {
  document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click()
  await flushPromises()
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}
async function chooseIn(name: string, item: string): Promise<void> {
  const items = await rowMenu(name)
  items.find((i) => i.textContent?.trim() === item)!.click()
  await flushPromises()
}

const WithToasts = defineComponent({
  props: { connectionId: { type: String, required: true }, db: { type: String, default: undefined } },
  setup: (props) => () => [h(BackupsCard, props), h(ToastHost)],
})

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Backups section (U9, U10)', () => {
  it('shows an empty state that explains and offers the first backup', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(document.body.textContent).toContain('No backups yet')
    expect(document.body.textContent).toContain('Files stay for 24 hours')
    button('Take the first backup').click()
    expect(useWorkspaceDialogs().current).toEqual({ kind: 'backupDump', connectionId: 'c1', db: 'shop' })
  })

  // UI review of R3–R5 (spec §2): a module's title in the cards' measure, and its figures one row in
  // one box with hairlines between them, not a box per figure.
  it('titles the module as the other cards do and shows its figures as one row', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(document.querySelector('h3')!.className).toContain('text-ui')
    const figures = document.querySelector('[data-backup-figures]')!
    expect(figures.children).toHaveLength(3)
    expect(figures.className).toContain('divide-x')
    expect([...figures.children].some((c) => c.className.includes('bg-subtle'))).toBe(false)
  })

  // Phase 3d-3b UI review: a backup that ended after the card's clock last ticked (or on a server
  // whose clock runs a little ahead) read "Last backup: in 4 seconds".
  it('never dates a finished backup in the future', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [B({ finishedAt: Date.now() + 4000, startedAt: Date.now() })]],
      'GET backups/usage': () => [200, { used: 5_000_000, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/in \d+ seconds?/)
    expect(text).toContain('now')
  })

  it('offers only what the user may do on this connection', async () => {
    mockApi({
      'GET connections': () => [200, [{ ...CONNS[0], permissions: ['documents:read'], export: false }]],
      'GET backups': () => [200, []],
      'GET backups/usage': () => [200, { used: 0, quota: 1, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1' } })
    await flushPromises()
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).not.toContain('Take the first backup')
    expect(labels).not.toContain('Restore…')
  })

  it("lists this database's backups with flags, relative times and storage, and filters them", async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [
        200,
        [
          B({}),
          B({
            id: 'b2',
            name: 'other.archive.gz',
            format: 'gzip',
            scope: { kind: 'database', db: 'other', views: true },
          }),
          B({ id: 'b3', name: 'server.archive.gz', format: 'gzip', masked: true, scope: { kind: 'server' } }),
        ],
      ],
      'GET backups/usage': () => [200, { used: 15_000_000, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    const rows = [...document.querySelectorAll('[data-backup-row]')].map((r) => r.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('shop-20261003-143005.mmbak')
    expect(document.body.textContent).toContain('3 hours ago')
    expect(document.body.textContent).toMatch(/in 21 hours/)
    // Final review minor 13: each row's actions say which backup they act on — now its "…" menu's
    // name, with Delete in danger colour and the download the browser's own (UI redesign R3 leftovers).
    const items = await rowMenu('shop-20261003-143005.mmbak')
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Download', 'Restore…', 'Delete'])
    expect(items[2]!.className).toContain('text-danger')
    const clicked: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(`${this.getAttribute('href')} ${this.hasAttribute('download')}`)
    })
    items[0]!.click()
    await flushPromises()
    expect(clicked).toEqual([expect.stringMatching(/\/api\/backups\/b1\/download true$/)])
    click.mockRestore()
    button('Encrypted').click()
    await flushPromises()
    expect(document.querySelectorAll('[data-backup-row]')).toHaveLength(1)
    expect(button('Encrypted').getAttribute('aria-pressed')).toBe('true')
    // Final review minor 11 (U9): by scope too.
    button('Encrypted').click()
    await flushPromises()
    button('Server').click()
    await flushPromises()
    expect([...document.querySelectorAll('[data-backup-row]')].map((r) => r.textContent)).toEqual([
      expect.stringContaining('server.archive.gz'),
    ])
  })

  it('deletes with a 5-second undo (U10)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [B({})]],
      'GET backups/usage': () => [200, { used: 5_000_000, quota: 20 * 1024 ** 3, ttlHours: 24 }],
      'DELETE backups/b1': () => [204, undefined],
    })
    mountApp(WithToasts, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    await chooseIn('shop-20261003-143005.mmbak', 'Delete')
    expect(document.querySelectorAll('[data-backup-row]')).toHaveLength(0)
    button('Undo').click()
    await flushPromises()
    expect(document.querySelectorAll('[data-backup-row]')).toHaveLength(1)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await chooseIn('shop-20261003-143005.mmbak', 'Delete')
    await vi.advanceTimersByTimeAsync(6000)
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'backups/b1')).toBe(true)
  })
})

// Review of the Monitoring redesign (minor): a deleted row takes the focus with it; focus goes to
// the next backup's menu, or to the card's title when none is left. The sort says what it is.
describe('after a delete', () => {
  it('moves the focus to the next row, then to the title', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [B({}), B({ id: 'b2', name: 'shop-older.mmbak', finishedAt: NOW - 9e6 })]],
      'GET backups/usage': () => [200, { used: 5_000_000, quota: 20 * 1024 ** 3, ttlHours: 24 }],
    })
    mountApp(WithToasts, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    expect(document.querySelector('[data-backup-sort] svg')).not.toBeNull()
    await chooseIn('shop-20261003-143005.mmbak', 'Delete')
    await flushPromises()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for shop-older.mmbak')
    await chooseIn('shop-older.mmbak', 'Delete')
    await flushPromises()
    expect(document.activeElement?.tagName).toBe('H3')
    expect(document.activeElement?.textContent).toContain('Backups')
  })
})

describe('leaving the page (final review minor 4)', () => {
  it('sends a pending delete with keepalive, so the browser does not drop it', async () => {
    const { fetchMock } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups': () => [200, [B({})]],
      'GET backups/usage': () => [200, { used: 5, quota: 10, ttlHours: 24, chunkMb: 64 }],
      'DELETE backups/b1': () => [204, undefined],
    })
    mountApp(WithToasts, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    await chooseIn('shop-20261003-143005.mmbak', 'Delete')
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    const del = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(del).toBeTruthy()
    expect((del![1] as RequestInit).keepalive).toBe(true)
  })
})

describe('backup job rows (U8)', () => {
  const job = (over: Partial<JobView>): JobView =>
    ({
      id: 'j1',
      kind: 'backup.dump',
      state: 'done',
      connectionId: 'c1',
      db: 'shop',
      coll: '*',
      target: 'shop.mmbak',
      targetConnectionId: null,
      progress: null,
      estimate: null,
      error: null,
      startedAt: NOW - 1000,
      finishedAt: NOW,
      mine: true,
      cancellable: false,
      ...over,
    }) as JobView

  it('offers the finished backup for download and restore, and shows its report', async () => {
    mockApi({
      'GET transfer/jobs/j1/report': () => [
        200,
        {
          kind: 'dump',
          backupId: 'b9',
          size: 2048,
          namespaces: [
            {
              db: 'shop',
              coll: 'orders',
              type: 'collection',
              written: 12,
              documents: 12,
              bytes: 1,
              ttl: [],
              personal: [],
              note: 'Its validator holds values that would be masked',
            },
          ],
        },
      ],
    })
    mountApp(JobRow, { props: { job: job({}), now: NOW } })
    await flushPromises()
    expect(document.querySelector('a[download]')!.getAttribute('href')).toMatch(
      /\/api\/backups\/b9\/download$/,
    )
    button('Restore…').click()
    expect(useWorkspaceDialogs().current).toEqual({
      kind: 'backupRestore',
      connectionId: 'c1',
      backupId: 'b9',
    })
    button('Report').click()
    await flushPromises()
    expect(document.body.textContent).toContain('shop.orders')
    expect(document.body.textContent).toContain('12 documents')
    expect(document.body.textContent).toContain('Its validator holds values that would be masked')
  })

  it('shows a restore report with its checksum and rejected records', async () => {
    mockApi({
      'GET transfer/jobs/j2/report': () => [
        200,
        {
          kind: 'restore',
          dryRun: false,
          namespaces: [
            {
              from: 'shop.orders',
              to: 'shop2.orders',
              read: 3,
              inserted: 2,
              upserted: 0,
              modified: 0,
              failed: 1,
              alreadyThere: 5,
              expiring: 2,
              crc: 'ok',
            },
          ],
          views: [{ name: 'shop2.v', created: false, reason: 'Its pipeline writes' }],
          rejectedFile: true,
        },
      ],
    })
    mountApp(JobRow, {
      props: { job: job({ id: 'j2', kind: 'backup.restore', target: 'x.archive' }), now: NOW },
    })
    await flushPromises()
    button('Report').click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('shop.orders → shop2.orders')
    expect(text).toContain('Checksum verified')
    expect(text).toContain('Its pipeline writes')
    // Backup review M9: a restore run again says what was already there.
    expect(text).toContain('5 already there')
    // Backup review M10: what a TTL index deleted as soon as it was written.
    expect(text).toContain('2 deleted at once by a TTL index')
    expect(document.querySelector('a[download]')!.getAttribute('href')).toMatch(
      /\/api\/transfer\/jobs\/j2\/rejected$/,
    )
  })
  // Review M3: a dry run deleted nothing: it says what would be.
  it('says in a dry run what a TTL index would delete', async () => {
    mockApi({
      'GET transfer/jobs/j3/report': () => [
        200,
        {
          kind: 'restore',
          dryRun: true,
          namespaces: [
            { from: 'shop.ev', to: 'shop.ev', read: 3, inserted: 0, failed: 0, expiring: 3, crc: 'ok' },
          ],
          views: [],
          rejectedFile: false,
        },
      ],
    })
    mountApp(JobRow, {
      props: { job: job({ id: 'j3', kind: 'backup.restore', target: 'x.archive' }), now: NOW },
    })
    await flushPromises()
    button('Report').click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('3 would be deleted at once by a TTL index')
    expect(text).not.toContain('3 deleted at once')
  })
})

describe('backup job outcomes (U8)', () => {
  const Outcomes = defineComponent(() => {
    useJobOutcomes()
    return () => h('div')
  })
  const running = (over: Partial<JobView>): JobView =>
    ({
      id: 'k1',
      kind: 'backup.dump',
      state: 'running',
      connectionId: 'c1',
      db: 'shop',
      coll: '*',
      target: 'shop.mmbak',
      targetConnectionId: null,
      progress: null,
      estimate: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      mine: true,
      cancellable: true,
      ...over,
    }) as JobView

  it('says a backup is ready, refreshes the list, and offers the download', async () => {
    mockApi({ 'GET transfer/jobs/k1/report': () => [200, { kind: 'dump', backupId: 'b5', namespaces: [] }] })
    const { queryClient } = mountApp(Outcomes)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const store = useJobsStore()
    const toasts = useToastStore()
    store.upsert(running({}))
    store.upsert(running({ state: 'done', finishedAt: Date.now() }))
    expect(toasts.toasts.at(-1)?.message).toBe('Backup ready: shop.mmbak')
    // W4.4: and its report.
    expect(toasts.toasts.at(-1)?.actions?.map((a) => a.label)).toEqual(['Download', 'Open report'])
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['backups'] })
    store.upsert(running({ id: 'k2', kind: 'backup.restore', target: 'x.archive' }))
    store.upsert(
      running({ id: 'k2', kind: 'backup.restore', target: 'x.archive', state: 'failed', error: 'boom' }),
    )
    expect(toasts.toasts.at(-1)?.message).toBe('Restore failed: x.archive: boom')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connections', 'c1', 'databases'] })
  })

  it('asks once about notifications when a backup runs past a minute, never at load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const requestPermission = vi.fn(async () => 'granted')
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission }))
    localStorage.removeItem('mm.notify.asked')
    mountApp(Outcomes)
    const toasts = useToastStore()
    const store = useJobsStore()
    store.upsert(running({ startedAt: Date.now() }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(toasts.toasts.some((t) => t.message.includes('notification'))).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    const ask = toasts.toasts.find((t) => t.message.includes('notification'))!
    expect(ask.actions?.map((a) => a.label)).toEqual(['Notify me', 'Not now'])
    toasts.runAction(ask.id, 0)
    await flushPromises()
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('mm.notify.asked')).toBe('1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(toasts.toasts.filter((t) => t.message.includes('notification'))).toHaveLength(0)
  })
})
