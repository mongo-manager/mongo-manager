// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
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
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose, typeInto, securityTab } from './support/dom'

/** Required 2FA, per user and for everyone (spec 2026-10-28-required-2fa-design.md). */
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
const CEM = '00000000-0000-4000-8000-0000000000c3'
const user = (id: string, username: string, role: string, over: Record<string, unknown> = {}) => ({
  id,
  username,
  role,
  totpEnabled: false,
  twoFactor: false,
  requireTwoFactor: false,
  disabled: false,
  createdAt: 0,
  passwordChangedAt: 0,
  ...over,
})
const USERS = [
  user(ADA, 'ada', 'admin', { totpEnabled: true, twoFactor: true }),
  user(BOB, 'bob', 'editor', { requireTwoFactor: true }),
  user(CEM, 'cem', 'viewer', { requireTwoFactor: true, totpEnabled: true, twoFactor: true }),
]
const POLICY = { adminTwoFactor: false, forced: false, everyoneTwoFactor: false, everyoneForced: false }
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

async function usersTab(handlers: Record<string, Handler> = {}) {
  const r = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, me()],
    'GET connections': () => [200, []],
    'GET users': () => [200, USERS],
    'GET users/policy': () => [200, POLICY],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser(ADA)
  tabs.open({ kind: 'users', title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await vi.waitFor(() => expect(document.querySelector('main tbody tr')).not.toBeNull())
  await flushPromises()
  return r
}

const row = (name: string) =>
  [...document.querySelectorAll('main tbody tr')].find((r) => r.textContent?.includes(name))!

async function openCreate() {
  button('Add user').click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  await flushPromises()
}
async function submitCreate() {
  await typeInto(byLabel('Username'), 'deniz')
  await typeInto(byLabel('Password'), 'a-long-password-1')
  await typeInto(byLabel('Your password'), 'my-own-password-1')
  ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((b) => b.textContent?.trim() === 'Add user')!
    .click()
  await flushPromises()
}

describe('requiring 2FA of a new user', () => {
  it('is off by default, and sent when checked', async () => {
    const { calls } = await usersTab({ 'POST users': () => [200, user('u4', 'deniz', 'viewer')] })
    await openCreate()
    const box = byLabel<HTMLInputElement>('Require two-factor authentication')
    expect([box.checked, box.disabled]).toEqual([false, false])
    box.click()
    await submitCreate()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'users')!.body).toMatchObject({
      username: 'deniz',
      requireTwoFactor: true,
    })
  })

  // Required 2FA final review (I1): the box is what is stored for the user, never the policy's echo.
  it('says when the policy covers the new user already, and keeps the box their own', async () => {
    const { calls } = await usersTab({
      'GET users/policy': () => [200, { ...POLICY, adminTwoFactor: true }],
      'POST users': () => [200, user('u4', 'deniz', 'admin')],
    })
    await openCreate()
    const box = () => byLabel<HTMLInputElement>('Require two-factor authentication')
    const text = () => document.querySelector('[role="dialog"]')!.textContent
    // A viewer: up to the administrator.
    expect(text()).not.toContain('by the two-factor policy')
    await choose(byLabel<HTMLSelectElement>('Role'), 'admin')
    expect([box().checked, box().disabled]).toEqual([false, false])
    expect(text()).toContain('Required of administrators by the two-factor policy.')
    expect(text()).toContain('if the policy changes')
    box().click()
    await submitCreate()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'users')!.body).toMatchObject({
      role: 'admin',
      requireTwoFactor: true,
    })
  })

  it('says when everyone must have 2FA, and sends the box as it is', async () => {
    const { calls } = await usersTab({
      'GET users/policy': () => [200, { ...POLICY, everyoneTwoFactor: true }],
      'POST users': () => [200, user('u4', 'deniz', 'viewer')],
    })
    await openCreate()
    const box = byLabel<HTMLInputElement>('Require two-factor authentication')
    expect([box.checked, box.disabled]).toEqual([false, false])
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Required of everyone by the two-factor policy.',
    )
    await submitCreate()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'users')!.body).toMatchObject({
      requireTwoFactor: false,
    })
  })
})

