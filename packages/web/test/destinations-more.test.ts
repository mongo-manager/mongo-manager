import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { DestinationInputSchema } from '@mongo-manager/shared/browser'
import DestinationEditor from '../src/destinations/DestinationEditor.vue'
import DestinationsView from '../src/destinations/DestinationsView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import TypePicker from '../src/destinations/TypePicker.vue'
import DsSecretField from '../src/ds/DsSecretField.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { addressHints } from '../src/destinations/hints'
import { S3_PRESET_INFO, WEBDAV_PRESET_INFO } from '../src/destinations/presets'
import { destinationsApi } from '../src/api/destinations'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'
import { DEST } from './support/destinations'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const t = (key: string) => i18n.global.t(key)
const text = () => document.body.textContent ?? ''
async function next(): Promise<void> {
  button('Next').click()
  await flushPromises()
}
async function save(): Promise<void> {
  button('Save').click()
  await flushPromises()
}
const radio = (name: string, value: string) =>
  document.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`)!
const stepButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('ol button')].find((b) => b.textContent?.includes(label))
const stepLabels = () =>
  [...document.querySelectorAll<HTMLButtonElement>('ol button')].map((b) =>
    (b.textContent ?? '').replace(/^\d+/, '').trim(),
  )
const teamMode = () => {
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never
}
const USERS = [
  { id: 'u1', username: 'alice', role: 'editor', disabled: false },
  { id: 'u2', username: 'bob', role: 'viewer', disabled: false },
  { id: 'u3', username: 'root', role: 'admin', disabled: false },
  { id: 'u4', username: 'eve', role: 'editor', disabled: true },
]
const grantRow = (name: string) =>
  [...document.querySelectorAll('li')].find((li) => li.querySelector(`[role="group"][aria-label="${name}"]`))
const levelButton = (name: string, label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${name}"] button`)].find(
    (b) => b.textContent?.trim() === label,
  )!
const userOptions = () =>
  [...document.querySelectorAll<HTMLOptionElement>('section select option')].map((o) => o.textContent?.trim())
const SA_KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'mm-backup@acme-prod.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----\n',
})
// Phase 3d-3b final review C6: the key is pasted into a masked field that empties itself at once.
const keyArea = () =>
  document.querySelector<HTMLInputElement>('input[type="password"][aria-label="Service account key (JSON)"]')
const keyFileInput = () =>
  document.querySelector<HTMLInputElement>('input[type="file"][aria-label="Service account key file"]')!

describe('access step (phase 3d-3b D4)', () => {
  it('offers only active non-administrators, grants Send first, raises to Browse and saves the new list', async () => {
    teamMode()
    const { calls } = mockApi({
      'GET users': () => [200, USERS],
      'PATCH backup-destinations/d1': () => [200, DEST()],
      'PUT backup-destinations/d1/grants': (body) => [
        200,
        (body as { grants: Array<{ userId: string; level: string }> }).grants.map((g) => ({
          ...g,
          username: USERS.find((u) => u.id === g.userId)!.username,
        })),
      ],
    })
    const saved = vi.fn()
    mountApp(DestinationEditor, { props: { existing: DEST(), onSaved: saved } })
    await flushPromises()
    await next()
    // alice already has access, root is an administrator, eve is disabled: only bob is offered.
    expect(userOptions()).toEqual(['Choose a user', 'bob'])
    expect(levelButton('alice', 'Send').getAttribute('aria-pressed')).toBe('true')
    await choose(document.querySelector<HTMLSelectElement>('section select')!, 'u2')
    // Final review C10: choosing changes nothing until Add.
    expect(grantRow('bob')).toBeUndefined()
    button('Add').click()
    await flushPromises()
    expect(grantRow('bob')).toBeDefined()
    expect(levelButton('bob', 'Send').getAttribute('aria-pressed')).toBe('true')
    expect(levelButton('bob', 'Browse everything').getAttribute('aria-pressed')).toBe('false')
    expect(userOptions()).toEqual(['Everyone already has access'])
    levelButton('bob', 'Browse everything').click()
    await flushPromises()
    expect(levelButton('bob', 'Browse everything').getAttribute('aria-pressed')).toBe('true')
    expect(levelButton('bob', 'Send').getAttribute('aria-pressed')).toBe('false')
    // alice keeps Send.
    expect(levelButton('alice', 'Send').getAttribute('aria-pressed')).toBe('true')
    await save()
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.path).toBe('backup-destinations/d1/grants')
    expect(put.body).toEqual({
      grants: [
        { userId: 'u1', level: 'send' },
        { userId: 'u2', level: 'browse' },
      ],
    })
    // Usernames are display only: they never reach the server.
    expect(JSON.stringify(put.body)).not.toContain('alice')
    expect(saved.mock.calls[0]![0].grants).toHaveLength(2)
  })

  it('removes a grant, offers the user again, and saves an empty list', async () => {
    teamMode()
    const { calls } = mockApi({
      'GET users': () => [200, USERS],
      'PATCH backup-destinations/d1': () => [200, DEST()],
      'PUT backup-destinations/d1/grants': () => [200, []],
    })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    await next()
    expect(text()).not.toContain('No one else yet')
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove alice"]')!.click()
    await flushPromises()
    expect(grantRow('alice')).toBeUndefined()
    expect(text()).toContain('No one else yet: only administrators can use this destination.')
    expect(userOptions()).toEqual(['Choose a user', 'alice', 'bob'])
    await save()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ grants: [] })
  })

  it('sends no grants request when access did not change', async () => {
    teamMode()
    const { calls } = mockApi({
      'GET users': () => [200, USERS],
      'PATCH backup-destinations/d1': () => [200, DEST()],
    })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    await next()
    await save()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true)
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('says single-user mode has no one to grant, without asking for users', async () => {
    const { calls } = mockApi({})
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), '/srv/backups/mm')
    await next()
    expect(text()).toContain('Single-user mode has no other accounts.')
    expect(text()).toContain('Can send their own backups and restore the ones they sent.')
    expect(document.querySelector('section select')).toBeNull()
    expect(calls.some((c) => c.path === 'users')).toBe(false)
  })
})

