import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, type JobView } from '@mongo-manager/shared'
import AppSidebar from '../src/workspace/AppSidebar.vue'
import JobRow from '../src/jobs/JobRow.vue'
import { tabInputFromRoute, tabLocation } from '../src/workspace/tabRoutes'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { SCHEDULE } from './support/schedules'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ME = {
  mode: 'team',
  user: { id: 'u1', username: 'ada', role: 'editor' },
  permissions: [...PERMISSIONS],
  csrfToken: 'csrf-1',
  readOnly: false,
  twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
}
const JOB = (over: Partial<JobView> = {}): JobView => ({
  id: 'j1',
  kind: 'backup.dump',
  connectionId: 'c1',
  db: 'shop',
  coll: '*',
  targetConnectionId: null,
  target: 'shop-20261004-020000.mmbak',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: Date.now(),
  finishedAt: null,
  mine: true,
  cancellable: false,
  ...over,
})

describe('scheduled backups in the workspace (phase 3d-3c spec §5)', () => {
  it('is a singleton tab with its own address', () => {
    expect(tabInputFromRoute({ name: 'schedules', params: {} })).toEqual({ kind: 'schedules', title: '' })
    expect(tabLocation({ id: 'x', kind: 'schedules', title: '', params: {} })).toEqual({ name: 'schedules' })
  })

  it('opens from the sidebar, which marks a schedule that needs attention (UI redesign R1 revision 2)', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
      'GET backup-schedules': () => [
        200,
        {
          enabled: true,
          schedules: [
            SCHEDULE({ state: 'paused', pause: { reason: 'key_inactive', by: 'system', byName: null } }),
            SCHEDULE({
              id: 's2',
              mine: false,
              state: 'paused',
              pause: { reason: 'admin', by: 'admin', byName: 'root' },
            }),
            SCHEDULE({ id: 's3' }),
            // Final review I4: failing even while its next run is under way (the card says the same).
            SCHEDULE({
              id: 's4',
              lastRuns: [
                { id: 'f', dueAt: 1, outcome: 'failed', reason: 'connection' },
                { id: 'g', dueAt: 2, outcome: 'running', reason: null },
              ],
            }),
          ],
        },
      ],
    })
    await useSessionStore().refresh()
    mountApp(AppSidebar)
    await flushPromises()
    const group = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) =>
      b.textContent?.includes('Automations'),
    )!
    expect(group.getAttribute('aria-label')).toBe('Automations, 2 schedules need attention')
    group.click()
    await flushPromises()
    const item = document.querySelector<HTMLButtonElement>('button[aria-label^="Scheduled backups"]')!
    expect(item.getAttribute('aria-label')).toBe('Scheduled backups, 2 schedules need attention')
    expect(item.textContent).toContain('2')
    item.click()
    expect(useTabsStore().active?.kind).toBe('schedules')
  })

  it('names the schedule a job runs for', () => {
    mountApp(JobRow, { props: { job: JOB({ scheduleName: 'Nightly shop' }), now: Date.now() } })
    expect(document.body.textContent).toContain('Scheduled · Nightly shop')
  })
})
