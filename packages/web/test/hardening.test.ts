import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import LoginView from '../src/views/LoginView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import UnavailableView from '../src/views/UnavailableView.vue'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { api, onUnauthenticated } from '../src/api/client'
import { passkeysAvailable } from '../src/auth/passkeys'
import { useTabsStore } from '../src/stores/tabs'
import { commandTitle, useCommandsStore } from '../src/stores/commands'
import { useDialogStore } from '../src/stores/dialogs'
import { usePreferencesStore } from '../src/stores/preferences'
import { useDashboardStore } from '../src/stores/dashboard'
import { mockApi, mountApp } from './support/app'

const startAuthentication = vi.hoisted(() => vi.fn())
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication }))

const ME = {
  mode: 'team',
  user: { id: 'u1', username: 'ada', role: 'admin' },
  permissions: [],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: {},
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'PublicKeyCredential')
  Reflect.deleteProperty(window, 'isSecureContext')
})

describe('sign-out', () => {
  it('returns to the login screen and forgets the previous user’s tabs and cached data', async () => {
    let signedIn = true
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: signedIn }],
      'GET auth/me': () => [200, ME],
      'GET connections': () => [
        200,
        [
          {
            id: 'c1',
            name: 'Prod',
            group: null,
            color: null,
            favorite: false,
            readOnly: false,
            access: 'admin',
            permissions: [],
          },
        ],
      ],
      'POST auth/logout': () => {
        signedIn = false
        return [204]
      },
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const { wrapper, queryClient } = mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    await wrapper.get('[data-test="connection"]').trigger('click')
    expect(localStorage.getItem('mm:tabs')).toContain('Prod')
    const dashboard = useDashboardStore()
    dashboard.widgets = [
      { id: '00000000-0000-4000-8000-000000000001', type: 'quick', size: 'm', settings: {} },
    ]
    // UI redesign R1 revision 2 §3.2: Sign out is the account menu's last item.
    ;(document.querySelector('button[aria-label^="Account menu"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === 'Sign out')!
      .click()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'))
    expect(useTabsStore().tabs.map((t) => t.kind)).toEqual(['welcome'])
    expect(localStorage.getItem('mm:tabs')).toBeNull()
    // UI redesign R1 revision 2 §3.6: the places opened go with the tabs.
    expect(Object.keys(localStorage).filter((k) => k.startsWith('mm:recent'))).toEqual([])
    expect(queryClient.getQueryData(['connections'])).toBeUndefined()
    // Reviewer C Minor 11: nor the previous user's Overview dashboard, in memory (it stays theirs, on
    // the server).
    expect(dashboard.widgets).toEqual([])
    expect(dashboard.status).toBe('idle')
  })

  it('does not restore another user’s tabs', () => {
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    tabs.open({ kind: 'collection', title: 'secret', params: { coll: 'secret' } })
    setActivePinia(createPinia())
    const other = useTabsStore()
    other.bindUser('u2')
    expect(other.tabs.map((t) => t.kind)).toEqual(['welcome'])
    setActivePinia(createPinia())
    const same = useTabsStore()
    same.bindUser('u1')
    expect(same.tabs.map((t) => t.kind)).toEqual(['welcome'])
  })
})

describe('a shared browser (reviewer C I1)', () => {
  it('does not write the previous user’s open place into the next user’s recent places', async () => {
    localStorage.setItem(
      'mm:tabs',
      JSON.stringify({
        tabs: [
          {
            id: 'tab-secret',
            kind: 'collection',
            title: 'secret',
            params: { connectionId: 'c9', db: 'hr', coll: 'salaries' },
          },
        ],
        activeId: 'tab-secret',
        owner: 'u0',
      }),
    )
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
      'GET connections': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    expect(useTabsStore().tabs.map((t) => t.kind)).toEqual(['welcome'])
    expect(localStorage.getItem('mm:recent:u1') ?? '').not.toContain('salaries')
  })
})