describe('type picker (phase 3d-3b D2)', () => {
  it('offers the four types, and a folder skips the provider step', async () => {
    mockApi({})
    mountApp(DestinationEditor)
    await flushPromises()
    for (const type of ['folder', 's3', 'gdrive', 'webdav']) {
      expect(radio('type', type)).not.toBeNull()
      expect(radio('type', type).disabled).toBe(false)
    }
    expect(radio('type', 's3').checked).toBe(true)
    expect(text()).toContain('A directory on this server, inside the folders MM_BACKUP_FOLDER_ROOTS allows.')
    expect(stepLabels()).toEqual(['Type', 'Provider', 'Connection', 'Access', 'Test and save'])
    radio('type', 'folder').click()
    await flushPromises()
    expect(stepLabels()).toEqual(['Type', 'Connection', 'Access', 'Test and save'])
    await next()
    expect(byLabel('Folder on the server')).toBeDefined()
  })

  it('goes to the WebDAV providers after choosing WebDAV', async () => {
    mockApi({})
    mountApp(DestinationEditor)
    await flushPromises()
    radio('type', 'webdav').click()
    await flushPromises()
    await next()
    expect(radio('webdav-preset', 'nextcloud')).not.toBeNull()
    expect(radio('webdav-preset', 'generic')).not.toBeNull()
  })

  it('never lets a saved destination change its type', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    stepButton('Type')!.click()
    await flushPromises()
    expect(radio('type', 's3').disabled).toBe(false)
    expect(radio('type', 's3').checked).toBe(true)
    for (const type of ['folder', 'gdrive', 'webdav']) expect(radio('type', type).disabled).toBe(true)
  })

  it('disables only the other types when mounted on its own', () => {
    const update = vi.fn()
    mountApp(TypePicker, { props: { modelValue: 'webdav', disabled: true, 'onUpdate:modelValue': update } })
    expect(document.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Type')
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[name="type"]')]
        .filter((i) => !i.disabled)
        .map((i) => i.value),
    ).toEqual(['webdav'])
    radio('type', 'folder').click()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('WebDAV fields (phase 3d-3b D2)', () => {
  it('explains Nextcloud app passwords and builds a generic WebDAV destination the server accepts', async () => {
    const { calls } = mockApi({ 'POST backup-destinations': () => [201, DEST({ type: 'webdav' })] })
    mountApp(DestinationEditor, { props: { startType: 'webdav' } })
    await flushPromises()
    // Nextcloud is the default, with its app-password advice.
    expect(radio('webdav-preset', 'nextcloud').checked).toBe(true)
    expect(text()).toContain('Use an app password (Settings → Security → Devices & sessions)')
    expect(text()).toContain('Nextcloud, ownCloud or any WebDAV server.')
    await next()
    expect(byLabel('Server address').placeholder).toBe('https://cloud.example.com')
    expect(byLabel('Folder').value).toBe('Backups')
    button('Back').click()
    await flushPromises()
    radio('webdav-preset', 'generic').click()
    await flushPromises()
    await next()
    expect(byLabel('Server address').placeholder).toBe('https://dav.example.com/backups')
    await typeInto(byLabel('Name'), 'NAS')
    await typeInto(byLabel('Server address'), 'http://192.168.1.20/dav')
    expect(text()).toContain('This looks like a private address')
    expect(text()).toContain('Traffic to this address is not encrypted.')
    await typeInto(byLabel('Server address'), 'https://dav.example.com/backups')
    expect(text()).not.toContain('This looks like a private address')
    expect(text()).not.toContain('Traffic to this address is not encrypted.')
    await typeInto(byLabel('User name'), 'ops')
    await typeInto(byLabel('Folder'), 'mongo/prod')
    const password = byLabel('Password')
    expect(password.type).toBe('password')
    await typeInto(password, 'dav-app-password-1')
    // The secret is never written into the page as text.
    expect(text()).not.toContain('dav-app-password-1')
    const readBack = [...document.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('Verify each upload'))!
      .querySelector('input')!
    readBack.click()
    const ca = byLabel<HTMLTextAreaElement>('CA certificate (PEM, optional)')
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
    await typeInto(ca, `  ${pem}  `)
    await save()
    const create = calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!
    expect(create.body).toEqual({
      type: 'webdav',
      name: 'NAS',
      config: {
        preset: 'generic',
        url: 'https://dav.example.com/backups',
        folder: 'mongo/prod',
        username: 'ops',
        verifyReadBack: true,
        caPem: pem,
      },
      secrets: { password: 'dav-app-password-1' },
      policy: { encryptedOnly: true },
    })
    expect(DestinationInputSchema.safeParse(create.body).success).toBe(true)
  })

  it('drops a CA certificate that was cleared', async () => {
    const { calls } = mockApi({ 'POST backup-destinations': () => [201, DEST({ type: 'webdav' })] })
    mountApp(DestinationEditor, { props: { startType: 'webdav' } })
    await flushPromises()
    await next()
    await typeInto(byLabel('Name'), 'Cloud')
    await typeInto(byLabel('Server address'), 'https://cloud.example.com')
    await typeInto(byLabel('User name'), 'ops')
    await typeInto(byLabel('Password'), 'app-password')
    const ca = byLabel<HTMLTextAreaElement>('CA certificate (PEM, optional)')
    await typeInto(ca, '-----BEGIN CERTIFICATE-----x')
    await typeInto(ca, '   ')
    await save()
    const body = calls.find((c) => c.method === 'POST')!.body as { config: Record<string, unknown> }
    expect(body.config).not.toHaveProperty('caPem')
    expect(body.config.preset).toBe('nextcloud')
  })
})

describe('Google Drive connection (phase 3d-3b D3)', () => {
  async function serviceAccountStep(): Promise<void> {
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    expect(radio('drive-auth', 'oauth').checked).toBe(true)
    radio('drive-auth', 'serviceAccount').click()
    await flushPromises()
    await next()
  }

  it('refuses what is not a service account key, names the account of a real one, and never echoes it', async () => {
    mockApi({})
    await serviceAccountStep()
    expect(byLabel('Shared Drive id')).toBeDefined()
    expect(document.body.textContent).not.toContain('OAuth client id')
    expect(button('Save').disabled).toBe(true)
    await typeInto(keyArea()!, 'not json at all')
    expect(text()).toContain('This is not a Google service account key')
    await typeInto(keyArea()!, JSON.stringify({ type: 'authorized_user', client_email: 'me@example.com' }))
    expect(text()).toContain('This is not a Google service account key')
    await typeInto(keyArea()!, JSON.stringify({ type: 'service_account' }))
    expect(text()).toContain('This is not a Google service account key')
    await typeInto(keyArea()!, SA_KEY)
    expect(text()).not.toContain('This is not a Google service account key')
    expect(text()).toContain('Key for mm-backup@acme-prod.iam.gserviceaccount.com')
    expect(text()).not.toContain('PRIVATE KEY')
  })

  it('reads a dropped or chosen key file, and refuses one too large to be a key', async () => {
    mockApi({})
    await serviceAccountStep()
    const drop = (file: File) => {
      const e = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'dataTransfer', { value: { files: [file] } })
      keyArea()!.dispatchEvent(e)
      return e
    }
    const big = new File(['x'.repeat(20_000)], 'big.json', { type: 'application/json' })
    expect(drop(big).defaultPrevented).toBe(true)
    await flushPromises()
    expect(keyArea()!.value).toBe('')
    // Final review C19: said, not silently ignored.
    expect(text()).toContain('This file is too large to be a service account key')
    drop(new File([SA_KEY], 'key.json', { type: 'application/json' }))
    await flushPromises()
    // Final review C6: the key itself never stays on screen.
    expect(keyArea()).toBeNull()
    expect(text()).toContain('Key for mm-backup@acme-prod.iam.gserviceaccount.com')

    button('Replace').click()
    await flushPromises()
    const other = JSON.stringify({
      type: 'service_account',
      client_email: 'other@acme.iam.gserviceaccount.com',
    })
    Object.defineProperty(keyFileInput(), 'files', {
      value: [new File([other], 'other.json', { type: 'application/json' })],
      configurable: true,
    })
    keyFileInput().dispatchEvent(new Event('change'))
    await flushPromises()
    expect(text()).toContain('Key for other@acme.iam.gserviceaccount.com')
  })

  it('saves a service-account destination in a form the server accepts', async () => {
    const { calls } = mockApi({ 'POST backup-destinations': () => [201, DEST({ type: 'gdrive' })] })
    await serviceAccountStep()
    await typeInto(byLabel('Name'), 'Workspace Drive')
    await typeInto(byLabel('Shared Drive id'), '0AbCdEfGhIjKlMn')
    await typeInto(keyArea()!, SA_KEY)
    await save()
    const create = calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!
    expect(create.body).toMatchObject({
      type: 'gdrive',
      name: 'Workspace Drive',
      config: {
        auth: 'serviceAccount',
        sharedDriveId: '0AbCdEfGhIjKlMn',
        folderName: 'Mongo Manager backups',
      },
      secrets: { serviceAccountKey: SA_KEY },
    })
    // An empty OAuth secret is not sent along.
    expect((create.body as { secrets: object }).secrets).not.toHaveProperty('clientSecret')
    // What the editor sends must pass the server's own schema.
    const parsed = DestinationInputSchema.safeParse(create.body)
    expect(parsed.error?.issues ?? []).toEqual([])
  })

  it('keeps a stored key until it is replaced, and then needs a new one', async () => {
    mockApi({})
    const existing = DEST({
      type: 'gdrive',
      config: { auth: 'serviceAccount', folderName: 'MM', sharedDriveId: '0AbCdEfGhIjKlMn' },
      secrets: { clientSecret: false, serviceAccountKey: true },
      keyHint: null,
      status: { state: 'ok', checkedAt: 1, account: 'mm@acme.iam.gserviceaccount.com' },
    })
    mountApp(DestinationEditor, { props: { existing } })
    await flushPromises()
    expect(text()).toContain('Stored')
    expect(keyArea()).toBeNull()
    expect(button('Save').disabled).toBe(false)
    button('Replace').click()
    await flushPromises()
    expect(keyArea()!.value).toBe('')
    expect(button('Save').disabled).toBe(true)
  })

  // Review 2026-10-13 (web): the address to sign in at comes from Google through the server; the page
  // links to an https address only, never a script.
  it('links to the sign-in address only when it is https', async () => {
    const url = 'javascript:alert(1)'
    mockApi({
      'POST backup-destinations/google/device': () => [
        200,
        {
          flowId: 'f1',
          userCode: 'CODE-1',
          verificationUrl: url,
          expiresAt: Date.now() + 900_000,
          interval: 5,
        },
      ],
      'GET backup-destinations/google/device/f1': () => [200, { state: 'pending' }],
    })
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    await next()
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    button('Connect Google account').click()
    await flushPromises()
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
    expect(document.querySelector('code')!.textContent).toBe('CODE-1')
  })

  it('shows the code with a countdown, copies it, and offers another try after a denial or an expiry', async () => {
    const polls: Array<[number, unknown]> = [
      [200, { state: 'pending' }],
      [200, { state: 'denied' }],
      [200, { state: 'expired' }],
    ]
    let starts = 0
    const { calls } = mockApi({
      'POST backup-destinations/google/device': () => {
        starts++
        return [
          200,
          {
            flowId: `f${starts}`,
            userCode: `CODE-000${starts}`,
            verificationUrl: 'https://www.google.com/device',
            expiresAt: Date.now() + 900_000,
            interval: 5,
          },
        ]
      },
      'GET backup-destinations/google/device/f1': () => polls.shift() as [number, unknown],
      'GET backup-destinations/google/device/f2': () => polls.shift() as [number, unknown],
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    mountApp(ToastHost)
    await flushPromises()
    await next()
    expect(button('Connect Google account').disabled).toBe(true)
    await typeInto(byLabel('OAuth client id'), 'short')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    // A client id Google would never issue does not arm Connect.
    expect(button('Connect Google account').disabled).toBe(true)
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    button('Connect Google account').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'backup-destinations/google/device')!.body).toEqual({
      clientId: 'client-id-0001.apps.googleusercontent.com',
      clientSecret: 'client-secret-1',
    })
    expect(text()).toContain('Go to https://www.google.com/device and enter this code')
    expect(document.querySelector('code')!.textContent).toBe('CODE-0001')
    const ring = () => document.querySelector('svg[role="img"]')!.getAttribute('aria-label')
    expect(ring()).toMatch(/^Expires in 1[45]:\d\d$/)
    document.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('CODE-0001')
    expect(text()).toContain('Code copied')
    // pending, then denied
    await vi.advanceTimersByTimeAsync(11_000)
    await flushPromises()
    expect(ring).toThrow()
    const alert = [...document.querySelectorAll('[role="alert"]')].find((a) =>
      a.textContent?.includes('The request was denied.'),
    )
    expect(alert).toBeDefined()
    expect(button('Save').disabled).toBe(true)
    button('Try again').click()
    await flushPromises()
    expect(starts).toBe(2)
    expect(document.querySelector('code')!.textContent).toBe('CODE-0002')
    await vi.advanceTimersByTimeAsync(6_000)
    await flushPromises()
    expect(text()).toContain('The code expired.')
    expect(button('Try again')).toBeDefined()
    expect(button('Save').disabled).toBe(true)
  })

  it('treats a lost sign-in as expired and says why', async () => {
    mockApi({
      'POST backup-destinations/google/device': () => [
        200,
        {
          flowId: 'gone',
          userCode: 'ABCD-EFGH',
          verificationUrl: 'https://www.google.com/device',
          expiresAt: Date.now() + 900_000,
          interval: 5,
        },
      ],
      'GET backup-destinations/google/device/gone': () => [
        404,
        { code: 'NOT_FOUND', message: 'This sign-in expired; start again' },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    await next()
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    button('Connect Google account').click()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(6_000)
    await flushPromises()
    expect(text()).toContain('The code expired.')
    expect(text()).toContain('It no longer exists.')
  })

  // The server answers a refused device start with the destination reason (asHttp in
  // server/src/routes/destinations.ts); the page should say it in words, as the Backups card does.
  it('says why Google could not be reached when the device sign-in cannot start', async () => {
    mockApi({
      'POST backup-destinations/google/device': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'connect ECONNREFUSED 142.250.0.1:443',
          details: { reason: 'connect' },
        },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    await next()
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    button('Connect Google account').click()
    await flushPromises()
    // Back to Connect, with the reason; the raw socket error stays on the server.
    expect(button('Connect Google account').disabled).toBe(false)
    expect(text()).not.toContain('ECONNREFUSED')
    expect(text()).toContain(t('destinations.reason.connect'))
  })

  it('shows a connected account, and reconnects with a new client secret when one is typed', async () => {
    const { calls } = mockApi({
      'POST backup-destinations/google/device': () => [
        200,
        {
          flowId: 'f9',
          userCode: 'WXYZ-1234',
          verificationUrl: 'https://www.google.com/device',
          expiresAt: Date.now() + 900_000,
          interval: 5,
        },
      ],
    })
    const existing = DEST({
      type: 'gdrive',
      config: { auth: 'oauth', folderName: 'MM', clientId: 'client-id-0001.apps.googleusercontent.com' },
      secrets: { clientSecret: true, serviceAccountKey: false, refreshToken: true },
      keyHint: null,
      status: { state: 'ok', checkedAt: 1, account: 'ops@example.com' },
    })
    mountApp(DestinationEditor, { props: { existing } })
    await flushPromises()
    expect(document.querySelector('[role="status"]')!.textContent).toContain('Connected as ops@example.com')
    expect(text()).not.toContain('Enter the client id and its secret to connect.')
    // Final review C4: the stored secret (applied by the server) can start a new sign-in.
    expect(button('Try again').disabled).toBe(false)
    expect(button('Save').disabled).toBe(false)
    button('Replace').click()
    await flushPromises()
    await typeInto(byLabel('OAuth client secret'), 'rotated-secret')
    expect(button('Try again').disabled).toBe(false)
    button('Try again').click()
    await flushPromises()
    expect(calls.find((c) => c.path === 'backup-destinations/google/device')!.body).toEqual({
      clientId: 'client-id-0001.apps.googleusercontent.com',
      clientSecret: 'rotated-secret',
    })
    expect(document.querySelector('code')!.textContent).toBe('WXYZ-1234')
  })
})

describe('saving refusals (phase 3d-3b UI review)', () => {
  // The server refuses a folder outside MM_BACKUP_FOLDER_ROOTS with { reason: 'path' } (checkFolder → asHttp).
  it('says why a folder was refused instead of a generic sentence', async () => {
    mockApi({
      'POST backup-destinations': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'outside the allowed roots', details: { reason: 'path' } },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), '/etc')
    await save()
    expect(text()).toContain(t('destinations.reason.path'))
  })

  // Short names review 5 (M-4): a folder inside the roots whose name Windows cannot use is not told
  // to choose a folder inside the roots.
  it('says the name is the trouble when Windows cannot use it', async () => {
    mockApi({
      'POST backup-destinations': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'This folder cannot be used: Windows cannot use "nul" as a folder name',
          details: { reason: 'path_name', name: '"nul"' },
        },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), 'D:\\backups\\nul')
    await save()
    // Short names review 6 (I-1): which name, and what a name may not have, in the editor itself.
    expect(text()).toContain(i18n.global.t('destinations.reasonNamed.path_name', { name: '"nul"' }))
    expect(text()).toContain('"nul" cannot be used as a folder name')
    expect(text()).toContain(t('destinations.fixHint.path_name'))
    expect(text()).not.toContain(t('destinations.reason.path'))
    expect(text()).not.toContain(t('destinations.fixHint.path'))
  })

  it('says a folder name refusal without the name in general words', async () => {
    mockApi({
      'POST backup-destinations': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'refused', details: { reason: 'path_name' } },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), 'D:\\backups\\nul')
    await save()
    expect(text()).toContain(t('destinations.reason.path_name'))
    expect(text()).toContain(t('destinations.fixHint.path_name'))
  })

  // Short names review 7 (I-1): a folder in the roots but in the data directory is not told to
  // choose a folder inside the roots; a network path gets its sentence and no hint beside it.
  it.each([
    ['data', 'D:\\mm-data\\b', true],
    ['network', '\\\\server\\share', false],
  ])('says which folder refusal it is: %s', async (why, path, hinted) => {
    mockApi({
      'POST backup-destinations': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'refused', details: { reason: 'path', why } },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), path)
    await save()
    expect(text()).toContain(t(`destinations.pathWhy.${why}`))
    if (hinted) expect(text()).toContain(t(`destinations.pathWhyFix.${why}`))
    expect(text()).not.toContain(t('destinations.pathWhyFix.roots'))
    expect(text()).not.toContain(t('destinations.fixHint.path'))
  })

  // Short names review 8 (M-4): a refusal this page does not know (a newer server) gets the
  // reason's own words and its general hint, not nothing.
  it('words a folder refusal it does not know as a folder refusal', async () => {
    mockApi({
      'POST backup-destinations': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'refused',
          details: { reason: 'path', why: 'from_a_newer_server' },
        },
      ],
    })
    mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Disk')
    await typeInto(byLabel('Folder on the server'), 'D:\\backups')
    await save()
    expect(text()).toContain(t('destinations.reason.path'))
    expect(text()).toContain(t('destinations.fixHint.path'))
  })
})

