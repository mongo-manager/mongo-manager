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
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp, type Handler } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const USERS = [
  {
    id: 'u1',
    username: 'ada',
    role: 'admin',
    totpEnabled: true,
    disabled: false,
    createdAt: Date.UTC(2026, 0, 1),
    passwordChangedAt: 0,
  },
  {
    id: 'u2',
    username: 'bob',
    role: 'editor',
    totpEnabled: false,
    disabled: false,
    createdAt: Date.UTC(2026, 1, 1),
    passwordChangedAt: 0,
  },
]

async function usersTab(handlers: Record<string, Handler> = {}, ready = 'main table') {
  const api = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'team',
        user: { id: 'u1', username: 'ada', role: 'admin' },
        permissions: [...PERMISSIONS],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [200, []],
    'GET users': () => [200, USERS],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser('u1')
  tabs.open({ kind: 'users', title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await vi.waitFor(() => expect(document.querySelector(ready)).not.toBeNull())
  await flushPromises()
  return api
}

const row = (name: string) =>
  [...document.querySelectorAll('main tbody tr')].find((r) => r.textContent?.includes(name))!
async function userAction(name: string, label: string) {
  ;(document.querySelector(`button[aria-label="Actions for ${name}"]`) as HTMLButtonElement).click()
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  await flushPromises()
}

/** Answers the open prompt (the administrator's password, a code) and confirms it. */
async function confirmWith(text: string) {
  await vi.waitFor(() => expect(document.querySelector('[data-test="prompt-input"] input')).not.toBeNull())
  await typeInto(document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement, text)
  ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
  await flushPromises()
}

const tabNamed = (name: string) =>
  // The page's own tabs, not the workspace's tab bar (which has a "Users" tab too).
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"][aria-controls="users-panel"]')].find(
    (b) => b.textContent?.trim() === name,
  )!

// UI redesign R2–R5 spec §2: a named table, its panel named by its tab, and a Retry on a failure.
describe('users page patterns', () => {
  it('names its panel by the tab shown, and its lists as tables', async () => {
    await usersTab({ 'GET users/activity': () => [200, []] })
    const panel = document.getElementById('users-panel')!
    expect(panel.getAttribute('aria-labelledby')).toBe(tabNamed('Users').id)
    expect(document.querySelector('main table')!.getAttribute('aria-label')).toBe('Users')
    tabNamed('Activity').click()
    await flushPromises()
    expect(panel.getAttribute('aria-labelledby')).toBe(tabNamed('Activity').id)
    expect(tabNamed('Activity').id).not.toBe('')
  })

  it('says the users could not be read, and reads them again on Retry', async () => {
    let fail = true
    const { calls } = await usersTab(
      { 'GET users': () => (fail ? [500, { code: 'INTERNAL', message: 'boom' }] : [200, USERS]) },
      'main [role="alert"]',
    )
    expect(document.querySelector('main table')).toBeNull()
    fail = false
    button('Retry').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'GET' && c.path === 'users')).toHaveLength(2)
    expect(document.querySelector('main table')!.getAttribute('aria-label')).toBe('Users')
  })

  it('says the activity could not be read, and reads it again on Retry', async () => {
    let fail = true
    const { calls } = await usersTab({
      'GET users/activity': () => (fail ? [500, { code: 'INTERNAL', message: 'boom' }] : [200, []]),
    })
    tabNamed('Activity').click()
    await flushPromises()
    expect(document.querySelector('#users-panel [role="alert"]')).not.toBeNull()
    fail = false
    button('Retry').click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'users/activity')).toHaveLength(2)
    expect(document.querySelector('#users-panel [role="alert"]')).toBeNull()
  })
})

