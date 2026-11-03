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
import { byLabel, choose, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const ME = (mode: 'team' | 'local', permissions: string[] = [...PERMISSIONS]) => ({
  mode,
  user: {
    id: mode === 'local' ? 'local' : 'u1',
    username: mode === 'local' ? 'owner' : 'ada',
    role: 'admin',
  },
  permissions,
  csrfToken: 'csrf-1',
  readOnly: false,
  twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
})

async function workspace(
  mode: 'team' | 'local',
  handlers: Record<string, Handler> = {},
  permissions?: string[],
) {
  const api = mockApi({
    'GET auth/status': () => [200, { mode, setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, ME(mode, permissions)],
    'GET connections': () => [200, []],
    'GET auth/passkeys/support': () => [200, { available: true }],
    'GET auth/passkeys': () => [200, []],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await flushPromises()
  return api
}

async function openMenuItem(label: string) {
  ;(document.querySelector('button[aria-label^="Account menu"]') as HTMLButtonElement).click()
  await flushPromises()
  ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((m) => m.textContent?.trim() === label)!
    .click()
  // Home has headings too (and the only h1): wait until it is replaced by the opened view.
  await vi.waitFor(() => {
    expect(document.querySelector('main h1')).toBeNull()
    expect(document.querySelector('main h2')?.textContent).toBeTruthy()
  })
  await flushPromises()
}

describe('user menu', () => {
  it('offers admin screens only with the matching permissions', async () => {
    await workspace('team', {}, ['connections:read', 'databases:read', 'documents:read'])
    ;(document.querySelector('button[aria-label^="Account menu"]') as HTMLButtonElement).click()
    await flushPromises()
    // UI redesign R1 revision 2 §3.2: the account's own items; administration is in the sidebar.
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())).toEqual([
      'Account settings',
      'Documentation',
      // User request 2026-10-31: the About page, for everyone.
      'About Mongo Manager',
      'Sign out',
    ])
    const sidebar = document.querySelector('nav[aria-label="Application"]')!
    // Phase 3d-3c and 3e-2: scheduled backups and live syncs are for everyone; no admin screen is offered.
    expect(sidebar.textContent).toContain('Automations')
    expect(sidebar.textContent).not.toContain('Integrations')
    const activity = [...sidebar.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Activity'),
    )!
    activity.click()
    await flushPromises()
    expect(sidebar.textContent).not.toContain('Audit log')
  })
})

// The section list beside the cards names "Change password" too: the form's own button submits.
const submitPassword = () =>
  [...document.querySelectorAll<HTMLButtonElement>('form button[type="submit"]')]
    .find((b) => b.textContent?.trim() === 'Change password')!
    .click()

describe('account tab', () => {
  it('changes the password and keeps working with the rotated CSRF token (Review Focus 3)', async () => {
    // Like the server: the change rotates the session, and /auth/me reports the new token.
    let token = 'csrf-1'
    const { calls } = await workspace('team', {
      'POST auth/password': () => {
        token = 'csrf-2'
        return [200, { csrfToken: token }]
      },
      'GET auth/me': () => [200, { ...ME('team'), csrfToken: token }],
    })
    await openMenuItem('Account settings')
    expect(useTabsStore().active?.kind).toBe('account')
    expect(document.querySelector('main')!.textContent).toContain('ada')
    await typeInto(byLabel('Current password'), 'old-password-1')
    await typeInto(byLabel('New password'), 'new-password-12')
    await typeInto(byLabel('Repeat new password'), 'different-pass')
    submitPassword()
    await flushPromises()
    expect(document.body.textContent).toContain('The new passwords do not match.')
    await typeInto(byLabel('Repeat new password'), 'new-password-12')
    submitPassword()
    await flushPromises()
    expect(calls.find((c) => c.path === 'auth/password')!.body).toEqual({
      currentPassword: 'old-password-1',
      newPassword: 'new-password-12',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'Password changed. Your other sessions were signed out.',
    )
    await typeInto(byLabel('Current password'), 'x')
    // Next request must carry the rotated token.
    const probe = mockApi({
      'POST auth/password': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'Current password is incorrect' },
      ],
      'GET auth/me': () => [200, ME('team')],
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    })
    await typeInto(byLabel('New password'), 'new-password-13')
    await typeInto(byLabel('Repeat new password'), 'new-password-13')
    submitPassword()
    await flushPromises()
    expect(probe.calls[0]!.headers['x-csrf-token']).toBe('csrf-2')
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Current password is incorrect')
  })

  // Review of R3–R5 (I-7): one h1 on the screen — Home's own, or the workspace's (for screen readers)
  // above a page whose title is an h2.
  it('keeps one first-level heading, Home’s or the workspace’s', async () => {
    await workspace('local')
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    await openMenuItem('Account settings')
    const h1 = document.querySelectorAll('h1')
    expect(h1).toHaveLength(1)
    expect(h1[0]!.className).toContain('sr-only')
    expect(h1[0]!.textContent).toBe('Mongo Manager')
    expect(document.querySelector('main header h2')!.textContent).toContain('Account')
  })

  it('shows only preferences in local mode and applies them', async () => {
    await workspace('local')
    await openMenuItem('Account settings')
    expect(document.body.textContent).toContain('Local mode has no user accounts.')
    expect(document.body.textContent).not.toContain('Change password')
    await choose(byLabel<HTMLSelectElement>('Language'), 'tr')
    expect(document.documentElement.lang).toBe('tr')
    expect(
      document.querySelector('[role="tab"][aria-selected="true"], [role="tablist"] button')!.textContent,
    ).toContain('Hesap')
  })
})
