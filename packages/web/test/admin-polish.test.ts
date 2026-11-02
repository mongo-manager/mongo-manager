import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import App from '../src/App.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { api as client } from '../src/api/client'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose, typeInto, securityTab } from './support/dom'
import { pick } from './support/pickers'

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
const BOB = '00000000-0000-4000-8000-0000000000b2'
const USERS = [
  {
    id: ADA,
    username: 'ada',
    role: 'admin',
    totpEnabled: true,
    twoFactor: true,
    disabled: false,
    createdAt: 0,
    passwordChangedAt: 0,
  },
  {
    id: BOB,
    username: 'bob',
    role: 'editor',
    totpEnabled: false,
    twoFactor: true,
    disabled: false,
    createdAt: 0,
    passwordChangedAt: 0,
  },
]
const me = (over: Record<string, unknown> = {}) => ({
  mode: 'team',
  user: { id: ADA, username: 'ada', role: 'admin' },
  permissions: [...PERMISSIONS],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 10 },
  twoFactorRequired: false,
  ...over,
})

async function tab(kind: 'users' | 'audit', handlers: Record<string, Handler> = {}, who = me()) {
  const r = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, who],
    'GET connections': () => [200, []],
    'GET users': () => [200, USERS],
    'GET users/policy': () => [200, { adminTwoFactor: false, forced: false }],
    'GET audit': () => [200, []],
    'GET audit/settings': () => [200, { days: null }],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser(ADA)
  tabs.open({ kind, title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await vi.waitFor(() => expect(document.querySelector('main [data-admin-page]')).not.toBeNull())
  await flushPromises()
  return { ...r, router, tabs }
}

describe('audit log export and retention (phase 4c §1-2)', () => {
  it('exports what the filters show, as CSV or NDJSON', async () => {
    await tab('audit')
    await pick('data-audit-action-filter', 'Add a user')
    button('Filter').click()
    await flushPromises()
    const link = (format: string) =>
      document.querySelector<HTMLAnchorElement>(`[data-audit-export="${format}"]`)!
    const url = new URL(link('csv').href)
    expect(url.pathname).toMatch(/\/api\/audit\/export$/)
    expect(Object.fromEntries(url.searchParams)).toEqual({ format: 'csv', action: 'users.create' })
    expect(new URL(link('ndjson').href).searchParams.get('format')).toBe('ndjson')
    expect(link('csv').hasAttribute('download')).toBe(true)
  })

  it('shortens the log only after saying how many entries go and when, with the password (4c review I4)', async () => {
    const { calls } = await tab('audit', {
      'GET audit/settings': (_b, url) => [
        200,
        { days: null, effectiveAt: null, ...(url.searchParams.get('preview') ? { wouldRemove: 1234 } : {}) },
      ],
      'PUT audit/settings': (body) => [
        200,
        { days: (body as { days: number }).days, effectiveAt: Date.UTC(2026, 9, 11) },
      ],
      'GET audit': () => [200, []],
    })
    const card = document.querySelector('[data-audit-retention]')!
    expect(card.textContent).toContain('Kept for ever')
    await choose(byLabel<HTMLSelectElement>('Keep entries for'), '90')
    button('Save').click()
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('1,234')
    expect(dialog.textContent).toContain('a day')
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT' && c.path === 'audit/settings')!.body).toEqual({
      days: 90,
      password: 'my password',
    })
    // The log is read again (entries may go), and the coming change is said.
    expect(calls.filter((c) => c.method === 'GET' && c.path === 'audit').length).toBeGreaterThan(1)
  })

  it('says when fewer days take effect while the change waits', async () => {
    await tab('audit', {
      'GET audit/settings': () => [200, { days: 30, effectiveAt: Date.now() + 3600_000 }],
    })
    expect(document.querySelector('[data-audit-retention]')!.textContent).toContain('from')
  })

  it('shows the retention to a reader who may not change it, without a form', async () => {
    const permissions = PERMISSIONS.filter((p) => p !== 'settings:manage')
    await tab('audit', { 'GET audit/settings': () => [200, { days: 180 }] }, me({ permissions }))
    const card = document.querySelector('[data-audit-retention]')!
    expect(card.textContent).toContain('180 days')
    expect(card.querySelector('select')).toBeNull()
  })
})

// User review 2026-10-30: the page's layout was old — the policy cards squeezed beside the table.
describe('the users page’s tabs', () => {
  it('shows the team at a glance over the table, and no sign-in settings beside it', async () => {
    await tab('users')
    const stat = (k: string) => document.querySelector(`[data-stat="${k}"]`)?.textContent ?? ''
    expect(stat('total')).toContain('2')
    expect(stat('admins')).toContain('1')
    expect(stat('twoFactor')).toContain('2')
    expect(stat('disabled')).toContain('0')
    expect(document.querySelector('[data-admin-policy]')).toBeNull()
    expect([...document.querySelectorAll('[role="tab"][id^="users-view-"]')].map((b) => b.textContent?.trim())).toEqual([
      'Users',
      'Security',
      'Activity',
    ])
  })

  it('keeps the sign-in settings on the Security tab, one column of cards', async () => {
    await tab('users')
    await securityTab()
    const security = document.querySelector('[data-users-security]')!
    expect(security.querySelector('[data-admin-policy]')).not.toBeNull()
    expect(document.querySelector('main tbody')).toBeNull()
    expect(security.querySelector('[data-policy-status]')!.textContent).toBe(
      'Not required: each user chooses.',
    )
  })

  it('says once, above the switches, to set 2FA up first — with the way to do it', async () => {
    const { tabs } = await tab(
      'users',
      {},
      me({ twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 } }),
    )
    await securityTab()
    const policy = document.querySelector('[data-admin-policy]')!
    expect(policy.textContent!.split('Set up two-factor authentication for yourself first').length - 1).toBe(
      1,
    )
    ;(policy.querySelector('[data-policy-setup]') as HTMLButtonElement).click()
    await flushPromises()
    expect(tabs.active?.kind).toBe('account')
  })
})

