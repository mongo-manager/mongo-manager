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
import { button, byLabel, typeInto } from './support/dom'

const startRegistration = vi.hoisted(() => vi.fn(async () => ({ id: 'cred-1', response: {} })))
vi.mock('@simplewebauthn/browser', () => ({ startRegistration, startAuthentication: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true })
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'PublicKeyCredential')
  Reflect.deleteProperty(window, 'isSecureContext')
})

const twoFactor = { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 }
let meTwoFactor = { ...twoFactor }

async function account(handlers: Record<string, Handler>) {
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
        twoFactor: meTwoFactor,
      },
    ],
    'GET connections': () => [200, []],
    'GET auth/passkeys/support': () => [200, { available: true }],
    'GET auth/passkeys': () => [200, []],
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser('u1')
  tabs.open({ kind: 'account', title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  // The account view is a lazily loaded chunk: under a busy parallel run it can take over a second.
  await vi.waitFor(() => expect(document.body.textContent).toContain('Two-factor authentication'), {
    timeout: 5000,
  })
  await flushPromises()
  return api
}

async function answerPrompt(value: string) {
  await vi.waitFor(() => expect(document.querySelector('[data-test="prompt-input"] input')).not.toBeNull())
  await typeInto(document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement, value)
  ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
  await flushPromises()
}

describe('authenticator app', () => {
  beforeEach(() => {
    meTwoFactor = { ...twoFactor }
  })

  it('enrolls with the password, shows a QR code and the key, confirms and shows recovery codes', async () => {
    const { calls } = await account({
      'POST auth/totp/enroll': () => [
        200,
        {
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/Mongo%20Manager:ada?secret=JBSWY3DPEHPK3PXP&issuer=Mongo%20Manager',
        },
      ],
      'POST auth/totp/confirm': () => {
        meTwoFactor = { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 10 }
        return [200, { recoveryCodes: Array.from({ length: 10 }, (_, i) => `code-${i}`) }]
      },
    })
    button('Set up').click()
    await answerPrompt('pw')
    expect(calls.find((c) => c.path === 'auth/totp/enroll')!.body).toEqual({ password: 'pw' })
    expect(
      document.querySelector('svg[role="img"][shape-rendering="crispEdges"] path')!.getAttribute('d'),
    ).toMatch(/^M\d+ \d+h1v1h-1z/)
    expect(document.querySelector('[data-test="totp-secret"]')!.textContent).toContain('JBSW Y3DP')
    await typeInto(byLabel('6-digit code'), '123456')
    button('Verify and turn on').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'auth/totp/confirm')!.body).toEqual({ code: '123456' })
    expect(document.querySelectorAll('[data-test="recovery-codes"] li')).toHaveLength(10)
    button('I have saved them').click()
    await flushPromises()
    expect(document.body.textContent).toContain('An authenticator app is set up.')
    expect(document.body.textContent).toContain('10 unused codes left.')
  })

  it('turns off with password and a current code', async () => {
    meTwoFactor = { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 3 }
    const { calls } = await account({ 'POST auth/totp/disable': () => [204] })
    button('Turn off').click()
    await answerPrompt('pw')
    await answerPrompt('654321')
    expect(calls.find((c) => c.path === 'auth/totp/disable')!.body).toEqual({
      password: 'pw',
      code: '654321',
    })
    expect(useToastStore().toasts.at(-1)?.message).toBe('Authenticator app turned off.')
  })
})

