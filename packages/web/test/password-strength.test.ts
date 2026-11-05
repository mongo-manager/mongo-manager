// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import App from '../src/App.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import DsPasswordStrength from '../src/ds/DsPasswordStrength.vue'
import ChangePasswordForm from '../src/account/ChangePasswordForm.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

/** Password strength (2026-10-28): a meter and the rules wherever an account's password is chosen. */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const meter = (root: ParentNode = document) => root.querySelector<HTMLElement>('[data-password-strength]')!
const rule = (name: string, root: ParentNode = document) =>
  meter(root).querySelector<HTMLElement>(`[data-rule="${name}"]`)!

describe('the meter', () => {
  it('lists the rules before anything is typed, and no level', () => {
    mountApp(DsPasswordStrength, { props: { password: '' } })
    expect(rule('length').dataset.ok).toBe('false')
    expect(rule('length').textContent).toContain('At least 12 characters')
    expect(rule('guessable').dataset.ok).toBe('false')
    expect(meter().querySelector('[data-level]')).toBeNull()
    // No username given: no such rule.
    expect(meter().querySelector('[data-rule="username"]')).toBeNull()
  })

  it('says how strong the password is, and which rule it breaks', async () => {
    const { wrapper } = mountApp(DsPasswordStrength, {
      props: { password: 'Password1234!', username: 'ada' },
    })
    expect(meter().querySelector('[data-level]')!.textContent).toContain('Very weak')
    expect(rule('length').dataset.ok).toBe('true')
    expect(rule('username').dataset.ok).toBe('true')
    expect(rule('guessable').dataset.ok).toBe('false')
    await wrapper.setProps({ password: 'ada-kahve-bardagi-mavi' })
    expect(rule('username').dataset.ok).toBe('false')
    expect(meter().querySelector('[data-level]')!.textContent).toContain('Very weak')
    await wrapper.setProps({ password: 'correct-horse-battery-1' })
    expect(meter().querySelector('[data-level]')!.textContent).toContain('Very strong')
    expect(
      [...meter().querySelectorAll<HTMLElement>('[data-rule]')].every((r) => r.dataset.ok === 'true'),
    ).toBe(true)
    // Four bars, all lit for a very strong password.
    expect(meter().querySelectorAll('[data-bar][data-lit="true"]')).toHaveLength(4)
  })

  it('never calls a short password hard to guess just because it is short', async () => {
    const { wrapper } = mountApp(DsPasswordStrength, { props: { password: 'abc' } })
    expect(rule('length').dataset.ok).toBe('false')
    expect(rule('guessable').dataset.ok).toBe('false')
    await wrapper.setProps({ password: 'Xk9#mQ2$' })
    expect(rule('length').dataset.ok).toBe('false')
    expect(rule('guessable').dataset.ok).toBe('true')
  })

  // Final review M2: refused and accepted-but-weak do not look alike.
  it('lights more bars, and another colour, for weak than for refused', async () => {
    const { wrapper } = mountApp(DsPasswordStrength, { props: { password: 'Password1234!' } })
    const lit = () => [...meter().querySelectorAll<HTMLElement>('[data-bar][data-lit="true"]')]
    expect(lit()).toHaveLength(1)
    expect(lit()[0]!.className).toContain('bg-danger')
    await wrapper.setProps({ password: '739284615082' })
    expect(meter().querySelector('[data-level]')!.textContent).toContain('Weak')
    expect(lit()).toHaveLength(2)
    expect(lit()[0]!.className).toContain('bg-warning')
  })

  it('says when a password is too long rather than too short (M8)', () => {
    mountApp(DsPasswordStrength, { props: { password: 'x9#'.repeat(400) } })
    expect(rule('length').textContent).toContain('At most 1024 characters')
    expect(rule('length').dataset.ok).toBe('false')
  })

  it('keeps the username rule listed from the start when there is a username to come (M8)', () => {
    mountApp(DsPasswordStrength, { props: { password: '', username: '' } })
    expect(rule('username')).not.toBeNull()
  })

  it('announces the level politely, and says it in Turkish too', async () => {
    i18n.global.locale.value = 'tr'
    mountApp(DsPasswordStrength, { props: { password: 'correct-horse-battery-1' } })
    const level = meter().querySelector('[data-level]')!
    expect(level.closest('[aria-live="polite"]')).not.toBeNull()
    expect(level.textContent).toContain('Çok güçlü')
    expect(rule('length').textContent).toContain('En az 12 karakter')
  })
})

