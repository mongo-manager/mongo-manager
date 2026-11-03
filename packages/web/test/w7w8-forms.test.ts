import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, SECRET_MASK, type ConnectionSettings } from '@mongo-manager/shared'
import { formFromDto, settingsFromForm } from '../src/connections/formModel'
import type { ConnectionDto } from '../src/api/connections'
import ConnectionDialog from '../src/connections/ConnectionDialog.vue'
import OidcSignInHost from '../src/connections/OidcSignInHost.vue'
import { useOidcSignInStore } from '../src/stores/oidcSignIn'
import { useToastStore } from '../src/stores/toasts'
import { useDialogStore } from '../src/stores/dialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check } from './support/dom'
import { createAppRouter } from '../src/router'
import { createMemoryHistory } from 'vue-router'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const KEY = 'A'.repeat(128)
const ENCRYPTED: ConnectionSettings = {
  scheme: 'mongodb',
  hosts: [{ host: 'db1', port: 27017 }],
  auth: { mechanism: 'none' },
  tls: { enabled: false, allowInvalidHostnames: false, allowInvalidCertificates: false },
  options: {},
  encryption: {
    enabled: true,
    mode: 'auto',
    keyVaultNamespace: 'encryption.__keyVault',
    kms: {
      local: { key: KEY },
      aws: { accessKeyId: 'AKIA', secretAccessKey: 'aws-secret' },
      kmip: { endpoint: 'kmip.example:5696', caPem: 'CA' },
    },
    library: 'cryptShared',
    cryptSharedLibPath: '/opt/mongo_crypt_v1.so',
    encryptedFieldsMap: '{"a.b": {"fields": []}}',
  },
}
const dto = (settings: ConnectionSettings): ConnectionDto => ({
  id: 'c1',
  name: 'Prod',
  aiPolicy: 'any',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings,
  uri: 'mongodb://db1',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
})