describe('passkeys', () => {
  beforeEach(() => {
    meTwoFactor = { ...twoFactor }
  })

  it('explains why passkeys are unavailable on an IP address and offers no Add (Review Focus 2)', async () => {
    await account({
      'GET auth/passkeys/support': () => [200, { available: false, reason: 'ip-address', message: 'x' }],
    })
    expect(document.body.textContent).toContain('Passkeys cannot be used on an IP address.')
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Add passkey'),
    ).toBe(false)
    expect(document.body.textContent).toContain('Set up')
  })

  it('adds, renames and removes passkeys', async () => {
    let list = [] as Array<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }>
    const { calls } = await account({
      'GET auth/passkeys': () => [200, list],
      'POST auth/passkeys/options': () => [200, { challenge: 'ch' }],
      'POST auth/passkeys': (body) => {
        list = [
          {
            id: 'k/1',
            name: (body as { name: string }).name,
            createdAt: Date.UTC(2026, 8, 1),
            lastUsedAt: null,
          },
        ]
        return [200, { passkey: list[0], recoveryCodes: ['r1', 'r2'] }]
      },
      'PATCH auth/passkeys/k%2F1': (body) => [200, { ...list[0], ...(body as object) }],
      'DELETE auth/passkeys/k%2F1': () => [204],
    })
    await typeInto(byLabel('Passkey name'), 'Work laptop')
    button('Add passkey').click()
    await answerPrompt('pw')
    await vi.waitFor(() =>
      expect(calls.some((c) => c.path === 'auth/passkeys' && c.method === 'POST')).toBe(true),
    )
    expect(calls.find((c) => c.path === 'auth/passkeys/options')!.body).toEqual({ password: 'pw' })
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'ch' } })
    expect(calls.find((c) => c.path === 'auth/passkeys' && c.method === 'POST')!.body).toEqual({
      name: 'Work laptop',
      response: { id: 'cred-1', response: {} },
    })
    expect(document.querySelectorAll('[data-test="recovery-codes"] li')).toHaveLength(2)
    button('I have saved them').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Work laptop')
    ;(document.querySelector('button[aria-label="Actions for Work laptop"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Rename')!
      .click()
    await answerPrompt(' Home PC')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Home PC' })
    ;(document.querySelector('button[aria-label^="Actions for"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Remove')!
      .click()
    await answerPrompt('pw')
    expect(calls.find((c) => c.method === 'DELETE')!.body).toEqual({ password: 'pw' })
  })
})

describe('recovery codes', () => {
  it('regenerates them with the password', async () => {
    meTwoFactor = { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 2 }
    const { calls } = await account({
      'POST auth/recovery-codes': () => [200, { recoveryCodes: ['a', 'b', 'c'] }],
    })
    expect(document.body.textContent).toContain('2 unused codes left.')
    button('Create new codes').click()
    await answerPrompt('pw')
    expect(calls.find((c) => c.path === 'auth/recovery-codes')!.body).toEqual({ password: 'pw' })
    expect(document.querySelectorAll('[data-test="recovery-codes"] li')).toHaveLength(3)
  })

  // Security review 2026-10-13 (L2): managing second factors takes one proved lately; the app asks
  // for it and tries again.
  it('asks for a second factor when the server wants one, then tries again', async () => {
    meTwoFactor = { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 2 }
    let proved = false
    const { calls } = await account({
      'POST auth/recovery-codes': () =>
        proved
          ? [200, { recoveryCodes: ['a', 'b'] }]
          : [
              403,
              {
                code: 'FORBIDDEN',
                message: 'Confirm one of your second factors first',
                details: { reason: 'step_up_required', methods: ['totp', 'recovery'] },
              },
            ],
      'POST auth/step-up': (body) => {
        proved = (body as { code: string }).code === '123456'
        return proved ? [204] : [400, { code: 'VALIDATION_ERROR', message: 'The code is not right' }]
      },
    })
    button('Create new codes').click()
    await answerPrompt('pw')
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Enter a code from your authenticator app'),
    )
    await answerPrompt('123456')
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-test="recovery-codes"] li')).toHaveLength(2),
    )
    expect(calls.filter((c) => c.path === 'auth/recovery-codes').map((c) => c.body)).toEqual([
      { password: 'pw' },
      { password: 'pw' },
    ])
    expect(calls.find((c) => c.path === 'auth/step-up')!.body).toEqual({ code: '123456' })
  })

  it('stops quietly when the second factor is not given', async () => {
    meTwoFactor = { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 2 }
    const { calls } = await account({
      'POST auth/recovery-codes': () => [
        403,
        {
          code: 'FORBIDDEN',
          message: 'Confirm one of your second factors first',
          details: { reason: 'step_up_required', methods: ['totp', 'recovery'] },
        },
      ],
    })
    button('Create new codes').click()
    await answerPrompt('pw')
    await vi.waitFor(() => expect(document.querySelector('[data-test="prompt-input"] input')).not.toBeNull())
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.filter((c) => c.path === 'auth/recovery-codes')).toHaveLength(1)
    expect(useToastStore().toasts).toHaveLength(0)
  })
})