describe('secret field (spec §4.4)', () => {
  it('hides a typed secret until asked, and offers to keep a stored one', async () => {
    const update = vi.fn()
    const { wrapper } = mountApp(DsSecretField, {
      props: { label: 'Password', stored: true, modelValue: 'typed-secret', 'onUpdate:modelValue': update },
    })
    const input = byLabel('Password')
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('new-password')
    expect(text()).not.toContain('typed-secret')
    document.querySelector<HTMLButtonElement>('button[aria-label="Show Password"]')!.click()
    await flushPromises()
    expect(byLabel('Password').type).toBe('text')
    document.querySelector<HTMLButtonElement>('button[aria-label="Hide Password"]')!.click()
    await flushPromises()
    expect(byLabel('Password').type).toBe('password')
    await typeInto(byLabel('Password'), 'other')
    expect(update).toHaveBeenLastCalledWith('other')
    button('Keep the stored one').click()
    expect(update).toHaveBeenLastCalledWith(null)
    await wrapper.setProps({ stored: false, autocomplete: 'current-password' })
    expect(byLabel('Password').autocomplete).toBe('current-password')
    expect(() => button('Keep the stored one')).toThrow()
  })
})

describe('address hints (phase 3d-3b D2)', () => {
  const hint = (address: string) => addressHints(address, t)
  const PRIVATE =
    'This looks like a private address: it works only if MM_BACKUP_PRIVATE_NETWORKS lists its network.'
  const HTTP = 'Traffic to this address is not encrypted.'

  it('warns about private networks and plain http, and says nothing about a public https address', () => {
    expect(hint('https://s3.eu-west-1.amazonaws.com')).toBeUndefined()
    expect(hint('not an address')).toBeUndefined()
    expect(hint('')).toBeUndefined()
    for (const a of [
      'https://10.0.0.5',
      'https://127.0.0.1:9000',
      'https://172.16.0.1',
      'https://172.31.255.255',
      'https://192.168.1.10',
      'https://localhost:9000',
      'https://nas.local',
      'https://[fd00::1]',
      'https://[fc12::1]',
    ])
      expect(hint(a), a).toBe(PRIVATE)
    for (const a of ['https://172.15.0.1', 'https://172.32.0.1', 'https://192.169.0.1', 'https://11.0.0.1'])
      expect(hint(a), a).toBeUndefined()
    expect(hint('http://dav.example.com')).toBe(HTTP)
    expect(hint('http://192.168.1.10/dav')).toBe(`${PRIVATE} ${HTTP}`)
  })
})