describe('server unavailable at startup', () => {
  it('shows a retry screen instead of a blank page, and recovers', async () => {
    let up = false
    mockApi({
      'GET auth/status': () =>
        up
          ? [200, { mode: 'local', setupRequired: false, authenticated: true }]
          : [503, { code: 'INTERNAL', message: 'down' }],
      'GET auth/me': () => [200, { ...ME, mode: 'local' }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('unavailable')
    const { wrapper } = mountApp(UnavailableView, { plugins: [router] })
    up = true
    await wrapper.get('[data-test="retry"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('workspace'))
  })
})

describe('passkey availability', () => {
  const env = (hostname: string, secure = true, webauthn = true) =>
    ({
      isSecureContext: secure,
      location: { hostname },
      ...(webauthn ? { PublicKeyCredential: class {} } : {}),
    }) as unknown as Window

  it('needs WebAuthn, a secure context and a domain name (not an IP address)', () => {
    expect(passkeysAvailable(env('mongo.example.com'))).toBe(true)
    expect(passkeysAvailable(env('localhost'))).toBe(true)
    expect(passkeysAvailable(env('10.0.0.5'))).toBe(false)
    expect(passkeysAvailable(env('::1'))).toBe(false)
    expect(passkeysAvailable(env('[fe80::1]'))).toBe(false)
    expect(passkeysAvailable(env('mongo.example.com', false))).toBe(false)
    expect(passkeysAvailable(env('mongo.example.com', true, false))).toBe(false)
  })

  it('tells the user when the passkey prompt was cancelled', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    startAuthentication.mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }),
    )
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: false }],
      'POST auth/login': () => [200, { mfaRequired: true, ticket: 't1', methods: ['passkey', 'recovery'] }],
      'POST auth/login/passkey/options': () => [200, { challenge: 'c' }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/login')
    const { wrapper } = mountApp(LoginView, { plugins: [router] })
    await wrapper.get('input[autocomplete="username"]').setValue('ada')
    await wrapper.get('input[autocomplete="current-password"]').setValue('secret-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('[data-test="use-passkey"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('The passkey prompt was cancelled.')
  })

  it('detects an expired sign-in by its error reason, not its wording', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: false }],
      'POST auth/login': () => [200, { mfaRequired: true, ticket: 't1', methods: ['totp', 'recovery'] }],
      'POST auth/login/totp': () => [
        401,
        { code: 'UNAUTHENTICATED', message: 'Oturum doldu', details: { reason: 'mfa_ticket_expired' } },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/login')
    const { wrapper } = mountApp(LoginView, { plugins: [router] })
    await wrapper.get('input[autocomplete="username"]').setValue('ada')
    await wrapper.get('input[autocomplete="current-password"]').setValue('secret-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    await wrapper.get('input[autocomplete="one-time-code"]').setValue('123456')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(
      'The sign-in session expired. Enter your password again.',
    )
  })
})

describe('401 handling', () => {
  it('does not treat wrong sign-in credentials as an expired session', async () => {
    mockApi({
      'POST auth/login': () => [401, { code: 'UNAUTHENTICATED', message: 'x' }],
      'POST auth/login/totp': () => [401, { code: 'UNAUTHENTICATED', message: 'x' }],
      'POST auth/setup': () => [401, { code: 'UNAUTHENTICATED', message: 'x' }],
      'GET connections': () => [401, { code: 'UNAUTHENTICATED', message: 'x' }],
    })
    const handler = vi.fn()
    onUnauthenticated(handler)
    await api.post('auth/login', {}).catch(() => {})
    await api.post('auth/login/totp', {}).catch(() => {})
    await api.post('auth/setup', {}).catch(() => {})
    expect(handler).not.toHaveBeenCalled()
    await api.get('connections').catch(() => {})
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('focus management', () => {
  it('returns focus to the opener after a confirm dialog closes', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    mountApp(DialogHost)
    const answer = useDialogStore().confirm({ title: 'Delete?', message: 'm' })
    await nextTick()
    await nextTick()
    expect(document.activeElement).not.toBe(opener)
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await answer
    await nextTick()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps Tab inside the palette, closes on Escape from anywhere in it, and restores focus', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { wrapper } = mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(opener)
  })

  it('does not open the palette over a confirm dialog', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, { ...ME, mode: 'local' }],
      'GET connections': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    void useDialogStore().confirm({ title: 'x', message: 'y' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()
    expect(document.querySelector('[role="combobox"]')).toBeNull()
  })
})

describe('command palette language', () => {
  it('shows command titles in the current language after a switch', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, { ...ME, mode: 'local' }],
      'GET connections': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    usePreferencesStore().setLocale('tr')
    const titles = useCommandsStore().search('').map(commandTitle)
    expect(titles).toContain('Temayı değiştir')
  })
})