describe('W8: the encryption section of the connection form', () => {
  it('round-trips the encryption settings through the form', () => {
    expect((settingsFromForm(formFromDto(dto(ENCRYPTED))) as ConnectionSettings).encryption).toEqual(
      ENCRYPTED.encryption,
    )
  })

  it('sends nothing of a section that is off', () => {
    const form = formFromDto(dto(ENCRYPTED))
    form.encryption.enabled = false
    expect(settingsFromForm(form)).not.toHaveProperty('encryption')
  })

  it('keeps masked KMS secrets when editing, and clears them when duplicating', () => {
    const masked = structuredClone(ENCRYPTED)
    masked.encryption!.kms.local!.key = SECRET_MASK
    masked.encryption!.kms.aws!.secretAccessKey = SECRET_MASK
    const edited = settingsFromForm(formFromDto(dto(masked))) as ConnectionSettings
    expect(edited.encryption!.kms.aws!.secretAccessKey).toBe(SECRET_MASK)
    const copy = formFromDto(dto(masked), { duplicateName: (n) => `${n} (copy)` })
    expect(copy.encryption.local.key).toBe('')
    expect(copy.encryption.aws.secretAccessKey).toBe('')
    // What is not secret stays.
    expect(copy.encryption.aws.accessKeyId).toBe('AKIA')
  })

  it('says the feature is not in this package, and offers it only where the package is', async () => {
    mockApi({
      'GET connections/capabilities': () => [
        200,
        {
          mode: 'local',
          distribution: 'docker',
          kerberos: { available: false, status: 'not_in_package', allowed: true },
          encryption: {
            available: false,
            status: 'not_in_package',
            serverCryptShared: false,
            ownCryptSharedPath: true,
          },
          oidc: { workloadIdentity: true, redirectUri: 'http://localhost:4321/oidc/callback' },
        },
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    ;(document.querySelector('[data-advanced-toggle]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'Encryption')!
      .click()
    await flushPromises()
    expect(document.querySelector('[data-test="encryption-unavailable"]')!.textContent).toContain(
      'not available in this package',
    )
    expect(
      byLabel<HTMLInputElement>('Use client-side encryption (CSFLE / Queryable Encryption)').disabled,
    ).toBe(true)
  })

  it('makes a 96-byte local key in the browser', async () => {
    mockApi({
      'GET connections/capabilities': () => [
        200,
        {
          mode: 'local',
          distribution: 'npm',
          kerberos: { available: true, status: 'available', allowed: true },
          encryption: {
            available: true,
            status: 'available',
            serverCryptShared: false,
            ownCryptSharedPath: true,
          },
          oidc: { workloadIdentity: true, redirectUri: 'http://localhost:4321/oidc/callback' },
        },
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    ;(document.querySelector('[data-advanced-toggle]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'Encryption')!
      .click()
    await flushPromises()
    await check(byLabel('Use client-side encryption (CSFLE / Queryable Encryption)'))
    await check(byLabel('Local key'))
    button('Generate a new key').click()
    await flushPromises()
    const key = byLabel<HTMLInputElement>('Local master key (96 bytes, base64)')
    expect(key.type).toBe('password')
    expect(atob(key.value)).toHaveLength(96)
    // Security review I7: the new key is shown once, to copy or download, before saving.
    expect(document.querySelector('[data-test="fresh-local-key"]')!.textContent).toContain(key.value)
    // Re-review item 4: the download's address lives long enough for the browser to start it.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    const created = vi.fn(() => 'blob:key')
    const revoked = vi.fn()
    URL.createObjectURL = created
    URL.revokeObjectURL = revoked
    // jsdom does not download: the link's click is only counted.
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      ;(document.querySelector('[data-test="download-local-key"]') as HTMLButtonElement).click()
      expect(created).toHaveBeenCalled()
      expect(revoked).not.toHaveBeenCalled()
      vi.advanceTimersByTime(30_000)
      expect(revoked).toHaveBeenCalledWith('blob:key')
    } finally {
      vi.useRealTimers()
      clicks.mockRestore()
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    }
  })

  // Security review I7, abuse case: one click replaced the saved master key without a word — data
  // keys wrapped with it could no longer be opened.
  it('asks for the word typed before replacing a saved local key', async () => {
    mockApi({
      'GET connections/capabilities': () => [
        200,
        {
          mode: 'local',
          distribution: 'npm',
          kerberos: { available: true, status: 'available', allowed: true },
          encryption: {
            available: true,
            status: 'available',
            serverCryptShared: false,
            ownCryptSharedPath: true,
          },
          oidc: { workloadIdentity: true, redirectUri: 'http://localhost:4321/oidc/callback' },
        },
      ],
    })
    const masked = structuredClone(ENCRYPTED)
    masked.encryption!.kms.local!.key = SECRET_MASK
    mountApp(ConnectionDialog, { props: { connection: dto(masked) } })
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'Encryption')!
      .click()
    await flushPromises()
    const dialogs = useDialogStore()
    ;(document.querySelector('[data-test="generate-local-key"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(dialogs.current?.requireText).toBe('replace')
    dialogs.settle(false)
    await flushPromises()
    const key = byLabel<HTMLInputElement>('Local master key (96 bytes, base64)')
    expect(key.value).toBe(SECRET_MASK)
    ;(document.querySelector('[data-test="generate-local-key"]') as HTMLButtonElement).click()
    await flushPromises()
    dialogs.settle(true)
    await flushPromises()
    expect(atob(key.value)).toHaveLength(96)
  })
})

// Security review I3: a pasted connection string fills the token resource; it is sent as confirmed
// only for the value ticked, and editing the value takes the tick away.
describe('W7: a workload identity’s token resource', () => {
  const WORKLOAD: ConnectionSettings = {
    ...ENCRYPTED,
    encryption: undefined,
    tls: { enabled: true, allowInvalidHostnames: false, allowInvalidCertificates: false },
    auth: { mechanism: 'MONGODB-OIDC', oidc: { environment: 'azure', tokenResource: 'api://prod' } },
  }

  it('is sent unconfirmed until ticked, and confirmed for that very value only', () => {
    const form = formFromDto(dto(WORKLOAD))
    expect((settingsFromForm(form) as ConnectionSettings).auth.oidc).toEqual({
      environment: 'azure',
      tokenResource: 'api://prod',
    })
    form.auth.oidc.tokenResourceConfirmed = 'api://prod'
    expect((settingsFromForm(form) as ConnectionSettings).auth.oidc?.tokenResourceConfirmed).toBe(
      'api://prod',
    )
    form.auth.oidc.tokenResource = 'api://other'
    expect((settingsFromForm(form) as ConnectionSettings).auth.oidc?.tokenResourceConfirmed).toBeUndefined()
  })

  // Re-review item 3: the workload identity itself is confirmed the same way, for its environment.
  it('sends the workload identity confirmed for its environment only', () => {
    const form = formFromDto(dto(WORKLOAD))
    expect((settingsFromForm(form) as ConnectionSettings).auth.oidc?.environmentConfirmed).toBeUndefined()
    form.auth.oidc.environmentConfirmed = 'azure'
    expect((settingsFromForm(form) as ConnectionSettings).auth.oidc?.environmentConfirmed).toBe('azure')
    form.auth.oidc.environment = 'gcp'
    expect((settingsFromForm(form) as ConnectionSettings).auth.oidc?.environmentConfirmed).toBeUndefined()
  })

  it('asks for the tick in the form, naming the resource and the hosts', async () => {
    mockApi({
      'GET connections/capabilities': () => [
        200,
        {
          mode: 'local',
          distribution: 'npm',
          kerberos: { available: false, status: 'missing', allowed: true },
          encryption: {
            available: true,
            status: 'available',
            serverCryptShared: false,
            ownCryptSharedPath: true,
          },
          oidc: { workloadIdentity: true, redirectUri: 'http://localhost:4321/oidc/callback' },
        },
      ],
    })
    mountApp(ConnectionDialog, { props: { connection: dto(WORKLOAD) } })
    await flushPromises()
    const toggle = document.querySelector('[data-advanced-toggle]') as HTMLButtonElement | null
    if (toggle?.getAttribute('aria-expanded') === 'false') {
      toggle.click()
      await flushPromises()
    }
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'Authentication')
      ?.click()
    await flushPromises()
    const box = document.querySelector('[data-test="oidc-token-resource-confirm"]')
    expect(box).not.toBeNull()
    expect(box!.textContent).toContain('api://prod')
    expect(box!.textContent).toContain('db1')
  })
})

// Security review Minor 10: a reverse lookup lets whoever answers reverse DNS choose the ticket's host.
describe('W8: Kerberos host name canonicalization', () => {
  it('warns when the host name is canonicalized through reverse DNS', async () => {
    mockApi({
      'GET connections/capabilities': () => [
        200,
        {
          mode: 'local',
          distribution: 'npm',
          kerberos: { available: true, status: 'available', allowed: true },
          encryption: {
            available: true,
            status: 'available',
            serverCryptShared: false,
            ownCryptSharedPath: true,
          },
          oidc: { workloadIdentity: true, redirectUri: 'x' },
        },
      ],
    })
    const settings: ConnectionSettings = {
      ...ENCRYPTED,
      encryption: undefined,
      auth: {
        mechanism: 'GSSAPI',
        username: 'u@REALM',
        kerberos: { canonicalizeHostName: 'forwardAndReverse' },
      },
    }
    mountApp(ConnectionDialog, { props: { connection: dto(settings) } })
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.trim() === 'Authentication')
      ?.click()
    await flushPromises()
    expect(document.querySelector('[data-test="kerberos-reverse-dns"]')).not.toBeNull()
  })
})

describe('W7: the OIDC sign-in dialog', () => {
  it('opens when a connection asks for it, and signs in with a code where the redirect cannot', async () => {
    const { calls } = mockApi({
      'GET connections/capabilities': () => [
        200,
        { mode: 'team', oidc: { workloadIdentity: false, redirectUri: 'x', deviceFlow: true } },
      ],
      'POST connections/c1/oidc/start': () => [
        200,
        {
          flow: 'device',
          device: {
            userCode: 'WDJB-MJHT',
            verificationUri: 'https://idp.example/activate',
            expiresAt: Date.now() + 600_000,
            state: 'pending',
          },
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(OidcSignInHost, { plugins: [router] })
    useOidcSignInStore().request('c1')
    await flushPromises()
    expect(document.querySelector('[data-test="oidc-sign-in"]')).toBeTruthy()
    button('Use a code instead').click()
    await flushPromises()
    expect(document.querySelector('[data-test="oidc-user-code"]')!.textContent).toContain('WDJB-MJHT')
    expect(calls.find((c) => c.path === 'connections/c1/oidc/start')!.body).toEqual({ flow: 'device' })
    // No token, no device code ever reaches the page.
    expect(document.body.innerHTML).not.toMatch(/device_code|access_token|refresh_token/)
  })

  // 2026-10-17: the host is on every page, the gate page of local mode too. Asking the server before
  // anyone is signed in was answered 401, and that sent the page to sign-in, losing why it was
  // shown (a used launch link). It asks only once a sign-in is wanted.
  it('asks the server nothing until a sign-in is wanted', async () => {
    const { calls } = mockApi({
      'GET connections/capabilities': () => [401, { code: 'UNAUTHENTICATED', message: 'Sign in' }],
    })
    const router = createAppRouter(createMemoryHistory())
    mountApp(OidcSignInHost, { plugins: [router] })
    await flushPromises()
    expect(calls.filter((c) => c.path === 'connections/capabilities')).toHaveLength(0)
  })

  // Review of the launch fix (minor 2): asked only once the dialog opens, the server's answer comes
  // a moment later; sign-in with a code is offered once it says so, not while it is not known.
  it('offers sign-in with a code only once the server says it may', async () => {
    let answer!: () => void
    mockApi({
      'GET connections/capabilities': async () => {
        await new Promise<void>((resolve) => (answer = resolve))
        return [200, { mode: 'team', oidc: { workloadIdentity: false, redirectUri: 'x', deviceFlow: true } }]
      },
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(OidcSignInHost, { plugins: [router] })
    useOidcSignInStore().request('c1')
    await flushPromises()
    const offered = () =>
      [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Use a code'))
    expect(offered()).toBe(false)
    answer()
    await flushPromises()
    expect(offered()).toBe(true)
  })

  // Security review I5: the person sees the provider and their token's hosts before leaving.
  it('shows where the sign-in goes and where the token goes, and leaves only when told', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    mockApi({
      'GET connections/capabilities': () => [
        200,
        { mode: 'team', oidc: { workloadIdentity: false, redirectUri: 'x', deviceFlow: false } },
      ],
      'POST connections/c1/oidc/start': () => [
        200,
        {
          flow: 'code',
          authorizeUrl: 'https://login.corp.example/authorize?x=1',
          issuer: 'https://login.corp.example',
          tokenHosts: ['cluster0.ab12.mongodb.net'],
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(OidcSignInHost, { plugins: [router] })
    useOidcSignInStore().request('c1')
    await flushPromises()
    // Sign-in with a code is off on this server (I6): not offered.
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Use a code'))).toBe(
      false,
    )
    button('Sign in').click()
    await flushPromises()
    const where = document.querySelector('[data-test="oidc-where"]')!.textContent!
    expect(where).toContain('login.corp.example')
    expect(where).toContain('cluster0.ab12.mongodb.net')
    expect(assign).not.toHaveBeenCalled()
    ;(document.querySelector('[data-test="oidc-proceed"]') as HTMLButtonElement).click()
    expect(assign).toHaveBeenCalledWith('https://login.corp.example/authorize?x=1')
  })

  it('says what went wrong when the identity provider sent the browser back with an error', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'local', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'local',
          user: { id: 'local', username: 'owner', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/?oidc_error=oidc_state')
    expect(router.currentRoute.value.query).toMatchObject({ oidc_error: 'oidc_state' })
    mountApp(OidcSignInHost, { plugins: [router] })
    await flushPromises()
    expect(useToastStore().toasts.map((t) => t.message)).toContain(
      'That sign-in was unknown, expired or started in another browser. Start it again here.',
    )
    expect(router.currentRoute.value.query).not.toHaveProperty('oidc_error')
  })
})