describe('provider presets (spec §2.3)', () => {
  it('derives each provider’s endpoint, and leaves self-hosted ones to the user', () => {
    expect(S3_PRESET_INFO.aws.endpoint('eu-west-1', '')).toBe('https://s3.eu-west-1.amazonaws.com')
    expect(S3_PRESET_INFO.wasabi.endpoint('eu-central-1', '')).toBe('https://s3.eu-central-1.wasabisys.com')
    expect(S3_PRESET_INFO.minio.endpoint('us-east-1', '')).toBe('')
    expect(S3_PRESET_INFO.custom.endpoint('us-east-1', '')).toBe('')
    expect(S3_PRESET_INFO.custom.pathStyle).toBe(true)
    expect(S3_PRESET_INFO.r2.account).toBe(true)
    expect(S3_PRESET_INFO.spacesCold.note).toBe(true)
    expect(S3_PRESET_INFO.spaces.regions).toContain('fra1')
    expect(WEBDAV_PRESET_INFO.nextcloud.note).toBe(true)
    expect(WEBDAV_PRESET_INFO.generic.note).toBe(false)
  })
})

describe('destinations API (phase 3d-3b)', () => {
  it('calls each route with its method, path and body, encoding every id', async () => {
    const urls: URL[] = []
    const ok =
      (status = 200, data: unknown = {}) =>
      (_b: unknown, url: URL): [number, unknown] => {
        urls.push(url)
        return [status, data]
      }
    const { calls, fetchMock } = mockApi({
      'GET backup-destinations': ok(200, []),
      'GET backup-destinations/all': ok(200, []),
      'POST backup-destinations': ok(201),
      'PATCH backup-destinations/a%2F..%2Fb': ok(),
      'DELETE backup-destinations/d1': ok(204, undefined),
      'POST backup-destinations/test': ok(200, { steps: [] }),
      'POST backup-destinations/d1/test': ok(200, { steps: [] }),
      'PUT backup-destinations/d1/grants': ok(200, []),
      'POST backup-destinations/google/device': ok(),
      'GET backup-destinations/google/device/f%3F1': ok(200, { state: 'pending' }),
      'GET backup-destinations/d1/backups': ok(200, { items: [], cursor: null }),
      'POST backup-destinations/d1/backups/fetch': ok(202),
      'DELETE backup-destinations/d1/backups/k1': ok(204, undefined),
      'POST backups/b1/send': ok(202),
      'POST backup-copies/k2/retry': ok(202),
      'DELETE backup-copies/k3': ok(204, undefined),
    })
    await destinationsApi.mine()
    await destinationsApi.all()
    await destinationsApi.create({ type: 'folder', name: 'Disk', config: { path: '/srv' } })
    await destinationsApi.update('a/../b', { name: 'x' })
    await destinationsApi.remove('d1')
    await destinationsApi.test({ type: 'folder' })
    await destinationsApi.testSaved('d1')
    await destinationsApi.grants('d1', [{ userId: 'u1', level: 'browse' }])
    await destinationsApi.startDevice({ clientId: 'client-id-0001', clientSecret: 's' })
    await destinationsApi.pollDevice('f?1')
    await destinationsApi.remote('d1')
    await destinationsApi.remote('d1', 'next&page=1')
    await destinationsApi.fetch('d1', { connectionId: 'c1', key: 'mongo-manager/x.mmbak' })
    await destinationsApi.removeRemote('d1', 'k1')
    await destinationsApi.removeRemote('d1', 'k1', { keepalive: true })
    await destinationsApi.send('b1', { destinationIds: ['d1'], deleteLocal: true })
    await destinationsApi.retryCopy('k2')
    await destinationsApi.discardCopy('k3')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET backup-destinations',
      'GET backup-destinations/all',
      'POST backup-destinations',
      'PATCH backup-destinations/a%2F..%2Fb',
      'DELETE backup-destinations/d1',
      'POST backup-destinations/test',
      'POST backup-destinations/d1/test',
      'PUT backup-destinations/d1/grants',
      'POST backup-destinations/google/device',
      'GET backup-destinations/google/device/f%3F1',
      'GET backup-destinations/d1/backups',
      'GET backup-destinations/d1/backups',
      'POST backup-destinations/d1/backups/fetch',
      'DELETE backup-destinations/d1/backups/k1',
      'DELETE backup-destinations/d1/backups/k1',
      'POST backups/b1/send',
      'POST backup-copies/k2/retry',
      'DELETE backup-copies/k3',
    ])
    expect(calls[2]!.body).toEqual({ type: 'folder', name: 'Disk', config: { path: '/srv' } })
    expect(calls[3]!.body).toEqual({ name: 'x' })
    expect(calls[6]!.body).toBeUndefined()
    expect(calls[7]!.body).toEqual({ grants: [{ userId: 'u1', level: 'browse' }] })
    expect(calls[8]!.body).toEqual({ clientId: 'client-id-0001', clientSecret: 's' })
    // The first page has no cursor; the next one carries it, encoded, as a single parameter.
    const lists = urls.filter((u) => u.pathname.endsWith('/d1/backups'))
    expect(lists[0]!.search).toBe('')
    expect([...lists[1]!.searchParams.entries()]).toEqual([['cursor', 'next&page=1']])
    expect(calls[12]!.body).toEqual({ connectionId: 'c1', key: 'mongo-manager/x.mmbak' })
    // Only a delete sent while the page is closing outlives it.
    const inits = fetchMock.mock.calls.map((c) => c[1] as RequestInit)
    expect(inits[13]!.keepalive).toBeFalsy()
    expect(inits[14]!.keepalive).toBe(true)
    expect(calls[15]!.body).toEqual({ destinationIds: ['d1'], deleteLocal: true })
  })
})

