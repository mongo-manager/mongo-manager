import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { DestinationSummary, PreflightCheck, RemoteBackup } from '@mongo-manager/shared'
import RemoteList from '../src/backup/RemoteList.vue'
import { useBackupError, useCheckText } from '../src/backup/checkText'
import { ApiError } from '../src/api/client'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { button } from './support/dom'

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

const DEST: DestinationSummary = {
  id: 'd1',
  name: 'Offsite S3',
  type: 's3',
  level: 'send',
  policy: { encryptedOnly: true },
}
const row = (over: Partial<RemoteBackup>): RemoteBackup => ({
  key: 'mongo-manager/2026/10/mm-20261003-120000-aaaaaaaa.mmbak',
  name: 'mm-20261003-120000-aaaaaaaa.mmbak',
  size: 1000,
  createdAt: Date.now() - 86_400_000,
  format: 'mmbak',
  archived: false,
  thaw: null,
  state: 'complete',
  copyId: 'k1',
  sender: 'me',
  mine: true,
  scope: { kind: 'database', db: 'shop', views: true },
  connectionId: 'c1',
  masked: false,
  anonymous: false,
  ...over,
})
const MINE = row({})
const THEIRS = row({
  key: 'mongo-manager/2026/10/mm-20261002-000000-cccccccc.mmbak',
  name: 'mm-20261002-000000-cccccccc.mmbak',
  copyId: 'k3',
  sender: 'bob',
  mine: false,
  state: 'incomplete',
  scope: { kind: 'server' },
})
const ARCHIVED = row({
  key: 'mongo-manager/2026/09/mm-20260901-000000-bbbbbbbb.archive.gz',
  name: 'mm-20260901-000000-bbbbbbbb.archive.gz',
  format: 'gzip',
  archived: true,
  state: 'foreign',
  copyId: null,
  sender: null,
  mine: false,
  scope: null,
  createdAt: null,
})
const OLDER = row({
  key: 'mongo-manager/2026/08/mm-20260801-000000-dddddddd.mmbak',
  name: 'mm-20260801-000000-dddddddd.mmbak',
  copyId: 'k4',
})

const names = () =>
  [...document.querySelectorAll('[data-remote-row]')].map((r) => r.querySelector('.font-mono')!.textContent)
const rowOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-remote-row]')].find((r) => r.textContent?.includes(name))
const deletes = (calls: Array<{ method: string; path: string }>) => calls.filter((c) => c.method === 'DELETE')

function mount(
  handlers: Record<string, Handler>,
  props: Partial<{ destination: DestinationSummary; db: string; canRestore: boolean }> = {},
) {
  const api = mockApi(handlers)
  mountApp(RemoteList, {
    props: { destination: DEST, connectionId: 'c1', db: 'shop', canRestore: true, ...props },
  })
  mountApp(ToastHost)
  return api
}
const list =
  (items: RemoteBackup[], cursor: string | null = null): Handler =>
  () => [200, { items, cursor }]