describe('the users table', () => {
  it('marks who must have 2FA, and who has not set it up yet', async () => {
    await usersTab()
    const mark = (name: string) => row(name).querySelector('[data-two-factor] [data-two-factor-required]')
    // Required 2FA final review (minor 7): the pending set-up is said in words, not only as a title.
    expect(mark('bob')!.textContent!.trim()).toBe('Set-up pending')
    expect(mark('bob')!.getAttribute('title')).toBe('Required, not set up yet')
    expect(mark('cem')!.textContent!.trim()).toBe('Required')
    expect(mark('ada')).toBeNull()
  })

  it('marks everyone when the policy requires it of everyone', async () => {
    await usersTab({ 'GET users/policy': () => [200, { ...POLICY, everyoneTwoFactor: true }] })
    expect(row('ada').querySelector('[data-two-factor-required]')).not.toBeNull()
  })

  it('offers to stop requiring it of a required user, not to require it again', async () => {
    await usersTab()
    row('cem').querySelector<HTMLButtonElement>('button[aria-label="Actions for cem"]')!.click()
    await flushPromises()
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((b) =>
      b.textContent?.trim(),
    )
    expect(items).toContain('Stop requiring two-factor')
    expect(items).not.toContain('Require two-factor')
  })

  it('offers neither to an older server, which has no flag', async () => {
    const { requireTwoFactor: _, ...older } = user(BOB, 'bob', 'editor')
    await usersTab({ 'GET users': () => [200, [USERS[0], older]] })
    row('bob').querySelector<HTMLButtonElement>('button[aria-label="Actions for bob"]')!.click()
    await flushPromises()
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((b) =>
      b.textContent?.trim(),
    )
    expect(items).not.toContain('Require two-factor')
    expect(items).not.toContain('Stop requiring two-factor')
    expect(items).toContain('Reset two-factor')
  })

  it('says the policy still requires it after the user’s own requirement is taken off', async () => {
    await usersTab({
      'GET users/policy': () => [200, { ...POLICY, everyoneTwoFactor: true }],
      [`PATCH users/${CEM}`]: () => [200, { ...USERS[2], requireTwoFactor: false }],
    })
    row('cem').querySelector<HTMLButtonElement>('button[aria-label="Actions for cem"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Stop requiring two-factor')!
      .click()
    await flushPromises()
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'cem’s own requirement is off; the two-factor policy still requires it.',
    )
  })

  it('turns the requirement on for one user', async () => {
    const plain = user(BOB, 'bob', 'editor')
    const { calls } = await usersTab({
      'GET users': () => [200, [USERS[0], plain]],
      [`PATCH users/${BOB}`]: () => [200, { ...plain, requireTwoFactor: true }],
    })
    row('bob').querySelector<HTMLButtonElement>('button[aria-label="Actions for bob"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Require two-factor')!
      .click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'bob must set up two-factor authentication',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ requireTwoFactor: true })
  })

  it('asks the administrator’s password to stop requiring it', async () => {
    const { calls } = await usersTab({
      [`PATCH users/${CEM}`]: () => [200, { ...USERS[2], requireTwoFactor: false }],
    })
    row('cem').querySelector<HTMLButtonElement>('button[aria-label="Actions for cem"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Stop requiring two-factor')!
      .click()
    await flushPromises()
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      requireTwoFactor: false,
      currentPassword: 'my password',
    })
  })
})