describe('users', () => {
  it('lists users and keeps your own row safe', async () => {
    await usersTab()
    expect(row('ada').textContent).toContain('you')
    expect(row('ada').querySelector('select')).toBeNull()
    expect(document.querySelector('button[aria-label="Actions for ada"]')).toBeNull()
    expect(row('bob').textContent).toContain('active')
  })

  it('creates a user', async () => {
    const { calls } = await usersTab({
      'POST users': () => [200, { ...USERS[1], id: 'u3', username: 'cem' }],
    })
    button('Add user').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await typeInto(byLabel('Username'), 'cem')
    await typeInto(byLabel('Password'), 'a-long-password-1')
    await choose(byLabel<HTMLSelectElement>('Role'), 'viewer')
    // Security audit 2026-10-16: confirmed with the administrator's own password.
    await typeInto(byLabel('Your password'), 'my-own-password-1')
    // The header has an Add user button too: submit with the dialog's own.
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Add user')!
      .click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'POST' && c.path === 'users')!.body).toEqual({
      username: 'cem',
      password: 'a-long-password-1',
      role: 'viewer',
      // Required 2FA (2026-10-28): off unless checked.
      requireTwoFactor: false,
      currentPassword: 'my-own-password-1',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('User cem added.')
  })

  it('says so when the username is taken', async () => {
    await usersTab({
      'POST users': () => [
        409,
        { code: 'CONFLICT', message: 'Username already exists', details: { reason: 'username_taken' } },
      ],
    })
    button('Add user').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await typeInto(byLabel('Username'), 'bob')
    await typeInto(byLabel('Password'), 'a-long-password-1')
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((b) => b.textContent?.trim() === 'Add user')!
      .click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [role="alert"]')!.textContent).toContain(
      'This username is already taken.',
    )
  })

  it('changes roles and explains refusals in the user language (Review Focus 4)', async () => {
    i18n.global.locale.value = 'tr'
    const { calls } = await usersTab({
      'PATCH users/u2': () => [409, { code: 'CONFLICT', message: 'x', details: { reason: 'last_admin' } }],
    })
    await choose(row('bob').querySelector('select') as HTMLSelectElement, 'viewer')
    await flushPromises()
    await confirmWith('benim-parolam-1')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      role: 'viewer',
      currentPassword: 'benim-parolam-1',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('En az bir etkin yönetici gerekir.')
    expect((row('bob').querySelector('select') as HTMLSelectElement).value).toBe('editor')
  })

  // Security audit 2026-10-16: a role change waits for the administrator's own password.
  it('changes no role when the administrator does not give their password', async () => {
    const { calls } = await usersTab({ 'PATCH users/u2': () => [200, { ...USERS[1], role: 'viewer' }] })
    await choose(row('bob').querySelector('select') as HTMLSelectElement, 'viewer')
    await flushPromises()
    expect(document.querySelector('[data-test="prompt-input"] input')).not.toBeNull()
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect((row('bob').querySelector('select') as HTMLSelectElement).value).toBe('editor')
  })

  // Review of the audit fixes (important 3): enabling an account again asks the password.
  it('enables a disabled account only with the administrator password', async () => {
    const { calls } = await usersTab({
      'GET users': () => [200, [USERS[0], { ...USERS[1], disabled: true }]],
      'PATCH users/u2': () => [200, USERS[1]],
    })
    await userAction('bob', 'Enable')
    await confirmWith('my-own-password-1')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      disabled: false,
      currentPassword: 'my-own-password-1',
    })
  })

  it('asks for a second factor when the server wants one, and tries again', async () => {
    let proved = false
    const { calls } = await usersTab({
      'PATCH users/u2': () =>
        proved
          ? [200, { ...USERS[1], role: 'viewer' }]
          : [
              403,
              {
                code: 'FORBIDDEN',
                message: 'x',
                details: { reason: 'step_up_required', methods: ['totp', 'recovery'] },
              },
            ],
      'POST auth/step-up': () => {
        proved = true
        return [204]
      },
    })
    await choose(row('bob').querySelector('select') as HTMLSelectElement, 'viewer')
    await flushPromises()
    await confirmWith('my-own-password-1')
    await confirmWith('123456')
    expect(calls.find((c) => c.path === 'auth/step-up')!.body).toEqual({ code: '123456' })
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2)
    expect(useToastStore().toasts.at(-1)?.message).toBe('User bob updated.')
  })

  it('resets password and two-factor, disables and deletes after confirmation', async () => {
    const { calls } = await usersTab({
      'POST users/u2/password': () => [204],
      'POST users/u2/reset-2fa': () => [204],
      'PATCH users/u2': () => [200, { ...USERS[1], disabled: true }],
      'DELETE users/u2': () => [204],
    })
    await userAction('bob', 'Reset password')
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'new-password-123',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    await confirmWith('my-own-password-1')
    expect(calls.find((c) => c.path === 'users/u2/password')!.body).toEqual({
      password: 'new-password-123',
      currentPassword: 'my-own-password-1',
    })
    await userAction('bob', 'Reset two-factor')
    await confirmWith('my-own-password-1')
    expect(calls.find((c) => c.path === 'users/u2/reset-2fa')!.body).toEqual({
      currentPassword: 'my-own-password-1',
    })
    await userAction('bob', 'Disable')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ disabled: true })
    await userAction('bob', 'Delete')
    const confirm = document.querySelector('[data-test="confirm"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await typeInto(document.querySelector('[data-test="require-text"] input') as HTMLInputElement, 'bob')
    confirm.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'users/u2')).toBe(true)
  })
})
