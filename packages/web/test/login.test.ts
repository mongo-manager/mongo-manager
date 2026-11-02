import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import LoginView from '../src/views/LoginView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(async () => ({ id: 'cred' })) }))

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'PublicKeyCredential')
  Reflect.deleteProperty(window, 'isSecureContext')
})

async function signIn(handlers: Parameters<typeof mockApi>[0]) {
  const api = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: false }],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/login')
  const { wrapper } = mountApp(LoginView, { plugins: [router] })
  await wrapper.get('input[autocomplete="username"]').setValue('ada')
  await wrapper.get('input[autocomplete="current-password"]').setValue('secret-password')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  return { wrapper, api, router }
}

describe('login screen', () => {
  it('shows a generic error for wrong credentials', async () => {
    const { wrapper } = await signIn({
      'POST auth/login': () => [401, { code: 'UNAUTHENTICATED', message: 'Invalid username or password' }],
    })
    expect(wrapper.get('[role="alert"]').text()).toBe('Invalid username or password.')
  })

  it('asks for a second factor, hides passkeys without WebAuthn, and handles wrong and expired codes (Review Focus 2, 3)', async () => {
    let attempts = 0
    const { wrapper } = await signIn({
      'POST auth/login': () => [
        200,
        { mfaRequired: true, ticket: 't1', methods: ['totp', 'passkey', 'recovery'] },
      ],
      'POST auth/login/totp': () =>
        ++attempts === 1
          ? [401, { code: 'UNAUTHENTICATED', message: 'Invalid two-factor code' }]
          : [
              401,
              {
                code: 'UNAUTHENTICATED',
                message: 'Sign-in session expired; enter your password again',
                details: { reason: 'mfa_ticket_expired' },
              },
            ],
    })
    expect(wrapper.text()).toContain('Two-factor authentication')
    expect(wrapper.text()).not.toContain('Passkey')
    // UI redesign R5: the code's kind is one choice of two — a labelled radio group, not tabs.
    const methods = wrapper.get('[role="radiogroup"][aria-label="Second factor"]')
    expect(methods.findAll('[role="radio"]').map((r) => r.text())).toEqual([
      'Authenticator app',
      'Recovery code',
    ])
    expect(wrapper.find('[role="tab"]').exists()).toBe(false)
    // Review of R3–R5, minor 17: it spans the card, its two choices sharing it alike.
    expect(methods.classes()).toContain('w-full')
    for (const r of methods.findAll('[role="radio"]')) expect(r.classes()).toContain('flex-1')
    await wrapper.get('input[autocomplete="one-time-code"]').setValue('000000')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('That code is not valid.')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(
      'The sign-in session expired. Enter your password again.',
    )
    expect(wrapper.find('input[autocomplete="current-password"]').exists()).toBe(true)
  })

  it('offers passkeys when WebAuthn exists and completes sign-in', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: function PublicKeyCredential() {},
      configurable: true,
    })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    let signedIn = false
    const { wrapper, router } = await signIn({
      'POST auth/login': () => [200, { mfaRequired: true, ticket: 't1', methods: ['passkey', 'recovery'] }],
      'POST auth/login/passkey/options': () => [200, { challenge: 'c' }],
      'POST auth/login/passkey': () => {
        signedIn = true
        return [200, { csrfToken: 'x' }]
      },
    })
    vi.unstubAllGlobals()
    mockApi({
      'POST auth/login/passkey/options': () => [200, { challenge: 'c' }],
      'POST auth/login/passkey': () => {
        signedIn = true
        return [200, { csrfToken: 'x' }]
      },
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u', username: 'ada', role: 'admin' },
          permissions: [],
          csrfToken: 'x',
          readOnly: false,
          twoFactor: {},
        },
      ],
    })
    await wrapper.get('[data-test="use-passkey"]').trigger('click')
    await flushPromises()
    expect(signedIn).toBe(true)
    // The workspace route is lazy-loaded, so navigation settles after the dynamic import.
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('workspace'), { timeout: 5000 })
  })
})

describe('signing in from a link (phase 1g-2, Review Focus 1)', () => {
  async function signInFrom(next: string) {
    let signedIn = false
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: signedIn }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'POST auth/login': () => {
        signedIn = true
        return [200, { csrfToken: 'c' }]
      },
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push({ path: '/login', query: { next } })
    const { wrapper } = mountApp(LoginView, { plugins: [router] })
    await wrapper.get('input[autocomplete="username"]').setValue('ada')
    await wrapper.get('input[autocomplete="current-password"]').setValue('secret-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    return router
  }

  it('returns to the link after signing in', async () => {
    expect((await signInFrom('/c/c1/db/shop')).currentRoute.value.fullPath).toBe('/c/c1/db/shop')
  })

  it('never follows a link to another site', async () => {
    expect((await signInFrom('//evil.example/x')).currentRoute.value.name).toBe('workspace')
  })
})