describe('S3 fields (phase 3d-3b D2, spec §2.3)', () => {
  it('builds an R2 endpoint from the account id, checks the bucket, and saves the advanced options', async () => {
    const { calls } = mockApi({ 'POST backup-destinations': () => [201, DEST()] })
    mountApp(DestinationEditor, { props: { startType: 's3' } })
    await flushPromises()
    expect(document.querySelector('[role="note"]')).toBeNull()
    radio('preset', 'r2').click()
    await flushPromises()
    await next()
    await typeInto(byLabel('Name'), 'R2')
    expect(byLabel('Endpoint').readOnly).toBe(true)
    await typeInto(byLabel('Account id'), 'abc123')
    expect(byLabel('Endpoint').value).toBe('https://abc123.r2.cloudflarestorage.com')
    await typeInto(byLabel('Bucket'), 'Bad_Bucket')
    expect(byLabel('Bucket').getAttribute('aria-invalid')).toBe('true')
    expect(text()).toContain('3–63 lowercase letters, digits, dots and dashes')
    await typeInto(byLabel('Access key id'), 'R2KEYID0001')
    await typeInto(byLabel('Secret access key'), 'r2-secret-value-1')
    expect(button('Next').disabled).toBe(true)
    expect(button('Save').disabled).toBe(true)
    await typeInto(byLabel('Bucket'), 'acme-backups')
    expect(byLabel('Bucket').hasAttribute('aria-invalid')).toBe(false)
    expect(button('Save').disabled).toBe(false)
    await typeInto(byLabel('Prefix (optional)'), 'prod/mongo')
    const advanced = document.querySelector('details')!
    const selects = advanced.querySelectorAll('select')
    await choose(selects[0]!, 'GLACIER')
    expect(text()).toContain(
      'Objects in this class must be thawed (Thaw… in the destination’s backups) before a restore.',
    )
    await choose(selects[1]!, 'aws:kms')
    await typeInto(byLabel('KMS key id (optional)'), 'alias/backups')
    advanced.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await save()
    const create = calls.find((c) => c.method === 'POST' && c.path === 'backup-destinations')!
    expect(create.body).toMatchObject({
      type: 's3',
      config: {
        preset: 'r2',
        region: 'auto',
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
        bucket: 'acme-backups',
        prefix: 'prod/mongo',
        pathStyle: true,
        storageClass: 'GLACIER',
        sse: { kind: 'aws:kms', keyId: 'alias/backups' },
      },
      secrets: { accessKeyId: 'R2KEYID0001', secretAccessKey: 'r2-secret-value-1' },
    })
    expect(DestinationInputSchema.safeParse(create.body).success).toBe(true)
    expect(text()).not.toContain('r2-secret-value-1')
  })

  it('warns about MinIO and Cold Storage, lets a MinIO address be typed, and follows a Spaces region', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { startType: 's3' } })
    await flushPromises()
    radio('preset', 'spacesCold').click()
    await flushPromises()
    expect(document.querySelector('[role="note"]')!.textContent).toContain(
      'bills every object for at least 30 days',
    )
    radio('preset', 'minio').click()
    await flushPromises()
    expect(document.querySelector('[role="note"]')!.textContent).toContain('MinIO uses path-style addresses')
    await next()
    expect(byLabel('Endpoint').readOnly).toBe(false)
    await typeInto(byLabel('Endpoint'), 'http://192.168.1.5:9000')
    expect(text()).toContain('This looks like a private address')
    expect(text()).toContain('Traffic to this address is not encrypted.')
    // A region typed for MinIO never overwrites the address.
    await typeInto(byLabel('Region'), 'eu-local-1')
    expect(byLabel('Endpoint').value).toBe('http://192.168.1.5:9000')
    button('Back').click()
    await flushPromises()
    radio('preset', 'spaces').click()
    await flushPromises()
    await next()
    expect(byLabel('Endpoint').value).toBe('https://fra1.digitaloceanspaces.com')
    const region = byLabel<HTMLSelectElement>('Region')
    expect(region.value).toBe('fra1')
    await choose(region, 'ams3')
    expect(byLabel('Endpoint').value).toBe('https://ams3.digitaloceanspaces.com')
  })

  it('names a stored access key by its last characters only, until it is replaced', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    expect(text()).toContain('The stored key ends in 7KQ2')
    button('Replace').click()
    await flushPromises()
    expect(text()).not.toContain('The stored key ends in 7KQ2')
    expect(byLabel('Access key id').value).toBe('')
  })
})

