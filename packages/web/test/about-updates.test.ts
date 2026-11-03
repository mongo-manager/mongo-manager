import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { UpdateStatus } from '@mongo-manager/shared/browser'
import AboutView from '../src/about/AboutView.vue'
import AccountMenu from '../src/workspace/AccountMenu.vue'
import { i18n } from '../src/i18n'
import { useSessionStore } from '../src/stores/session'
import { useUpdatesStore } from '../src/stores/updates'
import { mockApi, mountApp } from './support/app'

/** The updater (2026-11-03): the About page's Updates card, its dialog, the menu's dot, the privacy line. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function as(role: 'admin' | 'viewer') {
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = {
    mode: 'team',
    user: { id: 'u1', username: 'root', role },
    permissions: role === 'admin' ? ['settings:manage'] : [],
  } as never
}

const base: UpdateStatus = {
  installed: '1.0.2',
  distribution: 'npm',
  disabled: false,
  launcher: true,
  auto: false,
  lastCheck: null,
  latest: null,
  offer: null,
  progress: null,
}
const available: UpdateStatus = {
  ...base,
  lastCheck: { at: Date.now() - 2 * 3600_000, outcome: 'available' },
  latest: {
    version: '1.0.3',
    publishedAt: '2026-11-03T10:00:00Z',
    notes: '## Added\n<img src=x onerror="alert(1)">',
    url: 'https://github.com/mongo-manager/mongo-manager/releases/tag/v1.0.3',
  },
  offer: 'install',
}
const card = () => document.querySelector<HTMLElement>('[data-about-updates]')
const text = () => card()?.textContent ?? ''
const button = (name: RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => name.test(b.textContent ?? ''))

async function about(status: UpdateStatus, more: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ 'GET updates': () => [200, status], ...more })
  mountApp(AboutView)
  await flushPromises()
  return api
}

describe('the Updates card', () => {
  it('shows anyone else the installed version only', async () => {
    as('viewer')
    await about(base)
    expect(text()).toContain('1.0.2')
    expect(button(/Check now/)).toBeUndefined()
    expect(card()!.querySelector('[role="switch"]')).toBeNull()
  })

  it('gives an administrator Check now and the daily check, which says what it sends', async () => {
    as('admin')
    const { calls } = await about(base, {
      'POST updates/check': () => [200, { ...base, lastCheck: { at: Date.now(), outcome: 'current' } }],
      'PUT updates/settings': (body) => [200, { ...base, auto: (body as { auto: boolean }).auto }],
    })
    expect(text()).toMatch(/api\.github\.com/)
    button(/Check now/)!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'updates/check')).toBe(true)
    expect(text()).toContain('Up to date')
    card()!.querySelector<HTMLInputElement>('[role="switch"]')!.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ auto: true })
  })

  it('shows a new version’s notes as text, never as markup, with its page', async () => {
    as('admin')
    await about(available)
    expect(text()).toContain('1.0.3')
    expect(card()!.querySelector('img')).toBeNull()
    expect(card()!.querySelector('pre')!.textContent).toContain('<img src=x onerror="alert(1)">')
    const link = card()!.querySelector<HTMLAnchorElement>('a[href*="releases/tag/v1.0.3"]')!
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('updates after the dialog says what happens, asking again when jobs run', async () => {
    as('admin')
    let tries = 0
    const { calls } = await about(available, {
      'POST updates/install': () =>
        ++tries === 1
          ? [409, { code: 'CONFLICT', message: 'Jobs', details: { reason: 'update_jobs', jobs: 2 } }]
          : [202, { ...available, progress: { phase: 'downloading', percent: 10 } }],
    })
    button(/^Update$/)!.click()
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toMatch(/copy of its database/i)
    button(/Update now/)!.click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'updates/install')[0]!.body).toEqual({ version: '1.0.3' })
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2 jobs are running')
    button(/Update now/)!.click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'updates/install')[1]!.body).toEqual({
      version: '1.0.3',
      confirmJobs: true,
    })
  })

  it('Docker with an old image: the pull commands, with the version', async () => {
    as('admin')
    await about({
      ...available,
      distribution: 'docker',
      offer: 'pull_image',
      offerReason: 'image_old',
      image: { version: '1.0.2', created: null, old: false },
    })
    expect(text()).toContain('docker pull ghcr.io/mongo-manager/mongo-manager:1.0.3')
    expect(text()).toContain('docker compose pull && docker compose up -d')
    expect(button(/^Update$/)).toBeUndefined()
  })

  it('npm without the launcher: the reinstall command', async () => {
    as('admin')
    await about({ ...available, offer: 'reinstall', offerReason: 'no_launcher', launcher: false })
    expect(text()).toContain('npm i -g @mongo-manager/app@1.0.3')
  })

  it('says a check failed in plain words, and when the rate limit lifts', async () => {
    as('admin')
    await about({
      ...base,
      lastCheck: {
        at: Date.now(),
        outcome: 'failed',
        reason: 'rate_limited',
        retryAt: Date.now() + 3600_000,
      },
    })
    expect(text()).toMatch(/GitHub limits how often/)
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    as('admin')
    await about({ ...base, lastCheck: { at: Date.now(), outcome: 'failed', reason: 'signature' } })
    expect(text()).toMatch(/signature/i)
  })

  it('says why an update was rolled back, in the reader’s words', async () => {
    as('admin')
    await about({
      ...base,
      lastUpdate: { version: '1.0.3', outcome: 'rolled_back', code: 'timeout', reason: 'x', at: Date.now() },
    })
    expect(text()).toContain('it did not say it was ready in time')
  })

  // Final review (I6): a version that had run well, refused at a start.
  it('says a version was refused because its files changed', async () => {
    as('admin')
    await about({
      ...base,
      lastUpdate: { version: '1.0.3', outcome: 'refused', code: 'files', at: Date.now() },
    })
    expect(text()).toMatch(/1\.0\.3 was refused at start/)
  })

  it('a release that needs a newer installed program: the reinstall command, said so', async () => {
    as('admin')
    await about({ ...available, offer: 'reinstall', offerReason: 'launcher_old' })
    expect(text()).toMatch(/needs a newer installed Mongo Manager/)
    expect(text()).toContain('npm i -g @mongo-manager/app@1.0.3')
  })

  it('links only the project’s own release page', async () => {
    as('admin')
    await about({ ...available, latest: { ...available.latest!, url: 'javascript:alert(1)' } })
    expect(card()!.querySelector('a[href^="javascript"]')).toBeNull()
  })

  it('says how the last update ended', async () => {
    as('admin')
    await about({
      ...base,
      lastUpdate: {
        version: '1.0.3',
        outcome: 'rolled_back',
        reason: 'it stopped with code 1',
        at: Date.now(),
      },
    })
    expect(text()).toContain('Could not update to 1.0.3')
  })

  it('is gone with MM_UPDATES=off', async () => {
    as('admin')
    await about({ ...base, disabled: true })
    expect(button(/Check now/)).toBeUndefined()
    expect(text()).toMatch(/turned off/i)
  })
})

describe('the privacy line follows the setting', () => {
  const privacy = () => document.querySelector<HTMLElement>('[data-about-privacy]')!.textContent ?? ''

  it('no update checks while the daily check is off', async () => {
    as('viewer')
    await about(base)
    expect(privacy()).toContain('No update checks')
  })

  it('says what it asks once a day when it is on — for everyone, not only administrators', async () => {
    as('viewer')
    await about({ ...base, auto: true })
    expect(privacy()).not.toContain('No update checks')
    expect(privacy()).toMatch(/once a day/)
  })

  // Final review (minor): a status that could not be read claims nothing.
  it('says nothing about update checks when the server could not be asked', async () => {
    as('viewer')
    mockApi({ 'GET updates': () => [500, { code: 'INTERNAL', message: 'x' }] })
    mountApp(AboutView)
    await flushPromises()
    expect(privacy()).not.toMatch(/update check/i)
    expect(document.querySelector('[data-about-privacy-item="updates"]')).toBeNull()
  })

  it('says updates are turned off on this server', async () => {
    as('viewer')
    await about({ ...base, disabled: true })
    expect(privacy()).toMatch(/turned off on this server/)
  })
})

describe('restarting into the new version', () => {
  it('keeps asking through the restart’s errors, then says the version it runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    as('admin')
    let n = 0
    mockApi({
      'GET updates': () => {
        n++
        if (n === 1) return [200, { ...available, progress: { phase: 'restarting' } }]
        if (n === 2) return [502, { code: 'BAD_GATEWAY', message: 'restarting' }]
        if (n === 3) return Promise.reject(new TypeError('Failed to fetch'))
        return [
          200,
          {
            ...base,
            installed: '1.0.3',
            lastUpdate: { version: '1.0.3', outcome: 'updated', at: Date.now() },
          },
        ]
      },
    })
    mountApp(AboutView)
    await flushPromises()
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1_100)
      await flushPromises()
    }
    expect(n).toBeGreaterThanOrEqual(4)
    expect(text()).toContain('Updated to 1.0.3')
    expect(useUpdatesStore().restarting).toBeNull()
  })
})

describe('the account menu', () => {
  it('marks an available update for an administrator only', async () => {
    as('admin')
    mockApi({ 'GET updates': () => [200, available] })
    const store = useUpdatesStore()
    await store.load()
    mountApp(AccountMenu)
    await flushPromises()
    expect(document.querySelector('[data-update-dot]')).not.toBeNull()
    document.body.innerHTML = ''
    store.status = { ...available, offer: null }
    mountApp(AccountMenu)
    await flushPromises()
    expect(document.querySelector('[data-update-dot]')).toBeNull()
  })
})
