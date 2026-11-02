import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp, type Handler } from './support/app'
import { byLabel, choose, typeInto, securityTab } from './support/dom'

/**
 * Session lifetime (2026-10-29): an administrator chooses, on the Users page, how long a session lasts
 * without activity. A longer time asks for their password; a shorter one is saved as it is.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ADA = '00000000-0000-4000-8000-0000000000a1'
const me = {
  mode: 'team',
  user: { id: ADA, username: 'ada', role: 'admin' },
  permissions: [...PERMISSIONS],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 10 },
  twoFactorRequired: false,
}

async function users(handlers: Record<string, Handler> = {}) {
  const r = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, me],
    'GET connections': () => [200, []],
    'GET users': () => [200, []],
    'GET users/policy': () => [200, { adminTwoFactor: false, forced: false }],
    'GET users/session-policy': () => [200, { idleMinutes: 30, absoluteMinutes: 720 }],
    'PUT users/session-policy': (body) => [
      200,
      { idleMinutes: (body as { idleMinutes: number }).idleMinutes, absoluteMinutes: 720 },
    ],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser(ADA)
  tabs.open({ kind: 'users', title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await securityTab()
  await vi.waitFor(() => expect(document.querySelector('main [data-session-policy]')).not.toBeNull())
  await flushPromises()
  return r
}

const card = () => document.querySelector<HTMLElement>('[data-session-policy]')!
const select = () => byLabel<HTMLSelectElement>('Sign out after inactivity')
const save = () => card().querySelector<HTMLButtonElement>('button[type="submit"]')!
const puts = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === 'PUT' && c.path === 'users/session-policy')

describe('the session lifetime card', () => {
  it('says the time in force and the 12 hours, and offers the listed times', async () => {
    await users()
    expect(card().textContent).toContain('30 minutes')
    expect(card().textContent).toContain('12 hours')
    expect([...select().options].map((o) => o.textContent?.trim())).toEqual([
      '15 minutes',
      '30 minutes',
      '1 hour',
      '4 hours',
      '8 hours',
    ])
    expect(save().disabled).toBe(true)
  })

  it('saves a shorter time without asking anything', async () => {
    const { calls } = await users()
    await choose(select(), '15')
    save().click()
    await flushPromises()
    expect(document.querySelector('[data-test="prompt-input"]')).toBeNull()
    expect(puts(calls).map((c) => c.body)).toEqual([{ idleMinutes: 15 }])
  })

  it('asks the password for a longer time, and saves nothing when it is not given', async () => {
    const { calls } = await users()
    await choose(select(), '480')
    save().click()
    await flushPromises()
    expect(document.querySelector('[data-test="prompt-input"]')).not.toBeNull()
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(puts(calls)).toEqual([])

    save().click()
    await flushPromises()
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(puts(calls).map((c) => c.body)).toEqual([{ idleMinutes: 480, password: 'my password' }])
  })

  it('is not shown by a server that has no such setting', async () => {
    const r = mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, me],
      'GET connections': () => [200, []],
      'GET users': () => [200, []],
      'GET users/policy': () => [200, { adminTwoFactor: false, forced: false }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser(ADA)
    tabs.open({ kind: 'users', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await securityTab()
    await vi.waitFor(() => expect(document.querySelector('main [data-admin-policy]')).not.toBeNull())
    await flushPromises()
    expect(document.querySelector('[data-session-policy]')).toBeNull()
    expect(r.calls.some((c) => c.path === 'users/session-policy')).toBe(true)
  })

  it('reads the time again after a refusal, so the next try asks what it must', async () => {
    let gets = 0
    const { calls } = await users({
      'GET users/session-policy': () => [200, { idleMinutes: gets++ ? 30 : 480, absoluteMinutes: 720 }],
      'PUT users/session-policy': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'Enter your password', details: { reason: 'wrong_password' } },
      ],
    })
    await choose(select(), '60')
    save().click()
    await flushPromises()
    expect(puts(calls).map((c) => c.body)).toEqual([{ idleMinutes: 60 }])
    await vi.waitFor(() => expect(card().textContent).toContain('30 minutes'))
    await choose(select(), '60')
    save().click()
    await flushPromises()
    expect(document.querySelector('[data-test="prompt-input"]')).not.toBeNull()
  })

  it('says when the time could not be read, and keeps the choice still while saving', async () => {
    let answer: (v: [number, unknown]) => void = () => {}
    await users({
      'PUT users/session-policy': () => new Promise<[number, unknown]>((resolve) => (answer = resolve)),
    })
    await choose(select(), '15')
    save().click()
    await flushPromises()
    expect(select().disabled).toBe(true)
    answer([200, { idleMinutes: 15, absoluteMinutes: 720 }])
    await flushPromises()
    expect(select().disabled).toBe(false)
  })

  it('shows the card with what went wrong when the server fails to answer', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, me],
      'GET connections': () => [200, []],
      'GET users': () => [200, []],
      'GET users/policy': () => [200, { adminTwoFactor: false, forced: false }],
      'GET users/session-policy': () => [500, { code: 'INTERNAL', message: 'Broken' }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser(ADA)
    tabs.open({ kind: 'users', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await securityTab()
    await vi.waitFor(() => expect(document.querySelector('main [data-session-policy-error]')).not.toBeNull())
    expect(document.querySelector('[data-session-policy] select')).toBeNull()
  })
})