describe('destinations page (phase 3d-3b D1)', () => {
  const menu = async (name: string, item: string) => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === item)!
      .click()
    await flushPromises()
  }
  const reads = (calls: Array<{ method: string; path: string }>) =>
    calls.filter((c) => c.method === 'GET' && c.path === 'backup-destinations/all').length

  it('tests a saved destination and says in words how it went', async () => {
    const results = [
      { steps: [{ step: 'resolve', ok: true, ms: 3 }] },
      {
        steps: [
          { step: 'auth', ok: false, ms: null, reason: 'auth', detail: 'SignatureDoesNotMatch' },
          { step: 'write', ok: false, ms: null, reason: 'skipped' },
        ],
      },
    ]
    const { calls } = mockApi({
      'GET backup-destinations/all': () => [200, [DEST()]],
      'POST backup-destinations/d1/test': () =>
        results.length ? [200, results.shift()] : [403, { code: 'FORBIDDEN', message: 'admin only' }],
    })
    mountApp(DestinationsView)
    mountApp(ToastHost)
    await flushPromises()
    const before = reads(calls)
    await menu('Offsite', 'Test now')
    expect(text()).toContain('Offsite works')
    expect(reads(calls)).toBeGreaterThan(before)
    await menu('Offsite', 'Test now')
    expect(text()).toContain('Offsite: The access key or the secret is wrong.')
    // The provider's own error code is for the checklist, not the toast.
    expect(text()).not.toContain('SignatureDoesNotMatch')
    await menu('Offsite', 'Test now')
    expect(text()).toContain('You do not have permission to do this.')
  })

  it('deletes only after confirmation, and says why a delete failed', async () => {
    let fail = false
    const { calls } = mockApi({
      'GET backup-destinations/all': () => [200, [DEST()]],
      'DELETE backup-destinations/d1': () => (fail ? [409, { code: 'CONFLICT', message: 'busy' }] : [204]),
    })
    mountApp(DestinationsView)
    mountApp(DialogHost)
    mountApp(ToastHost)
    await flushPromises()
    await menu('Offsite', 'Delete…')
    expect(text()).toContain('Delete Offsite?')
    expect(text()).toContain('Backups already sent stay at the destination')
    document.querySelector<HTMLButtonElement>('[data-test="cancel"]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    const before = reads(calls)
    await menu('Offsite', 'Delete…')
    button('Delete destination').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['backup-destinations/d1'])
    expect(reads(calls)).toBeGreaterThan(before)
    fail = true
    await menu('Offsite', 'Delete…')
    button('Delete destination').click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'This conflicts with the current state. Reload and try again.',
    )
  })

  it('opens the editor on a card, and on a type from the empty state', async () => {
    let list = [DEST()]
    mockApi({ 'GET backup-destinations/all': () => [200, list] })
    mountApp(DestinationsView)
    await flushPromises()
    await menu('Offsite', 'Edit…')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit Offsite')
    document.body.innerHTML = ''
    list = []
    mountApp(DestinationsView)
    await flushPromises()
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('WebDAV'))!.click()
    await flushPromises()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Add a destination')
    expect(radio('webdav-preset', 'nextcloud')).not.toBeNull()
  })

  it('offers a search past six destinations and filters the cards by name', async () => {
    const many = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Offsite Backup'].map((name, i) =>
      DEST({ id: `d${i}`, name }),
    )
    mockApi({ 'GET backup-destinations/all': () => [200, many] })
    mountApp(DestinationsView)
    await flushPromises()
    const search = byLabel('Search destinations')
    await typeInto(search, '  offsite ')
    await flushPromises()
    expect([...document.querySelectorAll('article')].map((a) => a.getAttribute('aria-label'))).toEqual([
      'Offsite Backup',
    ])
  })

  it('says why the list cannot be read', async () => {
    mockApi({ 'GET backup-destinations/all': () => [403, { code: 'FORBIDDEN', message: 'admin only' }] })
    mountApp(DestinationsView)
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      'You do not have permission to do this.',
    )
  })
})