describe('where an account password is chosen', () => {
  it('the first-run set-up, with the username typed', async () => {
    mockApi({ 'GET auth/status': () => [200, { mode: 'team', setupRequired: true, authenticated: false }] })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(App, { plugins: [router] })
    await flushPromises()
    await vi.waitFor(() => expect(document.querySelector('[data-password-strength]')).not.toBeNull())
    await typeInto(byLabel('Username'), 'gokhan')
    await typeInto(byLabel('Password'), 'gokhan-sifre-2026')
    expect(rule('username').dataset.ok).toBe('false')
    // Final review M3: the field is described by the meter, for screen readers.
    expect(meter().id).not.toBe('')
    const described = byLabel('Password').getAttribute('aria-describedby') ?? ''
    expect(described.split(' ')).toContain(meter().id)
  })

  it('changing one’s own password, with one’s own username', async () => {
    mountApp(ChangePasswordForm)
    useSessionStore().me = {
      mode: 'team',
      user: { id: 'u1', username: 'ada', role: 'admin' },
      permissions: [...PERMISSIONS],
      csrfToken: 'c',
      readOnly: false,
      twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
    } as never
    await typeInto(byLabel('New password'), 'ada-kahve-bardagi')
    expect(rule('username').dataset.ok).toBe('false')
    // One meter: the new password's, not the current one's nor the repeat's.
    expect(document.querySelectorAll('[data-password-strength]')).toHaveLength(1)
    expect(meter().id).not.toBe('')
    expect((byLabel('New password').getAttribute('aria-describedby') ?? '').split(' ')).toContain(meter().id)
  })

  async function usersTab() {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 10 },
        },
      ],
      'GET connections': () => [200, []],
      'GET users': () => [
        200,
        [
          {
            id: 'u1',
            username: 'ada',
            role: 'admin',
            totpEnabled: true,
            disabled: false,
            createdAt: 0,
            passwordChangedAt: 0,
          },
          {
            id: 'u2',
            username: 'bob',
            role: 'editor',
            totpEnabled: false,
            disabled: false,
            createdAt: 0,
            passwordChangedAt: 0,
          },
        ],
      ],
      'GET users/policy': () => [200, { adminTwoFactor: false, forced: false }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    tabs.open({ kind: 'users', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    mountApp(DialogHost)
    await vi.waitFor(() => expect(document.querySelector('main tbody tr')).not.toBeNull())
    await flushPromises()
  }

  it('adding a user, with the new user’s name', async () => {
    await usersTab()
    button('Add user').click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!
    await typeInto(byLabel('Username'), 'deniz')
    await typeInto(byLabel('Password'), 'deniz-kahve-bardagi')
    expect(rule('username', dialog).dataset.ok).toBe('false')
    // Only the new password has a meter, not the administrator's own.
    expect(dialog.querySelectorAll('[data-password-strength]')).toHaveLength(1)
  })

  it('resetting a user’s password, with that user’s name', async () => {
    await usersTab()
    const row = [...document.querySelectorAll('main tbody tr')].find((r) => r.textContent?.includes('bob'))!
    row.querySelector<HTMLButtonElement>('button[aria-label="Actions for bob"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Reset password')!
      .click()
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')!
    await typeInto(
      dialog.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'bob-kahve-bardagi',
    )
    expect(rule('username', dialog).dataset.ok).toBe('false')
    expect(meter(dialog).querySelector('[data-level]')!.textContent).toContain('Very weak')
  })

  // Final review M4: a password the server refuses is not confirmed, so nothing typed after is lost.
  it('takes no refused password to the next step, and asks the own password without a meter', async () => {
    await usersTab()
    const row = [...document.querySelectorAll('main tbody tr')].find((r) => r.textContent?.includes('bob'))!
    row.querySelector<HTMLButtonElement>('button[aria-label="Actions for bob"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Reset password')!
      .click()
    await flushPromises()
    const input = () => document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement
    const confirm = () => document.querySelector('[data-test="confirm"]') as HTMLButtonElement
    await typeInto(input(), 'Password1234!')
    expect(confirm().disabled).toBe(true)
    await typeInto(input(), 'violet-harbour-quartz-58')
    expect(confirm().disabled).toBe(false)
    confirm().click()
    await flushPromises()
    // The administrator's own password: no meter.
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Your password'),
    )
    expect(document.querySelector('[role="dialog"] [data-password-strength]')).toBeNull()
  })

  it('never on a prompt that asks for the administrator’s own password', async () => {
    await usersTab()
    const row = [...document.querySelectorAll('main tbody tr')].find((r) => r.textContent?.includes('bob'))!
    row.querySelector<HTMLButtonElement>('button[aria-label="Actions for bob"]')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === 'Reset two-factor')!
      .click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"] [data-password-strength]')).toBeNull()
  })
})
