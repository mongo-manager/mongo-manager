import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { LIVE_SYNC_REASONS, LIVE_SYNC_STATES, type LiveSyncsList } from '@mongo-manager/shared'
import LiveSyncsView from '../src/livesync/LiveSyncsView.vue'
import AppSidebar from '../src/workspace/AppSidebar.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { applyGone, applyUpdate } from '../src/livesync/useLiveSyncs'
import { liveSyncKeys } from '../src/api/liveSync'
import { useJobsStore } from '../src/jobs/store'
import { useSessionStore } from '../src/stores/session'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'
import { SYNC } from './support/livesync'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 5, 12))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const list =
  (syncs: ReturnType<typeof SYNC>[], extra: Partial<LiveSyncsList> = {}) =>
  () =>
    [200, { enabled: true, max: 10, perUser: 3, syncs, ...extra }] as [number, unknown]
const card = (id: string) => document.querySelector<HTMLElement>(`[data-sync="${id}"]`)!
const signIn = (role: 'admin' | 'editor' = 'editor') => {
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = { mode: 'team', user: { id: 'u1', username: 'ada', role }, permissions: [] } as never
}

describe('the Live syncs tab (phase 3e-2 spec §5)', () => {
  it('shows a sync as source ⇄ target, its state in words and icon, its lag, counters and last change', async () => {
    mockApi({ 'GET live-syncs': list([SYNC()]) })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    const c = card('ls1')
    expect(c.textContent).toContain('Production')
    expect(c.textContent).toContain('Reporting')
    expect(c.textContent).toContain('shop.orders')
    const pill = c.querySelector('[data-state]')!
    expect(pill.textContent).toContain('Live')
    expect(pill.querySelector('svg')).not.toBeNull()
    expect(c.textContent).toContain('less than 2 s behind')
    // The term comes first in the markup (m17); the value shows on top.
    expect(c.textContent).toMatch(/inserted\s*1,204/i)
    expect(c.textContent).toMatch(/replaced\s*77/i)
    expect(c.textContent).toContain('1 minute ago')
  })

  it('names both sides on their own rows, says when the copy finished, and draws the lag as a sparkline', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC(),
        SYNC({ id: 'done', state: 'completed', finishedAt: Date.UTC(2026, 9, 5, 11, 30) }),
      ]),
    })
    signIn()
    const { queryClient } = mountApp(LiveSyncsView)
    await flushPromises()
    const c = card('ls1')
    expect(c.querySelector('[data-from]')!.textContent).toMatch(/From.*Production.*shop\.orders/)
    expect(c.querySelector('[data-to]')!.textContent).toMatch(/To.*Reporting.*shop\.orders/)
    expect(c.textContent).toContain('Initial copy finished 2 hours ago')
    expect(card('done').textContent).toContain('Finished 30 minutes ago')
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 0, 5))
    applyUpdate(queryClient, SYNC({ counters: { ...SYNC().counters, lagMs: 3100 } }))
    vi.setSystemTime(Date.UTC(2026, 9, 5, 12, 0, 10))
    applyUpdate(queryClient, SYNC({ counters: { ...SYNC().counters, lagMs: 400 } }))
    await flushPromises()
    const spark = c.querySelector('[data-lag]')!
    expect(spark.getAttribute('role')).toBe('img')
    expect(spark.getAttribute('aria-label')).toBe(
      'How far behind, last 10 minutes: now 0.4 sec, at most 3.1 sec',
    )
    expect(spark.querySelector('polyline')).not.toBeNull()
  })

  it('never puts a past moment in the future when the page’s clock lags the server’s', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({
          state: 'completed',
          finishedAt: Date.UTC(2026, 9, 5, 12, 0, 3),
          counters: { ...SYNC().counters, lastEventAt: Date.UTC(2026, 9, 5, 12, 0, 2) },
        }),
      ]),
    })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    expect(card('ls1').textContent).toContain('Finished now')
    expect(card('ls1').textContent).toContain('Last change applied now')
  })

  it('says each state with its words, never colour alone', async () => {
    const syncs = LIVE_SYNC_STATES.map((state, i) =>
      SYNC({ id: `s${i}`, state, reason: state === 'attention' ? 'write_error' : null }),
    )
    mockApi({ 'GET live-syncs': list(syncs) })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    for (const [i, state] of LIVE_SYNC_STATES.entries()) {
      const pill = card(`s${i}`).querySelector<HTMLElement>('[data-state]')!
      expect(pill.dataset.state).toBe(state)
      expect(pill.textContent?.trim()).toBe(i18n.global.t(`liveSync.state.${state}`))
      expect(pill.querySelector('svg')).not.toBeNull()
    }
  })

  it('shows the copy’s progress, the time behind, the next attempt and the reason with its action', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'copy', state: 'copying', copyJobId: 'j1', copiedAt: null }),
        SYNC({ id: 'behind', state: 'catching_up', counters: { ...SYNC().counters, lagMs: 42_000 } }),
        SYNC({
          id: 'retry',
          state: 'retrying',
          detail: 'connection',
          retryAt: Date.UTC(2026, 9, 5, 12, 0, 30),
        }),
        SYNC({
          id: 'write',
          state: 'attention',
          reason: 'write_error',
          detail: '{"$numberInt":"7"} · code 11000',
        }),
        SYNC({ id: 'gone', state: 'attention', reason: 'source_gone', detail: 'shop.orders' }),
        SYNC({ id: 'lost', state: 'failed', reason: 'history_lost' }),
      ]),
    })
    signIn()
    mountApp(LiveSyncsView)
    useJobsStore().upsert({
      id: 'j1',
      state: 'running',
      progress: { done: 1_200_000, total: 2_800_000 },
    } as never)
    await flushPromises()
    expect(card('copy').textContent).toMatch(/Copying 43%\s*·\s*1\.2M of 2\.8M/)
    expect(card('copy').querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('43')
    // Review of the Monitoring redesign (minor): without a figure the bar says what is known.
    useJobsStore().upsert({ id: 'j1', state: 'running', progress: null } as never)
    await flushPromises()
    expect(card('copy').querySelector('[role="progressbar"]')!.getAttribute('aria-valuetext')).toBe(
      'Copying; how far is not known yet',
    )
    useJobsStore().upsert({
      id: 'j1',
      state: 'running',
      progress: { done: 1_200_000, total: 2_800_000 },
    } as never)
    await flushPromises()
    expect(card('behind').textContent).toContain('42 sec behind')
    expect(card('retry').textContent).toContain('Next attempt in 30 seconds')
    expect(card('write').textContent).toContain('The target refused a document')
    expect(card('write').textContent).toContain('code 11000')
    expect([...card('write').querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(
      expect.arrayContaining(['Skip this document', 'Try again']),
    )
    expect(card('gone').textContent).toContain('The source collection was dropped or renamed')
    expect(
      [...card('gone').querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Start again'),
    ).toBe(true)
    expect(card('lost').textContent).toContain('no longer reaches')
  })

  it('offers each action by state and right: finish only to the owner, nothing to resume an administrator’s pause', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'mine' }),
        SYNC({ id: 'theirs', mine: false, owner: 'bob' }),
        SYNC({ id: 'held', state: 'paused', reason: 'admin', pausedBy: 'admin:root' }),
      ]),
    })
    signIn('editor')
    mountApp(LiveSyncsView)
    await flushPromises()
    const labels = (id: string) => [...card(id).querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels('mine')).toEqual(expect.arrayContaining(['Pause', 'Verify', 'Finish…']))
    expect(labels('theirs')).not.toContain('Finish…')
    expect(card('held').textContent).toContain('Paused by an administrator (root)')
    expect(labels('held')).not.toContain('Resume')
  })

  it('pauses, verifies, finishes with a verification, stops and deletes', async () => {
    const { calls } = mockApi({
      'GET live-syncs': list([SYNC(), SYNC({ id: 'done', state: 'stopped', reason: 'owner' })]),
      'POST live-syncs/ls1/pause': () => [200, SYNC({ state: 'paused', reason: 'owner', pausedBy: 'owner' })],
      'POST live-syncs/ls1/verify': () => [200, SYNC()],
      'POST live-syncs/ls1/finish': () => [200, SYNC({ state: 'cutting_over' })],
      'POST live-syncs/ls1/stop': () => [200, SYNC({ state: 'stopped' })],
      'DELETE live-syncs/done': () => [204],
    })
    signIn()
    mountApp(LiveSyncsView)
    mountApp(DialogHost)
    mountApp(ToastHost)
    await flushPromises()
    const press = async (id: string, label: string) => {
      ;[...card(id).querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click()
      await flushPromises()
    }
    const menu = async (id: string, label: string) => {
      card(id).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent?.trim() === label)!
        .click()
      await flushPromises()
    }
    await press('ls1', 'Pause')
    await press('ls1', 'Verify')
    await press('ls1', 'Finish…')
    expect(document.body.textContent).toContain('Stop writes to the source')
    button('Finish now').click()
    await flushPromises()
    await menu('ls1', 'Stop…')
    button('Stop the sync').click()
    await flushPromises()
    await menu('done', 'Delete…')
    button('Delete').click()
    await flushPromises()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'POST live-syncs/ls1/pause',
        'POST live-syncs/ls1/verify',
        'POST live-syncs/ls1/finish',
        'POST live-syncs/ls1/stop',
        'DELETE live-syncs/done',
      ]),
    )
    expect(calls.find((c) => c.path === 'live-syncs/ls1/finish')!.body).toEqual({ verify: true })
  })

  it('shows the last verification on the card', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({
          verify: {
            state: 'done',
            startedAt: Date.UTC(2026, 9, 5, 11, 40),
            finishedAt: Date.UTC(2026, 9, 5, 11, 41),
            pairs: [
              {
                source: 'orders',
                target: 'orders',
                same: 1_204_331,
                different: 0,
                onlySource: 0,
                onlyTarget: 0,
                unsettled: 0,
                ids: [],
              },
            ],
          },
        }),
      ]),
    })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    expect(card('ls1').textContent).toMatch(/Verified .*1,204,331 same, 0 different/)
  })

  it('explains live syncs when there is none, and says when the server turned them off', async () => {
    mockApi({ 'GET live-syncs': list([], { enabled: false }) })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    expect(document.body.textContent).toContain('Keep a copy current')
    expect(document.body.textContent).toContain('Live sync is turned off on this server')
  })

  it('opens the wizard for a new sync, and for a review or a fresh start of an existing one', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'rv', state: 'attention', reason: 'connection_changed' }),
        SYNC({ id: 'again', state: 'failed', reason: 'history_lost' }),
      ]),
    })
    signIn()
    mountApp(LiveSyncsView)
    await flushPromises()
    const dialogs = useWorkspaceDialogs()
    ;[...card('rv').querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Review…')!.click()
    expect(dialogs.current).toMatchObject({ kind: 'liveSync', review: 'rv', connectionId: 'c1' })
    ;[...card('again').querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Start again')!
      .click()
    expect(dialogs.current).toMatchObject({
      kind: 'liveSync',
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
      // Final review m16: the target holds the old sync's documents: merge into them, in its place.
      preset: {
        target: { connectionId: 'c2', db: 'shop', coll: 'orders' },
        startMode: 'merge',
        replaces: 'again',
      },
    })
  })
})