describe('a destination’s backups (phase 3d-3b V6)', () => {
  it('describes each backup and offers only what may be done with it', async () => {
    mount({ 'GET backup-destinations/d1/backups': list([MINE, THEIRS, ARCHIVED]) })
    await flushPromises()
    expect(names()).toEqual([MINE.name, THEIRS.name, ARCHIVED.name])
    const mine = rowOf(MINE.name)!
    expect(mine.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Encrypted')
    expect(mine.textContent).toContain('shop')
    expect(mine.textContent).toContain('Sent by me')
    expect(mine.querySelector('[data-action="restore"]')!.getAttribute('aria-label')).toBe(
      `Restore… ${MINE.name}`,
    )
    expect(mine.querySelector('[data-action="delete"]')).not.toBeNull()
    const theirs = rowOf(THEIRS.name)!
    expect(theirs.textContent).toContain('Incomplete')
    expect(theirs.textContent).toContain('Whole server')
    expect(theirs.textContent).toContain('Sent by bob')
    // An incomplete backup cannot be restored, and someone else's copy is not mine to delete.
    expect(theirs.querySelector('[data-action="restore"]')).toBeNull()
    expect(theirs.querySelector('[data-action="delete"]')).toBeNull()
    const archived = rowOf(ARCHIVED.name)!
    expect(archived.textContent).toContain('Scope unknown until opened')
    expect(archived.textContent).toContain('From another installation')
    expect(archived.querySelector('[role="img"]')).toBeNull()
    expect(archived.querySelector('[data-action="restore"]')).toBeNull()
    expect(archived.querySelector('[data-action="delete"]')).toBeNull()
  })

  it('lets an administrator delete anyone’s copy, and hides Restore from who may not restore', async () => {
    mount(
      { 'GET backup-destinations/d1/backups': list([MINE, THEIRS]) },
      { destination: { ...DEST, level: 'admin' }, canRestore: false },
    )
    await flushPromises()
    expect(rowOf(THEIRS.name)!.querySelector('[data-action="delete"]')).not.toBeNull()
    expect(document.querySelector('[data-action="restore"]')).toBeNull()
  })

  it('says so when the destination holds nothing', async () => {
    mount({ 'GET backup-destinations/d1/backups': list([]) })
    await flushPromises()
    expect(document.body.textContent).toContain('No backups at this destination yet.')
    expect(() => button('Load more')).toThrow()
  })

  it('names every refusal when the list cannot be read', async () => {
    mount({
      'GET backup-destinations/d1/backups': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'refused',
          details: { reason: 'refused', reasons: ['destination_unknown', 'some_new_code'] },
        },
      ],
    })
    await flushPromises()
    // UI redesign R3 leftovers: the kit's callout, its Retry beside the words.
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'A chosen destination is not available to you. some_new_code',
    )
  })

  it('loads the next page with the cursor, and stops when there is none', async () => {
    const cursors: Array<string | null> = []
    mount({
      'GET backup-destinations/d1/backups': (_b, url) => {
        const cursor = url.searchParams.get('cursor')
        cursors.push(cursor)
        return cursor === 'page-2'
          ? [200, { items: [OLDER], cursor: null }]
          : [200, { items: [MINE], cursor: 'page-2' }]
      },
    })
    await flushPromises()
    expect(names()).toEqual([MINE.name])
    button('Load more').click()
    await flushPromises()
    expect(cursors).toEqual([null, 'page-2'])
    expect(names()).toEqual([MINE.name, OLDER.name])
    expect(() => button('Load more')).toThrow()
  })

  it('keeps the list and says why when the next page fails', async () => {
    mount({
      'GET backup-destinations/d1/backups': (_b, url) =>
        url.searchParams.get('cursor')
          ? [400, { code: 'VALIDATION_ERROR', message: 'timeout', details: { reason: 'timeout' } }]
          : [200, { items: [MINE], cursor: 'page-2' }],
    })
    await flushPromises()
    button('Load more').click()
    await flushPromises()
    expect(names()).toEqual([MINE.name])
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'The destination did not answer in time.',
    )
    expect(button('Load more').disabled).toBe(false)
  })

  it('opens the restore dialog for the backup at its destination', async () => {
    mount({ 'GET backup-destinations/d1/backups': list([MINE]) })
    await flushPromises()
    rowOf(MINE.name)!.querySelector<HTMLButtonElement>('[data-action="restore"]')!.click()
    expect(useWorkspaceDialogs().current).toEqual({
      kind: 'backupRestore',
      connectionId: 'c1',
      db: 'shop',
      remote: { destinationId: 'd1', key: MINE.key, name: MINE.name },
    })
  })

  it('opens the restore dialog without a database when the list has none', async () => {
    mount({ 'GET backup-destinations/d1/backups': list([MINE]) }, { db: undefined })
    await flushPromises()
    rowOf(MINE.name)!.querySelector<HTMLButtonElement>('[data-action="restore"]')!.click()
    expect(useWorkspaceDialogs().current).not.toHaveProperty('db')
  })
})

