// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import SetupView from '../src/views/SetupView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import AccessCard from '../src/workspace/tabs/AccessCard.vue'
import RecoveryCodesDialog from '../src/account/RecoveryCodesDialog.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { ApiError, api, setCsrfToken } from '../src/api/client'
import { explainError } from '../src/api/reasons'
import { useCommandsStore } from '../src/stores/commands'
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
  setCsrfToken(undefined)
})

const t = i18n.global.t as (key: string, values?: Record<string, unknown>) => string
const refusal = (status: number, code: string, message: string, details?: unknown) =>
  new ApiError(status, code, message, details)

const ME = (mode: 'team' | 'local') => ({
  mode,
  user: {
    id: mode === 'local' ? 'local' : 'u1',
    username: mode === 'local' ? 'owner' : 'ada',
    role: 'admin',
  },
  permissions: [...PERMISSIONS],
  csrfToken: 'csrf-1',
  readOnly: false,
  twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
})

async function workspace(mode: 'team' | 'local', handlers: Record<string, Handler> = {}) {
  const api = mockApi({
    'GET auth/status': () => [200, { mode, setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, ME(mode)],
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

describe('local mode has no user administration (Important 1)', () => {
  it('offers no Users screen and the audit log asks for no user list', async () => {
    const { calls } = await workspace('local', { 'GET audit': () => [200, []] })
    ;(document.querySelector('button[aria-label^="Account menu"]') as HTMLButtonElement).click()
    await flushPromises()
    // Local mode: no Users and no Sign out in the account menu (UI redesign R1 revision 2 §3.2).
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent?.trim())).toEqual([
      'Account settings',
      'Documentation',
      'About Mongo Manager',
    ])
    expect(useCommandsStore().commands.some((c) => c.id === 'users')).toBe(false)
    // The administration lives in the sidebar; destinations exist in local mode too (phase 3d-3b).
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    const sidebar = document.querySelector('nav[aria-label="Application"]')!
    const group = (name: string) =>
      [...sidebar.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) =>
        b.textContent?.includes(name),
      )!
    group('Integrations').click()
    await flushPromises()
    expect(sidebar.textContent).toContain('Backup destinations')
    expect(sidebar.textContent).toContain('AI providers')
    group('Activity').click()
    await flushPromises()
    ;[...sidebar.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Audit log')!
      .click()
    await vi.waitFor(() => expect(calls.some((c) => c.path === 'audit')).toBe(true), { timeout: 5000 })
    await flushPromises()
    expect(calls.some((c) => c.path === 'users')).toBe(false)
  })
})

describe('account refusals in the user language (Important 2)', () => {
  it('explains reasons, lists password problems and keeps other errors generic', () => {
    i18n.global.locale.value = 'tr'
    expect(
      explainError(
        refusal(400, 'VALIDATION_ERROR', 'Password is incorrect', { reason: 'wrong_password' }),
        t,
      ),
    ).toBe('Şifre yanlış.')
    expect(
      explainError(
        refusal(400, 'VALIDATION_ERROR', 'Password must be at least 12 characters', {
          reason: 'weak_password',
          problems: ['too_short', 'contains_username'],
        }),
        t,
      ),
    ).toBe('Şifre kabul edilmedi: en az 12 karakter olmalı; kullanıcı adını içermemeli.')
    expect(
      explainError(refusal(409, 'CONFLICT', 'x', { reason: 'passkeys_unavailable', why: 'ip-address' }), t),
    ).toBe(t('security.passkeys.unavailableIp'))
    expect(explainError(refusal(409, 'CONFLICT', 'x', { reason: 'last_admin' }), t)).toBe(
      'En az bir etkin yönetici gerekir.',
    )
    // Unknown validation text is still better than nothing; other failures stay generic.
    expect(explainError(refusal(400, 'VALIDATION_ERROR', 'Something specific'), t)).toBe('Something specific')
    expect(explainError(refusal(403, 'FORBIDDEN', 'raw'), t)).toBe(t('errors.FORBIDDEN'))
    // Review of L2: a step-up asked again, and an administrator's own second factors.
    expect(explainError(refusal(403, 'FORBIDDEN', 'x', { reason: 'step_up_required' }), t)).toBe(
      'Önce ikinci faktörlerinizden birini doğrulayın.',
    )
    expect(explainError(refusal(502, 'UPSTREAM_ERROR', 'x', { reason: 'github_digest_unknown' }), t)).toBe(
      'Sürüm, arşivinin sağlama toplamını bu sürümün denetleyemediği bir biçimde veriyor. Hiçbir şey kurulmadı.',
    )
    expect(explainError(refusal(502, 'UPSTREAM_ERROR', 'x', { reason: 'github_digest' }), t)).toBe(
      'İndirilen arşiv, sürümün yayımladığı arşiv değil. Hiçbir şey kurulmadı.',
    )
    expect(explainError(refusal(409, 'CONFLICT', 'x', { reason: 'self_2fa_reset' }), t)).toBe(
      'Kendi iki adımlı doğrulama ayarlarınızı Hesap ayarlarından yönetin.',
    )
    // Security review 2026-10-13 (low): the server's total transfer storage, apart from the user's own.
    expect(explainError(refusal(409, 'CONFLICT', 'x', { reason: 'transfer_full' }), t)).toBe(
      'Sunucunun aktarım depolama alanı dolu. Bir yöneticiye haber verin ya da eski dosyaların süresinin dolmasını bekleyin.',
    )
  })

  it('shows the authenticator setup refusal in Turkish', async () => {
    i18n.global.locale.value = 'tr'
    await workspace('team', {
      'POST auth/totp/enroll': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'Password is incorrect', details: { reason: 'wrong_password' } },
      ],
    })
    useTabsStore().open({ kind: 'account', title: '' })
    await vi.waitFor(() => expect(document.body.textContent).toContain('İki adımlı doğrulama'), {
      timeout: 5000,
    })
    await flushPromises()
    button('Kur').click()
    await vi.waitFor(() => expect(document.querySelector('[data-test="prompt-input"] input')).not.toBeNull())
    await typeInto(document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement, 'nope')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.message).toBe('Şifre yanlış.')
  })

  it('shows password policy problems of the change-password form in Turkish', async () => {
    i18n.global.locale.value = 'tr'
    await workspace('team', {
      'POST auth/password': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Password is too common',
          details: { reason: 'weak_password', problems: ['too_common'] },
        },
      ],
    })
    useTabsStore().open({ kind: 'account', title: '' })
    await vi.waitFor(() => expect(document.querySelector('main form')).not.toBeNull(), { timeout: 5000 })
    await typeInto(byLabel('Mevcut şifre'), 'old-password-1')
    await typeInto(byLabel('Yeni şifre'), 'password1234')
    await typeInto(byLabel('Yeni şifre (tekrar)'), 'password1234')
    button('Şifreyi değiştir').click()
    await flushPromises()
    expect(document.querySelector('main [role="alert"]')!.textContent).toContain(
      'Şifre kabul edilmedi: çok yaygın.',
    )
  })

  it('explains a refused first-run password', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: true, authenticated: false }],
      'POST auth/setup': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'x',
          details: { reason: 'weak_password', problems: ['repeated_char'] },
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/setup')
    const { wrapper } = mountApp(SetupView, { plugins: [router] })
    await typeInto(byLabel('Setup token'), 'tok')
    await typeInto(byLabel('Username'), 'admin')
    await typeInto(byLabel('Password'), 'aaaaaaaaaaaaaa')
    await typeInto(byLabel('Repeat password'), 'aaaaaaaaaaaaaa')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(
      'The password is not accepted: it must not repeat a single character.',
    )
  })
})