describe('updates from the livesync channel (plan ruling 15)', () => {
  it('replaces a sync, adds a new one first and removes a gone one', async () => {
    mockApi({ 'GET live-syncs': list([SYNC()]) })
    signIn()
    const { queryClient } = mountApp(LiveSyncsView)
    await flushPromises()
    applyUpdate(queryClient, SYNC({ state: 'paused', reason: 'owner' }))
    applyUpdate(queryClient, SYNC({ id: 'new', createdAt: Date.UTC(2026, 9, 5, 11) }))
    await flushPromises()
    expect(card('ls1').querySelector('[data-state]')!.textContent).toContain('Paused')
    const data = queryClient.getQueryData<LiveSyncsList>(liveSyncKeys.list)!
    expect(data.syncs.map((s) => s.id)).toEqual(['new', 'ls1'])
    applyGone(queryClient, 'new')
    await flushPromises()
    expect(document.querySelector('[data-sync="new"]')).toBeNull()
  })
})

describe('the sidebar’s badge (spec §5; UI redesign R1 revision 2)', () => {
  it('counts the caller’s syncs that need attention', async () => {
    mockApi({
      'GET live-syncs': list([
        SYNC({ id: 'a', state: 'attention', reason: 'write_error' }),
        SYNC({ id: 'b', state: 'failed', reason: 'history_lost' }),
        SYNC({ id: 'c', state: 'attention', reason: 'write_error', mine: false }),
        SYNC({ id: 'd' }),
      ]),
      'GET backup-schedules': () => [200, { enabled: true, schedules: [] }],
    })
    signIn()
    mountApp(AppSidebar)
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      .find((b) => b.textContent?.includes('Automations'))!
      .click()
    await flushPromises()
    const item = document.querySelector<HTMLButtonElement>('button[aria-label^="Live syncs"]')!
    expect(item.textContent).toContain('2')
    expect(item.getAttribute('aria-label')).toBe('Live syncs, 2 live syncs need attention')
  })
})

describe('words (phase 3e-2 spec §2.3, §5)', () => {
  it('has every state and reason in English and Turkish', () => {
    for (const locale of ['en', 'tr'] as const) {
      i18n.global.locale.value = locale
      for (const s of LIVE_SYNC_STATES) expect(i18n.global.te(`liveSync.state.${s}`)).toBe(true)
      for (const r of LIVE_SYNC_REASONS) expect(i18n.global.te(`liveSync.reason.${r}`)).toBe(true)
    }
  })
})