describe('destination checks and refusals in words (phase 3d-3b V5)', () => {
  function texts() {
    let out!: { check: ReturnType<typeof useCheckText>; error: ReturnType<typeof useBackupError> }
    mountApp(
      defineComponent(() => {
        out = { check: useCheckText(), error: useBackupError() }
        return () => h('div')
      }),
    )
    return out
  }
  const dest = (level: PreflightCheck['level'], params: PreflightCheck['params']): PreflightCheck => ({
    key: 'destination',
    level,
    ...(params ? { params } : {}),
  })

  it('names the destination a backup goes to, and what it refuses', () => {
    const { check } = texts()
    expect(check(dest('ok', { name: 'Offsite S3' }))).toBe('Will be sent to Offsite S3')
    expect(check(dest('block', { name: 'Offsite S3', reason: 'encrypted_only' }))).toBe(
      'Offsite S3 accepts encrypted backups only',
    )
    expect(check(dest('block', { name: 'NAS', reason: 'personal_plain' }))).toBe(
      'NAS: an unencrypted backup with personal data cannot leave the server',
    )
    expect(check(dest('block', { reason: 'unknown' }))).toBe('A chosen destination is not available to you')
  })

  // Twelfth review of explain masking (I3): sizes hidden where rules hide personal data.
  it('says a backup’s size is hidden, and weighs the free space without it', () => {
    const { check } = texts()
    expect(check({ key: 'size', level: 'ok', params: { hidden: 1 } })).toBe(
      'The size is hidden: rules hide personal data in this backup from you',
    )
    expect(check({ key: 'quota', level: 'ok', params: { room: 2048, hidden: 1 } })).toBe(
      'Your free space: 2 KB',
    )
    expect(check({ key: 'quota', level: 'block', params: { room: 2048, hidden: 1 } })).toBe(
      'Not enough space: 2 KB free',
    )
  })

  // Backup review I4, M1: a cap the target keeps, and why mongorestore cannot keep its settings.
  it('says a target keeps its own cap, and that mongorestore cannot keep a target’s settings', () => {
    const { check } = texts()
    expect(check({ key: 'capped', level: 'warn', params: { names: 'shop.log' } })).toBe(
      'shop.log: the target’s own cap applies. A restore holding more than it keeps fails before anything is replaced.',
    )
    expect(check({ key: 'tools', level: 'block', params: { reason: 'keeps_own' } })).toContain(
      'mongorestore cannot keep a replaced target’s own indexes or options',
    )
  })

  // MongoDB 9.0 (local run, 2026-10-20): a newer server's series options an older target may refuse.
  it('names the options mongorestore would pass that the target may not take, in both languages', () => {
    const { check } = texts()
    const c: PreflightCheck = {
      key: 'tools',
      level: 'block',
      params: { reason: 'newer_options', fields: 'fixedBucketing' },
    }
    expect(check(c)).toBe(
      'The MongoDB tools cannot be used: This backup has options or indexes the target may not take (fixedBucketing), and mongorestore passes them as they are. Use the built-in engine, which leaves out what the target lacks.',
    )
    i18n.global.locale.value = 'tr'
    expect(check(c)).toContain('(fixedBucketing)')
    // Review of 182c2882: into an existing time series.
    i18n.global.locale.value = 'en'
    expect(check({ key: 'tools', level: 'block', params: { reason: 'series_exists' } })).toBe(
      'The MongoDB tools cannot be used: mongorestore cannot write into an existing time series: use the built-in engine, or restore it under a new name.',
    )
    // Review of 8e719ba7 (I-3): a time series without its options.
    i18n.global.locale.value = 'en'
    expect(check({ key: 'tools', level: 'block', params: { reason: 'series_without_options' } })).toBe(
      'The MongoDB tools cannot be used: mongorestore cannot restore a time series without its collection options: restore the options, or use the built-in engine.',
    )
  })

  it('turns a refused start into one sentence per reason, and a destination reason into words', () => {
    const { error } = texts()
    const refused = (details: unknown) => new ApiError(400, 'VALIDATION_ERROR', 'raw provider text', details)
    expect(
      error(
        refused({ reason: 'refused', reasons: ['destination_encrypted_only', 'destination_personal_plain'] }),
      ),
    ).toEqual([
      'A chosen destination accepts encrypted backups only.',
      'An unencrypted backup with personal data cannot leave the server.',
    ])
    expect(error(refused({ reason: 'backup_busy' }))).toEqual([
      'You already have two backups or restores running.',
    ])
    expect(error(refused({ reason: 'quota' }))).toEqual(['The destination is full.'])
    expect(error(refused({ reason: 'reconnect' }))).toEqual([
      'Google no longer accepts this connection; connect the account again.',
    ])
    // A reason the page does not know never shows the server's raw text.
    expect(error(refused({ reason: 'brand_new' }))).toEqual(['Please check the entered values.'])
    expect(error(new TypeError('Failed to fetch'))).toEqual([
      'Cannot reach Mongo Manager. Check that the server is running.',
    ])
  })
})

