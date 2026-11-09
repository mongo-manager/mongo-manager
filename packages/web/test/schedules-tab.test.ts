// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { JobView } from '@mongo-manager/shared'
import SchedulesView from '../src/schedules/SchedulesView.vue'
import RunHistory from '../src/schedules/RunHistory.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useJobsStore } from '../src/jobs/store'
import { useWorkspaceDialogs } from '../src/stores/workspaceDialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, choose, byLabel } from './support/dom'
import { RUN, SCHEDULE } from './support/schedules'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const text = () => document.body.textContent ?? ''
const list =
  (schedules: ReturnType<typeof SCHEDULE>[], enabled = true) =>
  () =>
    [200, { enabled, schedules }] as [number, unknown]

describe('the Scheduled backups tab (phase 3d-3c spec §5)', () => {
  it('shows each schedule with its cadence in words, its next run in its zone, its runs and destinations', async () => {
    mockApi({
      'GET backup-schedules': list([
        SCHEDULE({
          lastRuns: [
            { id: 'a', dueAt: Date.UTC(2026, 9, 2), outcome: 'succeeded', reason: null },
            { id: 'b', dueAt: Date.UTC(2026, 9, 3), outcome: 'failed', reason: 'connection' },
            { id: 'c', dueAt: Date.UTC(2026, 9, 4), outcome: 'missed', reason: 'server_down' },
          ],
        }),
      ]),
    })
    mountApp(SchedulesView)
    await flushPromises()
    const card = document.querySelector<HTMLElement>('[data-schedule="s1"]')!
    expect(card.textContent).toContain('Nightly shop')
    expect(card.textContent).toContain('Every day at 02:00')
    expect(card.textContent).toContain('Europe/Berlin')
    expect(card.textContent).toContain('Offsite')
    expect(card.textContent).toContain('K-1a2b3c4d')
    expect(card.textContent).toMatch(/Next run in 3 hours/)
    const marks = [...card.querySelectorAll('[data-outcome]')].map((m) => m.getAttribute('aria-label'))
    expect(marks).toHaveLength(3)
    expect(marks[0]).toMatch(/^Succeeded · /)
    expect(marks[2]).toMatch(/^Missed · /)
  })

  it('runs now, pauses, resumes and deletes from a card', async () => {
    const { calls } = mockApi({
      'GET backup-schedules': list([
        SCHEDULE(),
        SCHEDULE({
          id: 's2',
          name: 'Weekly',
          state: 'paused',
          pause: { reason: 'owner', by: 'owner', byName: null },
        }),
      ]),
      'POST backup-schedules/s1/run': () => [202, { run: RUN({ outcome: 'running' }) }],
      'POST backup-schedules/s1/pause': () => [200, SCHEDULE({ state: 'paused' })],
      'POST backup-schedules/s2/resume': () => [200, SCHEDULE({ id: 's2' })],
      'DELETE backup-schedules/s1': () => [204],
    })
    mountApp(SchedulesView)
    mountApp(DialogHost)
    mountApp(ToastHost)
    await flushPromises()
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-schedule="${id}"]`)!
    ;[...card('s1').querySelectorAll('button')].find((b) => b.textContent?.includes('Run now'))!.click()
    await flushPromises()
    expect(text()).toContain('Nightly shop is running.')
    const menu = (id: string, label: string) => async () => {
      card(id).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click()
      await flushPromises()
      ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent?.trim() === label)!
        .click()
      await flushPromises()
    }
    await menu('s1', 'Pause')()
    await menu('s2', 'Resume')()
    expect(card('s2').textContent).toContain('Paused by its owner.')
    await menu('s1', 'Delete')()
    button('Delete schedule').click()
    await flushPromises()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'POST backup-schedules/s1/run',
        'POST backup-schedules/s1/pause',
        'POST backup-schedules/s2/resume',
        'DELETE backup-schedules/s1',
      ]),
    )
  })

  // Final review I4 (spec §5 Signals): a schedule whose last run failed showed a green "Active".
  it('marks a card whose last finished run failed or was partial, and says why', async () => {
    mockApi({
      'GET backup-schedules': list([
        SCHEDULE({
          lastRuns: [
            { id: 'a', dueAt: 1, outcome: 'succeeded', reason: null },
            { id: 'b', dueAt: 2, outcome: 'failed', reason: 'connection' },
            { id: 'c', dueAt: 3, outcome: 'running', reason: null },
          ],
        }),
        SCHEDULE({
          id: 's2',
          name: 'Weekly',
          lastRuns: [{ id: 'd', dueAt: 1, outcome: 'partial', reason: 'send_failed' }],
        }),
        SCHEDULE({
          id: 's3',
          name: 'Fine',
          lastRuns: [{ id: 'e', dueAt: 1, outcome: 'succeeded', reason: null }],
        }),
      ]),
    })
    mountApp(SchedulesView)
    await flushPromises()
    const card = (id: string) =>
      document.querySelector<HTMLElement>(`[data-schedule="${id}"]`)!.textContent ?? ''
    expect(card('s1')).toContain('Failing')
    expect(card('s1')).toContain('Last run failed: The connection could not be reached.')
    expect(card('s1')).not.toContain('Active')
    expect(card('s2')).toContain('Partial')
    expect(card('s3')).toContain('Active')
    expect(card('s3')).not.toContain('Last run')
  })

  // Final review minor 24: an administrator's pause is lifted by an administrator.
  it('offers the owner no Resume for an administrator’s pause, and says whom to ask', async () => {
    mockApi({
      'GET backup-schedules': list([
        SCHEDULE({
          state: 'paused',
          nextRunAt: null,
          pause: { reason: 'admin', by: 'admin', byName: 'root' },
        }),
      ]),
    })
    mountApp(SchedulesView)
    await flushPromises()
    const items = async () => {
      document.querySelector<HTMLButtonElement>('[data-schedule="s1"] button[aria-haspopup="menu"]')!.click()
      await flushPromises()
      const labels = [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      return labels
    }
    expect(text()).toContain('Paused by root, an administrator.')
    expect(text()).toContain('Ask an administrator to resume it.')
    expect(await items()).not.toContain('Resume')
  })

  it('says why a schedule is paused, and when scheduling is off', async () => {
    mockApi({
      'GET backup-schedules': list(
        [
          SCHEDULE({
            state: 'paused',
            nextRunAt: null,
            pause: { reason: 'key_inactive', by: 'system', byName: null },
          }),
        ],
        false,
      ),
    })
    mountApp(SchedulesView)
    await flushPromises()
    expect(text()).toContain('Paused: the backup key is not active.')
    expect(text()).toContain('Scheduling is turned off on this server')
  })

  it('explains scheduling when there is none, and opens the editor', async () => {
    mockApi({ 'GET backup-schedules': list([]) })
    mountApp(SchedulesView)
    await flushPromises()
    expect(text()).toContain('No scheduled backups yet')
    button('Create a schedule').click()
    expect(useWorkspaceDialogs().current).toEqual({ kind: 'backupSchedule' })
  })

  it('lets administrators filter by owner', async () => {
    mockApi({
      'GET backup-schedules': list([
        SCHEDULE(),
        SCHEDULE({ id: 's2', name: 'Bob’s nightly', mine: false, owner: { id: 'u2', username: 'bob' } }),
      ]),
    })
    mountApp(SchedulesView)
    await flushPromises()
    expect(document.querySelector('[data-schedule="s2"]')?.textContent).toContain('bob')
    await choose(byLabel('Owner') as unknown as HTMLSelectElement, 'u2')
    expect(document.querySelector('[data-schedule="s1"]')).toBeNull()
    expect(document.querySelector('[data-schedule="s2"]')).not.toBeNull()
  })

  it('shows a run’s outcome, duration, size, copies, removals and reason, and its failed job', async () => {
    mockApi({
      'GET backup-schedules/s1/runs': () => [
        200,
        [
          RUN({
            id: 'r2',
            outcome: 'partial',
            reason: 'send_failed',
            message: 'Not sent — NAS: The destination is full.',
            copies: [
              { destinationId: 'd1', name: 'Offsite', state: 'complete', reason: null },
              { destinationId: 'd2', name: 'NAS', state: 'failed', reason: 'quota' },
            ],
            removals: [{ location: 'd1', name: 'Offsite', removed: 2, failed: 0, waiting: 0 }],
          }),
          RUN({
            id: 'r1',
            kind: 'catchup',
            outcome: 'missed',
            reason: 'server_down',
            startedAt: null,
            finishedAt: null,
            size: null,
            copies: [],
            missed: 3,
          }),
        ],
      ],
    })
    const jobs = useJobsStore()
    jobs.upsert({
      id: 'j2',
      kind: 'backup.send',
      connectionId: 'c1',
      db: 'shop',
      coll: '*',
      targetConnectionId: null,
      target: 'shop.mmbak',
      state: 'failed',
      progress: null,
      estimate: null,
      error: 'Not sent — NAS: The destination is full.',
      startedAt: 1,
      finishedAt: 2,
      mine: true,
      cancellable: false,
    } satisfies JobView)
    mountApp(RunHistory, { props: { schedule: SCHEDULE() } })
    await flushPromises()
    const run = document.querySelector<HTMLElement>('[data-run="r2"]')!
    expect(run.textContent).toContain('Partial')
    expect(run.textContent).toContain('Took 2 min')
    expect(run.textContent).toContain('NAS · failed')
    // Short names review 13 (M-4): and why, as the destination said it.
    const why = [...run.querySelectorAll('[data-copy-reason]')].map((p) => p.textContent?.trim())
    expect(why).toEqual(['NAS: The destination is full.'])
    expect(run.textContent).toContain('Removed 2 old backups at Offsite')
    expect(run.textContent).toContain('A destination did not receive it.')
    expect(run.querySelector('[data-job="j2"]')).not.toBeNull()
    expect(document.querySelector('[data-run="r1"]')!.textContent).toContain('3 due times missed')
  })
})