describe('the policy for everyone', () => {
  // Required 2FA final review (minor 3): one click locks every user without 2FA out of all but the
  // set-up, so it is confirmed first, with how many that is.
  it('turns it on after saying how many users have no 2FA yet', async () => {
    const { calls } = await usersTab({
      'PUT users/policy': (body) => [200, { ...POLICY, ...(body as object) }],
    })
    await securityTab()
    const toggle = byLabel<HTMLInputElement>('Require two-factor authentication for everyone')
    expect(toggle.disabled).toBe(false)
    toggle.click()
    await flushPromises()
    // Bob alone has no 2FA.
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Active users without two-factor authentication: 1.',
    )
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT' && c.path === 'users/policy')!.body).toEqual({
      everyoneTwoFactor: true,
    })
  })

  it('shows the switch as it is again when the change is abandoned or refused', async () => {
    await usersTab({
      'PUT users/policy': () => [
        409,
        { code: 'CONFLICT', message: 'x', details: { reason: 'two_factor_needed_first' } },
      ],
    })
    await securityTab()
    const toggle = () => byLabel<HTMLInputElement>('Require two-factor authentication for everyone')
    toggle().click()
    await flushPromises()
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(toggle().checked).toBe(false)
    toggle().click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(toggle().checked).toBe(false)
  })

  it('is not shown by an older server', async () => {
    await usersTab({ 'GET users/policy': () => [200, { adminTwoFactor: false, forced: false }] })
    await securityTab()
    expect(document.querySelector('[data-policy="everyone"]')).toBeNull()
    expect(document.querySelector('[data-policy="admins"]')).not.toBeNull()
  })

  it('names each switch’s hint and lock to assistive technology', async () => {
    await usersTab({
      'GET users/policy': () => [200, { ...POLICY, everyoneTwoFactor: true, everyoneForced: true }],
    })
    await securityTab()
    const toggle = byLabel<HTMLInputElement>('Require two-factor authentication for everyone')
    const described = (toggle.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(described).toContain('whatever their role')
    expect(described).toContain('MM_REQUIRE_2FA')
  })

  // Required 2FA final review (I1): the administrators' own rule is shown as stored, so turning
  // "everyone" off never drops it unseen.
  it('asks the password to turn it off, and shows the administrators’ rule as stored meanwhile', async () => {
    const { calls } = await usersTab({
      'GET users/policy': () => [200, { ...POLICY, everyoneTwoFactor: true }],
      'PUT users/policy': (body) => [200, { ...POLICY, ...(body as object) }],
    })
    await securityTab()
    const admins = byLabel<HTMLInputElement>('Require two-factor authentication for administrators')
    expect([admins.checked, admins.disabled]).toEqual([false, false])
    expect(document.querySelector('[data-admin-policy]')!.textContent).toContain(
      'Administrators are required now because everyone is',
    )
    byLabel<HTMLInputElement>('Require two-factor authentication for everyone').click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Administrators would no longer be required either',
    )
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT' && c.path === 'users/policy')!.body).toEqual({
      everyoneTwoFactor: false,
      password: 'my password',
    })
  })

  it('is locked when the server forces it, or for an administrator without 2FA', async () => {
    await usersTab({
      'GET users/policy': () => [200, { ...POLICY, everyoneTwoFactor: true, everyoneForced: true }],
    })
    await securityTab()
    const forced = byLabel<HTMLInputElement>('Require two-factor authentication for everyone')
    expect([forced.checked, forced.disabled]).toEqual([true, true])
    expect(document.querySelector('[data-admin-policy]')!.textContent).toContain('MM_REQUIRE_2FA')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await usersTab({
      'GET auth/me': () => [
        200,
        me({ twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 } }),
      ],
    })
    await securityTab()
    expect(byLabel<HTMLInputElement>('Require two-factor authentication for everyone').disabled).toBe(true)
  })
})

describe('the set-up page', () => {
  async function setUp(by: string | undefined) {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        me({
          twoFactorRequired: true,
          ...(by ? { twoFactorRequiredBy: by } : {}),
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
    return document.querySelector('[data-two-factor-required]')!.textContent
  }

  it('says why 2FA is required', async () => {
    expect(await setUp('account')).toContain(
      'An administrator requires two-factor authentication for your account.',
    )
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    expect(await setUp('everyone')).toContain('Every user of this Mongo Manager must use')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    expect(await setUp('admins')).toContain('Administrators of this Mongo Manager must use')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    // An older server says no reason: the administrators' wording, as before.
    expect(await setUp(undefined)).toContain('Administrators of this Mongo Manager must use')
  })
})