describe('users: 2FA, the administrators’ policy and activity (phase 4c §3-5)', () => {
  it('counts a passkey as 2FA', async () => {
    await tab('users')
    const bob = [...document.querySelectorAll('main tbody tr')].find((r) => r.textContent?.includes('bob'))!
    expect(bob.querySelector('[data-two-factor]')!.textContent).toContain('On')
  })

  it('turns the administrators’ 2FA requirement on', async () => {
    const { calls } = await tab('users', {
      'PUT users/policy': (body) => [200, { ...(body as object), forced: false }],
    })
    await securityTab()
    const toggle = byLabel<HTMLInputElement>('Require two-factor authentication for administrators')
    expect(toggle.disabled).toBe(false)
    toggle.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT' && c.path === 'users/policy')!.body).toEqual({
      adminTwoFactor: true,
    })
  })

  it('asks the password to turn the requirement off (4c review I4)', async () => {
    const { calls } = await tab('users', {
      'GET users/policy': () => [200, { adminTwoFactor: true, forced: false }],
      'PUT users/policy': (body) => [
        200,
        { adminTwoFactor: (body as { adminTwoFactor: boolean }).adminTwoFactor, forced: false },
      ],
    })
    await securityTab()
    byLabel<HTMLInputElement>('Require two-factor authentication for administrators').click()
    await flushPromises()
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    await securityTab()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT' && c.path === 'users/policy')!.body).toEqual({
      adminTwoFactor: false,
      password: 'my password',
    })
  })

  it('keeps the requirement locked for an administrator without 2FA, or when the server forces it', async () => {
    await tab(
      'users',
      {},
      me({ twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 } }),
    )
    await securityTab()
    expect(byLabel<HTMLInputElement>('Require two-factor authentication for administrators').disabled).toBe(
      true,
    )
    expect(document.querySelector('[data-admin-policy]')!.textContent).toContain(
      'Set up two-factor authentication for yourself first',
    )
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await tab('users', { 'GET users/policy': () => [200, { adminTwoFactor: true, forced: true }] })
    await securityTab()
    const forced = byLabel<HTMLInputElement>('Require two-factor authentication for administrators')
    expect([forced.checked, forced.disabled]).toEqual([true, true])
    expect(document.querySelector('[data-admin-policy]')!.textContent).toContain('server configuration')
  })

  it('shows each user’s activity, and opens the audit log of one', async () => {
    const { calls, tabs } = await tab('users', {
      'GET users/activity': () => [
        200,
        [
          {
            userId: BOB,
            username: 'bob',
            role: 'editor',
            disabled: false,
            lastSignInAt: Date.UTC(2026, 9, 1),
            signIns: 4,
            failedSignIns: 2,
            actions: 17,
            denied: 1,
            lastActivityAt: Date.UTC(2026, 9, 2),
            groups: [
              { group: 'documents', count: 12 },
              { group: 'legacy', count: 1 },
            ],
          },
        ],
      ],
    })
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.trim() === 'Activity')!
      .click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'users/activity')).toBeDefined()
    // The mark is in the row's first cell (the kit's table draws the rows).
    const line = document.querySelector('[data-activity="' + BOB + '"]')!.closest('tr')!
    // Audit action labels (2026-10-28): what they did, in words; a group with none, by its code.
    for (const text of ['bob', '4', '2', '17', 'Documents', 'legacy'])
      expect(line.textContent).toContain(text)
    ;[...line.querySelectorAll('button')].find((b) => b.textContent?.includes('Audit log'))!.click()
    await flushPromises()
    expect(tabs.active).toMatchObject({ kind: 'audit', params: { userId: BOB } })
  })
})

describe('mandatory 2FA set-up (phase 4c §4)', () => {
  it('shows the set-up alone, never the workspace, until 2FA is on', async () => {
    const { calls } = mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        me({
          twoFactorRequired: true,
          twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
        }),
      ],
      'GET auth/passkeys/support': () => [200, { supported: true }],
      'GET auth/passkeys': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(App, { plugins: [router] })
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('twoFactorRequired')
    expect(document.querySelector('[data-two-factor-required]')!.textContent).toContain(
      'two-factor authentication',
    )
    expect(document.querySelector('[data-two-factor-required]')!.textContent).toContain('Sign out')
    // Nothing of the workspace was asked for.
    expect(calls.some((c) => c.path === 'connections')).toBe(false)
  })

  it('goes to the set-up when the server asks for it while signed in', async () => {
    // The policy is turned on meanwhile: the server refuses, and then says so in the session too.
    let required = false
    const r = await tab('users', {
      'GET auth/me': () => [200, me({ twoFactorRequired: required })],
      'GET users/activity': () => [
        403,
        { code: 'FORBIDDEN', message: 'x', details: { reason: 'two_factor_setup_required' } },
      ],
    })
    required = true
    await client.get('users/activity').catch(() => undefined)
    await flushPromises()
    await vi.waitFor(() => expect(r.router.currentRoute.value.name).toBe('twoFactorRequired'))
  })

  it('stays in the workspace when the session says no set-up is needed after all', async () => {
    const r = await tab('users', {
      'GET users/activity': () => [
        403,
        { code: 'FORBIDDEN', message: 'x', details: { reason: 'two_factor_setup_required' } },
      ],
    })
    await client.get('users/activity').catch(() => undefined)
    await flushPromises()
    await vi.waitFor(() => expect(r.router.currentRoute.value.name).toBe('workspace'))
  })
})