describe('access grants (Minor 1)', () => {
  it('shows the stored grant again when a change is refused', async () => {
    mockApi({
      'GET users': () => [
        200,
        [
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
      'GET connections/c1/grants': () => [200, []],
      'PUT connections/c1/grants/u2': () => [403, { code: 'FORBIDDEN', message: 'x' }],
    })
    mountApp(AccessCard, { props: { connection: { id: 'c1', name: 'Prod' } } })
    await flushPromises()
    const select = () => byLabel<HTMLSelectElement>('Access of bob')
    await choose(select(), 'none')
    await flushPromises()
    expect(select().value).toBe('inherit')
  })
})

describe('prompts for someone else’s password (Minor 2)', () => {
  it('mark the reset-password field as a new password', async () => {
    await workspace('team', {
      'GET users': () => [
        200,
        [
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
    })
    useTabsStore().bindUser('u1')
    useTabsStore().open({ kind: 'users', title: '' })
    await vi.waitFor(
      () => expect(document.querySelector('button[aria-label="Actions for bob"]')).not.toBeNull(),
      { timeout: 5000 },
    )
    ;(document.querySelector('button[aria-label="Actions for bob"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Reset password')!
      .click()
    await vi.waitFor(() => expect(document.querySelector('[data-test="prompt-input"] input')).not.toBeNull())
    expect(document.querySelector('[data-test="prompt-input"] input')!.getAttribute('autocomplete')).toBe(
      'new-password',
    )
  })
})

describe('recovery codes dialog (Minor 5)', () => {
  it('is not dismissed by Escape or a backdrop click; only the explicit button closes it', async () => {
    const { wrapper } = mountApp(RecoveryCodesDialog, { props: { codes: ['a', 'b'] } })
    await nextTick()
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ;(dialog.parentElement!.querySelector(':scope > [aria-hidden="true"]') as HTMLElement).click()
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(dialog.querySelector('button[aria-label="Close"]')).toBeNull()
    button('I have saved them').click()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('CSRF token rotated by another tab (Minor 6)', () => {
  it('refreshes the token once and retries the write', async () => {
    setCsrfToken('stale')
    let posts = 0
    const { calls } = mockApi({
      'GET auth/me': () => [200, ME('team')],
      'POST things': () => {
        posts++
        return posts === 1
          ? [403, { code: 'FORBIDDEN', message: 'x', details: { reason: 'csrf' } }]
          : [200, { ok: true }]
      },
    })
    expect(await api.post('things', { a: 1 })).toEqual({ ok: true })
    const writes = calls.filter((c) => c.path === 'things')
    expect(writes.map((c) => c.headers['x-csrf-token'])).toEqual(['stale', 'csrf-1'])
  })

  it('does not retry other refusals', async () => {
    setCsrfToken('c')
    const { calls } = mockApi({ 'POST things': () => [403, { code: 'FORBIDDEN', message: 'x' }] })
    await expect(api.post('things', {})).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(1)
  })
})