describe('deleting a remote copy (phase 3d-3b V6, U10)', () => {
  it('hides the row at once, and an Undo within five seconds sends nothing', async () => {
    const { calls } = mount({
      'GET backup-destinations/d1/backups': list([MINE, OLDER]),
      'DELETE backup-destinations/d1/backups/k1': () => [204],
    })
    await flushPromises()
    rowOf(MINE.name)!.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await flushPromises()
    expect(names()).toEqual([OLDER.name])
    expect(document.body.textContent).toContain('Deleted from Offsite S3')
    button('Undo').click()
    await flushPromises()
    expect(names()).toEqual([MINE.name, OLDER.name])
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(deletes(calls)).toEqual([])
    // Leaving the page later does not send the cancelled delete either.
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(deletes(calls)).toEqual([])
  })

  it('sends the delete when the toast closes, then reads the list again', async () => {
    let gone = false
    const { calls } = mount({
      'GET backup-destinations/d1/backups': () => [
        200,
        { items: gone ? [OLDER] : [MINE, OLDER], cursor: null },
      ],
      'DELETE backup-destinations/d1/backups/k1': () => {
        gone = true
        return [204]
      },
    })
    await flushPromises()
    rowOf(MINE.name)!.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await flushPromises()
    const reads = calls.filter((c) => c.method === 'GET').length
    await vi.advanceTimersByTimeAsync(5_100)
    await flushPromises()
    expect(deletes(calls).map((c) => c.path)).toEqual(['backup-destinations/d1/backups/k1'])
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(reads)
    expect(names()).toEqual([OLDER.name])
  })

  it('sends the delete with keepalive when the page closes, and only once', async () => {
    const { calls, fetchMock } = mount({
      'GET backup-destinations/d1/backups': list([MINE]),
      'DELETE backup-destinations/d1/backups/k1': () => [204],
    })
    await flushPromises()
    rowOf(MINE.name)!.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await flushPromises()
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(deletes(calls)).toHaveLength(1)
    const init = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')![1]
    expect((init as RequestInit).keepalive).toBe(true)
    await vi.advanceTimersByTimeAsync(6_000)
    await flushPromises()
    expect(deletes(calls)).toHaveLength(1)
  })

  it('brings the row back and says why when the delete is refused', async () => {
    const { calls } = mount({
      'GET backup-destinations/d1/backups': list([MINE]),
      'DELETE backup-destinations/d1/backups/k1': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'AccessDenied', details: { reason: 'forbidden' } },
      ],
    })
    await flushPromises()
    rowOf(MINE.name)!.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await flushPromises()
    expect(names()).toEqual([])
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await flushPromises()
    expect(deletes(calls)).toHaveLength(1)
    expect(names()).toEqual([MINE.name])
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('The credentials may not do this here.')
    expect(alert.textContent).not.toContain('AccessDenied')
  })
})
