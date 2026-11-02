import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { DeviceFlowStartSchema } from '@mongo-manager/shared/browser'
import DestinationEditor from '../src/destinations/DestinationEditor.vue'
import DestinationsView from '../src/destinations/DestinationsView.vue'
import DsSecretField from '../src/ds/DsSecretField.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import en from '../src/i18n/locales/en.json'
import tr from '../src/i18n/locales/tr.json'
import { mockApi, mountApp, type ApiCall } from './support/app'
import { button, byLabel, choose, typeInto } from './support/dom'
import { DEST } from './support/destinations'

/** Phase 3d-3b final review: the destination editor, Drive sign-in, access step and page (C-findings). */
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

const t = (key: string, named: Record<string, unknown> = {}) => i18n.global.t(key, named)
const text = () => document.body.textContent ?? ''
const current = () =>
  document.querySelector('button[aria-current="step"]')?.textContent?.replace(/^\d+/, '').trim()
const stepButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('ol button')].find((b) => b.textContent?.includes(label))!
async function toStep(label: string): Promise<void> {
  stepButton(label).click()
  await flushPromises()
}
const altArrow = (el: Element, key: 'ArrowRight' | 'ArrowLeft' = 'ArrowRight') => {
  const e = new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}
const testCalls = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path === 'backup-destinations/d1/test')
const PASS = { steps: [{ step: 'resolve', ok: true, ms: 2 }] }
const FAIL = { steps: [{ step: 'auth', ok: false, ms: null, reason: 'auth' }] }
const DRIVE_ID = '3f2b8c1e-6d4a-4b7e-9c2d-1a5e8f0b7c3d'
const GDRIVE = (state: 'ok' | 'reconnect' = 'ok') =>
  DEST({
    id: DRIVE_ID,
    type: 'gdrive',
    config: { auth: 'oauth', folderName: 'MM', clientId: 'client-id-0001.apps.googleusercontent.com' },
    secrets: { clientSecret: true, serviceAccountKey: false, refreshToken: true },
    keyHint: null,
    status: {
      state,
      checkedAt: 1,
      account: 'ops@example.com',
      ...(state === 'reconnect' ? { reason: 'reconnect' } : {}),
    },
  })
const FLOW = (flowId = 'f1') => ({
  flowId,
  userCode: 'WXYZ-1234',
  verificationUrl: 'https://www.google.com/device',
  expiresAt: Date.now() + 900_000,
  interval: 5,
})
const SA_KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'mm-backup@acme-prod.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n',
})
const keyInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Service account key (JSON)"]')
const radio = (name: string, value: string) =>
  document.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`)!

describe('C1: testing an edited destination with its stored secrets', () => {
  it('tests with the stored settings when only the name changed, and with the changed settings otherwise', async () => {
    const { calls } = mockApi({ 'POST backup-destinations/d1/test': () => [200, PASS] })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'Offsite renamed')
    await toStep('Test and save')
    button('Test the connection').click()
    await flushPromises()
    // Name, access and policy are not part of a connection: the stored destination is tested.
    expect(testCalls(calls).at(-1)!.body).toBeUndefined()
    await toStep('Connection')
    await typeInto(byLabel('Prefix (optional)'), 'nightly')
    await toStep('Test and save')
    button('Test the connection').click()
    await flushPromises()
    const body = testCalls(calls).at(-1)!.body as { config: Record<string, unknown>; secrets?: object }
    expect(body.config.prefix).toBe('nightly')
    // The stored secrets stay on the server, which merges them in.
    expect(body).not.toHaveProperty('secrets')
    expect(calls.some((c) => c.path === 'backup-destinations/test')).toBe(false)
  })

  it('says the credentials are needed again when an address change is tested without them', async () => {
    mockApi({
      'POST backup-destinations/d1/test': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Enter every secret again',
          details: { reason: 'secrets_required' },
        },
      ],
    })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    await typeInto(byLabel('Bucket'), 'acme-other')
    await toStep('Test and save')
    button('Test the connection').click()
    await flushPromises()
    expect(text()).toContain(t('destinations.reason.secrets_required'))
  })
})

describe('contract: PATCH removes a cleared optional field', () => {
  it('sends null for a stored CA certificate and KMS key id the user cleared', async () => {
    const { calls } = mockApi({ 'PATCH backup-destinations/d1': () => [200, DEST()] })
    const existing = DEST({
      config: {
        ...DEST().config,
        sse: { kind: 'aws:kms', keyId: 'arn:aws:kms:eu-west-1:1:key/abc' },
        caPem: '-----BEGIN CERTIFICATE-----x',
      },
    })
    mountApp(DestinationEditor, { props: { existing } })
    await flushPromises()
    await typeInto(byLabel<HTMLTextAreaElement>('CA certificate (PEM, optional)'), ' ')
    await typeInto(byLabel('KMS key id (optional)'), '')
    button('Save').click()
    await flushPromises()
    const body = calls.find((c) => c.method === 'PATCH')!.body as { config: Record<string, unknown> }
    expect(body.config.caPem).toBeNull()
    expect(body.config.sse).toEqual({ kind: 'aws:kms', keyId: null })
  })
})

describe('C14: an address change asks for every secret again, field by field', () => {
  it('opens each stored secret empty with the reason, and saves once both are typed', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    expect(document.querySelectorAll('[data-reenter]')).toHaveLength(0)
    await typeInto(byLabel('Bucket'), 'acme-other')
    const notes = [...document.querySelectorAll('[data-reenter]')]
    expect(notes).toHaveLength(2)
    expect(notes[0]!.textContent).toContain(t('destinations.secret.reenter'))
    expect(text()).not.toContain('Keep the stored one')
    expect(button('Save').disabled).toBe(true)
    await typeInto(byLabel('Access key id'), 'AKIANEWKEY')
    await typeInto(byLabel('Secret access key'), 'new-secret-key')
    expect(button('Save').disabled).toBe(false)
    // Back to the stored address: the stored secrets apply again.
    await typeInto(byLabel('Access key id'), '')
    await typeInto(byLabel('Secret access key'), '')
    await typeInto(byLabel('Bucket'), 'acme')
    expect(document.querySelectorAll('[data-reenter]')).toHaveLength(0)
  })
})

describe('C13: editor keyboard', () => {
  it('moves on with Alt+→ only when the step is complete, never from inside a text field', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { startType: 's3' } })
    await flushPromises()
    const panel = document.querySelector('[role="dialog"]')!
    expect(current()).toBe('Provider')
    altArrow(panel)
    await flushPromises()
    expect(current()).toBe('Connection')
    // Nothing filled in: Next is disabled, and so is its shortcut.
    altArrow(panel)
    await flushPromises()
    expect(current()).toBe('Connection')
    altArrow(panel, 'ArrowLeft')
    await flushPromises()
    expect(current()).toBe('Provider')
    altArrow(panel)
    await flushPromises()
    // Option+← inside a field is the platform's word navigation: the sheet leaves it alone.
    const name = byLabel('Name')
    const e = altArrow(name, 'ArrowLeft')
    await flushPromises()
    expect(e.defaultPrevented).toBe(false)
    expect(current()).toBe('Connection')
  })

  it('puts the focus on the question asked before saving after a failed test', async () => {
    mockApi({ 'POST backup-destinations/d1/test': () => [200, FAIL] })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    await toStep('Test and save')
    button('Test the connection').click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})

describe('C15: a create whose access list failed', () => {
  it('becomes an edit of the saved destination and retries only the access list', async () => {
    teamMode()
    let grantsFail = true
    const { calls } = mockApi({
      'GET users': () => [200, [{ id: 'u2', username: 'bob', role: 'viewer', disabled: false }]],
      'POST backup-destinations': () => [
        201,
        DEST({ id: 'd1', name: 'NAS', type: 'folder', config: { path: '/srv/b' }, grants: [] }),
      ],
      'PUT backup-destinations/d1/grants': () =>
        grantsFail
          ? [500, { code: 'INTERNAL', message: 'boom' }]
          : [200, [{ userId: 'u2', username: 'bob', level: 'send' }]],
    })
    const saved = vi.fn()
    mountApp(DestinationEditor, { props: { startType: 'folder', onSaved: saved } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'NAS')
    await typeInto(byLabel('Folder on the server'), '/srv/b')
    await toStepNext()
    await choose(document.querySelector<HTMLSelectElement>('section select')!, 'u2')
    button(t('destinations.access.addButton')).click()
    await flushPromises()
    button('Save').click()
    await flushPromises()
    expect(saved).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit NAS')
    grantsFail = false
    button('Save').click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST' && c.path === 'backup-destinations')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2)
    expect(saved).toHaveBeenCalledOnce()
  })
})

async function toStepNext(): Promise<void> {
  button('Next').click()
  await flushPromises()
}
function teamMode(): void {
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never
}

describe('C16: a test that outlives its settings', () => {
  it('aborts the running test when the editor closes', async () => {
    const { fetchMock } = mockApi({ 'POST backup-destinations/test': () => new Promise(() => undefined) })
    const { wrapper } = mountApp(DestinationEditor, { props: { startType: 'folder' } })
    await flushPromises()
    await typeInto(byLabel('Name'), 'NAS')
    await typeInto(byLabel('Folder on the server'), '/srv/b')
    await toStepNext()
    await toStepNext()
    button('Test the connection').click()
    await flushPromises()
    const init = fetchMock.mock.calls.find(([u]) => String(u).endsWith('backup-destinations/test'))![1]!
    expect(init.signal?.aborted).toBe(false)
    wrapper.unmount()
    expect(init.signal?.aborted).toBe(true)
  })

  it('marks a result that arrives after an edit as out of date', async () => {
    let answer: (v: [number, unknown]) => void = () => undefined
    mockApi({ 'POST backup-destinations/d1/test': () => new Promise((r) => (answer = r)) })
    mountApp(DestinationEditor, { props: { existing: DEST() } })
    await flushPromises()
    await typeInto(byLabel('Prefix (optional)'), 'a')
    await toStep('Test and save')
    button('Test the connection').click()
    await flushPromises()
    await toStep('Connection')
    await typeInto(byLabel('Prefix (optional)'), 'b')
    answer([200, PASS])
    await flushPromises()
    await toStep('Test and save')
    expect(text()).toContain(t('destinations.test.stale'))
    expect(text()).not.toContain(t('destinations.test.passed'))
  })
})

describe('C17: secret field', () => {
  it('labels only what exists, names the secret it replaces, keeps the focus and aligns the eye', async () => {
    const { wrapper } = mountApp(DsSecretField, {
      props: {
        label: 'Secret access key',
        stored: true,
        modelValue: null,
        'onUpdate:modelValue': (v: string | null) => wrapper.setProps({ modelValue: v }),
      },
    })
    await flushPromises()
    for (const l of document.querySelectorAll('label[for]'))
      expect(document.getElementById(l.getAttribute('for')!)).not.toBeNull()
    const replace = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Replace Secret access key"]',
    )!
    expect(replace).not.toBeNull()
    replace.click()
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Secret access key'))
    const eye = document.querySelector<HTMLButtonElement>('button[aria-label="Show Secret access key"]')!
    // The eye sits beside the input alone; "Keep" is below it, not inside its box.
    expect(eye.parentElement!.querySelectorAll('button')).toHaveLength(1)
    button('Keep the stored one').click()
    await flushPromises()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Replace Secret access key')
  })
})

describe('C18: editing an R2 destination', () => {
  it('restores the account id from the stored endpoint and keeps it when the region changes', async () => {
    mockApi({})
    const existing = DEST({
      config: {
        preset: 'r2',
        endpoint: 'https://0123abcd.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'acme',
        prefix: '',
        pathStyle: false,
        storageClass: 'STANDARD',
        sse: { kind: 'none' },
      },
    })
    mountApp(DestinationEditor, { props: { existing } })
    await flushPromises()
    expect(byLabel('Account id').value).toBe('0123abcd')
    await typeInto(byLabel('Region'), 'wnam')
    expect(byLabel('Endpoint').value).toBe('https://0123abcd.r2.cloudflarestorage.com')
  })
})

describe('C4: reconnecting Google Drive', () => {
  it('says a reconnect is needed instead of "Connected", and reconnects with the stored secret', async () => {
    const { calls } = mockApi({ 'POST backup-destinations/google/device': () => [200, FLOW()] })
    mountApp(DestinationEditor, { props: { existing: GDRIVE('reconnect') } })
    await flushPromises()
    expect(text()).not.toContain('Connected as ops@example.com')
    expect(text()).toContain(t('destinations.drive.reconnectNeeded', { account: 'ops@example.com' }))
    const reconnect = button(t('destinations.drive.reconnect'))
    expect(reconnect.disabled).toBe(false)
    reconnect.click()
    await flushPromises()
    // The page never holds the stored secret: the server uses it for this destination.
    const start = calls.find((c) => c.path === 'backup-destinations/google/device')!.body
    expect(start).toEqual({ clientId: 'client-id-0001.apps.googleusercontent.com', destinationId: DRIVE_ID })
    // The server's own schema (B31) accepts it.
    expect(DeviceFlowStartSchema.safeParse(start).error?.issues ?? []).toEqual([])
    expect(document.querySelector('code')!.textContent).toBe('WXYZ-1234')
  })

  it('connects again with the stored secret, and asks for one when the client id changed', async () => {
    mockApi({ 'POST backup-destinations/google/device': () => [200, FLOW()] })
    mountApp(DestinationEditor, { props: { existing: GDRIVE('ok') } })
    await flushPromises()
    expect(text()).toContain('Connected as ops@example.com')
    expect(button('Try again').disabled).toBe(false)
    await typeInto(byLabel('OAuth client id'), 'client-id-0002.apps.googleusercontent.com')
    expect(button('Try again').disabled).toBe(true)
    expect(text()).toContain(t('destinations.drive.needsClient'))
  })
})

describe('C6: the service-account key is never shown', () => {
  it('keeps no private key on screen after a paste, names the account and offers Replace', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    radio('drive-auth', 'serviceAccount').click()
    await flushPromises()
    await toStepNext()
    await typeInto(keyInput()!, SA_KEY)
    await flushPromises()
    const values = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    ].map((e) => e.value)
    expect(values.join(' ')).not.toContain('PRIVATE KEY')
    expect(text()).not.toContain('PRIVATE KEY')
    expect(text()).toContain('Key for mm-backup@acme-prod.iam.gserviceaccount.com')
    expect(keyInput()).toBeNull()
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Replace Service account key (JSON)"]')!
      .click()
    await flushPromises()
    expect(keyInput()!.value).toBe('')
  })
})

describe('C19: the Drive sign-in lives as long as the editor', () => {
  async function waiting() {
    const app = mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    await toStepNext()
    await typeInto(byLabel('OAuth client id'), 'client-id-0001.apps.googleusercontent.com')
    await typeInto(byLabel('OAuth client secret'), 'client-secret-1')
    button('Connect Google account').click()
    await flushPromises()
    return app
  }

  it('schedules nothing after the editor closed, even with a poll on its way', async () => {
    let answer: (v: [number, unknown]) => void = () => undefined
    let polls = 0
    mockApi({
      'POST backup-destinations/google/device': () => [200, FLOW()],
      'GET backup-destinations/google/device/f1': () => {
        polls++
        return new Promise((r) => (answer = r))
      },
    })
    const { wrapper } = await waiting()
    await vi.advanceTimersByTimeAsync(5_500)
    expect(polls).toBe(1)
    wrapper.unmount()
    answer([200, { state: 'pending' }])
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(polls).toBe(1)
  })

  it('stops waiting on Cancel, and keeps a waiting sign-in when stepping back and forth', async () => {
    let polls = 0
    mockApi({
      'POST backup-destinations/google/device': () => [200, FLOW()],
      'GET backup-destinations/google/device/f1': () => {
        polls++
        return [200, { state: 'pending' }]
      },
    })
    await waiting()
    button('Back').click()
    await flushPromises()
    await toStepNext()
    expect(document.querySelector('code')?.textContent).toBe('WXYZ-1234')
    await vi.advanceTimersByTimeAsync(5_500)
    expect(polls).toBe(1)
    button(t('destinations.drive.cancel')).click()
    await flushPromises()
    expect(document.querySelector('code')).toBeNull()
    expect(button('Connect Google account').disabled).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(polls).toBe(1)
  })

  it('says a key file is too large instead of ignoring it', async () => {
    mockApi({})
    mountApp(DestinationEditor, { props: { startType: 'gdrive' } })
    await flushPromises()
    radio('drive-auth', 'serviceAccount').click()
    await flushPromises()
    await toStepNext()
    const e = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', {
      value: { files: [new File(['x'.repeat(20_000)], 'big.json', { type: 'application/json' })] },
    })
    keyInput()!.dispatchEvent(e)
    await flushPromises()
    expect(text()).toContain(t('destinations.drive.keyTooLarge'))
  })
})

describe('C10: granting access takes an explicit Add', () => {
  it('adds nobody while the list is arrowed through, and adds the chosen user on Add', async () => {
    teamMode()
    mockApi({
      'GET users': () => [
        200,
        [
          { id: 'u2', username: 'bob', role: 'viewer', disabled: false },
          { id: 'u5', username: 'carol', role: 'viewer', disabled: false },
        ],
      ],
    })
    mountApp(DestinationEditor, { props: { existing: DEST({ grants: [] }) } })
    await flushPromises()
    await toStep('Access')
    const select = document.querySelector<HTMLSelectElement>('section select')!
    await choose(select, 'u2')
    await choose(select, 'u5')
    expect(document.querySelector('[role="group"][aria-label="bob"]')).toBeNull()
    expect(document.querySelector('[role="group"][aria-label="carol"]')).toBeNull()
    button(t('destinations.access.addButton')).click()
    await flushPromises()
    expect(document.querySelector('[role="group"][aria-label="carol"]')).not.toBeNull()
    expect(document.querySelector('[role="group"][aria-label="bob"]')).toBeNull()
  })
})

describe('C12, C20: the destinations page', () => {
  const menu = async (name: string, item: string) => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.trim() === item)!
      .click()
    await flushPromises()
  }

  it('shows a running test on its card and does not start another one', async () => {
    let answer: (v: [number, unknown]) => void = () => undefined
    const { calls } = mockApi({
      'GET backup-destinations/all': () => [200, [DEST()]],
      'POST backup-destinations/d1/test': () => new Promise((r) => (answer = r)),
    })
    mountApp(DestinationsView)
    mountApp(ToastHost)
    await flushPromises()
    await menu('Offsite', 'Test now')
    const card = document.querySelector('article[aria-label="Offsite"]')!
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.textContent).toContain(t('destinations.card.testing'))
    await menu('Offsite', 'Test now')
    expect(testCalls(calls)).toHaveLength(1)
    answer([200, PASS])
    await flushPromises()
    expect(card.getAttribute('aria-busy')).toBe('false')
  })

  // Short names review 8 (M-6): a card says which folder refusal its last test found.
  it('says on a card which folder refusal its last test found', async () => {
    mockApi({
      'GET backup-destinations/all': () => [
        200,
        [DEST({ status: { state: 'failed', checkedAt: Date.now(), reason: 'path', why: 'data' } })],
      ],
    })
    mountApp(DestinationsView)
    await flushPromises()
    expect(document.querySelector('article')!.textContent).toContain(t('destinations.pathWhy.data'))
  })

  // Short names review 8 (M-12): a key that cannot be read says what to paste, for Drive and GCS.
  it('says what to paste for a service account key that cannot be read', async () => {
    const TestChecklist = (await import('../src/destinations/TestChecklist.vue')).default
    for (const type of ['gdrive', 'gcs'] as const) {
      document.body.innerHTML = ''
      mountApp(TestChecklist, {
        props: {
          running: false,
          type,
          steps: [{ step: 'auth', ok: false, ms: null, reason: 'secrets_invalid' }],
        },
      })
      expect(document.body.textContent).toContain(t(`destinations.fixHint.secrets_invalid_${type}`))
    }
  })

  // Short names review 7 (M-6): a test from the list says the folder name refused in its toast.
  it('says the folder name refused when a test from the list fails for it', async () => {
    mockApi({
      'GET backup-destinations/all': () => [200, [DEST()]],
      'POST backup-destinations/d1/test': () => [
        200,
        { steps: [{ step: 'auth', ok: false, ms: null, reason: 'path_name', name: '"nul"' }] },
      ],
    })
    mountApp(DestinationsView)
    mountApp(ToastHost)
    await flushPromises()
    await menu('Offsite', 'Test now')
    await flushPromises()
    expect(text()).toContain(
      t('destinations.testResult.failed', {
        name: 'Offsite',
        reason: t('destinations.reasonNamed.path_name', { name: '"nul"' }),
      }),
    )
  })

  it('clears a hidden search, says when nothing matches, offers Retry, shows why a card failed, and ticks', async () => {
    const many = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'].map((name, i) =>
      DEST({ id: `d${i}`, name }),
    )
    let list = many
    let fail = true
    mockApi({
      'GET backup-destinations/all': () => (fail ? [500, { code: 'INTERNAL', message: 'x' }] : [200, list]),
    })
    const { queryClient } = mountApp(DestinationsView)
    await flushPromises()
    fail = false
    button(t('common.retry')).click()
    await flushPromises()
    const search = byLabel('Search destinations')
    await typeInto(search, 'nothing like it')
    await flushPromises()
    expect(text()).toContain(t('destinations.noMatch', { filter: 'nothing like it' }))
    list = many.slice(0, 3)
    await queryClient.invalidateQueries()
    await flushPromises()
    // The box is gone: so is its filter.
    expect(document.querySelectorAll('article')).toHaveLength(3)

    list = [
      DEST({
        status: { state: 'failed', checkedAt: Date.now() - 30_000, reason: 'auth' },
      }),
    ]
    await queryClient.invalidateQueries()
    await flushPromises()
    const card = document.querySelector('article')!
    expect(card.textContent).toContain(t('destinations.reason.auth_s3'))
    const before = card.textContent
    await vi.advanceTimersByTimeAsync(120_000)
    await flushPromises()
    expect(card.textContent).not.toBe(before)
  })
})

describe('C9, C25: refusals and wording in both languages', () => {
  const CODES = [
    'name_taken',
    'local_gone',
    'copy_sending',
    'copy_complete',
    'copy_not_failed',
    'unknown_user',
    'device_flows_busy',
    'secrets_required',
    'device_flow_client',
    'copy_incomplete',
    'backup_gone',
    'upload_gone',
    'upload_fetching',
    'secrets_invalid',
  ]
  it('has words for every refusal a destination route can give', () => {
    for (const locale of [en, tr] as Array<{ destinations: { reason: Record<string, string> } }>)
      for (const code of CODES) expect(locale.destinations.reason[code], code).toBeTruthy()
  })

  it('reads naturally in Turkish', () => {
    const d = tr.destinations as unknown as Record<string, Record<string, unknown>>
    expect(tr.backup.copies.discard).not.toBe('Vazgeç')
    expect((d.editor as Record<string, string>).titleEdit).toBe('Düzenle: {name}')
    // A grant is removed, not the user: "Erişimi kaldır", never "Sil".
    expect((d.access as Record<string, string>).remove).toBe('Erişimi kaldır: {name}')
    expect((d.status as Record<string, string>).failed).toBe('Dikkat gerekiyor')
    // Google's Turkish console: "Ortak drive", "İstemci gizli anahtarı".
    expect(JSON.stringify(tr)).not.toContain('Shared Drive')
    expect((d.drive as Record<string, string>).clientSecret).toBe('OAuth istemci gizli anahtarı')
    expect(JSON.stringify(tr)).not.toContain('sırrı')
    // One name for the last step everywhere.
    expect((d.editor as { steps: Record<string, string> }).steps.test).toBe('Test et ve kaydet')
    expect(JSON.stringify(tr)).not.toMatch(/[Ss]ına ve kaydet/)
  })

  it('says a wrong sign-in in the words of each type', () => {
    for (const locale of [en, tr] as Array<{ destinations: { reason: Record<string, string> } }>) {
      expect(locale.destinations.reason.auth).toBeTruthy()
      expect(locale.destinations.reason.auth_s3).toBeTruthy()
      expect(locale.destinations.reason.auth_webdav).toBeTruthy()
      expect(locale.destinations.reason.auth_gdrive).toBeTruthy()
    }
    expect(en.destinations.reason.auth).not.toMatch(/access key/i)
    expect(en.destinations.reason.auth_webdav).not.toMatch(/access key/i)
  })
})

// Final gate (fixer D's findings): the words for a never-allowed address and an untested save.
describe('final gate: honest refusal and save texts', () => {
  it('does not tell the operator to list an address no setting can allow', async () => {
    const TestChecklist = (await import('../src/destinations/TestChecklist.vue')).default
    mountApp(TestChecklist, {
      props: {
        running: false,
        steps: [{ step: 'resolve', ok: false, ms: null, reason: 'address_never', detail: null }],
      },
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('This address can never be used')
    expect(text).not.toContain('add the network to MM_BACKUP_PRIVATE_NETWORKS')
    expect(tr.destinations.reason.address_never).toBeTruthy()
    expect(tr.destinations.fixHint.address_never).toBeTruthy()
  })

  // Short names review 5 (M-4): a folder name Windows cannot use gets its own words and fix.
  it('says a folder name Windows cannot use is the trouble, not the roots', async () => {
    const TestChecklist = (await import('../src/destinations/TestChecklist.vue')).default
    mountApp(TestChecklist, {
      props: {
        running: false,
        type: 'folder',
        steps: [{ step: 'auth', ok: false, ms: null, reason: 'path_name', detail: null }],
      },
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain(en.destinations.reason.path_name)
    // vue-i18n reads | as a plural separator (and braces as placeholders): the hint shows whole.
    expect(text).toContain(en.destinations.fixHint.path_name)
    expect(text).not.toContain('Choose a folder inside MM_BACKUP_FOLDER_ROOTS')
  })

  // Short names review 6 (M-6): the Turkish words shown whole too, not only present.
  it('says the same in Turkish, whole', async () => {
    const TestChecklist = (await import('../src/destinations/TestChecklist.vue')).default
    i18n.global.locale.value = 'tr'
    try {
      mountApp(TestChecklist, {
        props: {
          running: false,
          type: 'folder',
          steps: [{ step: 'auth', ok: false, ms: null, reason: 'path_name', name: '"nul"' }],
        },
      })
      const text = document.body.textContent ?? ''
      // Short names review 7 (M-6): the name in the cause itself, not hidden under details.
      expect(text).toContain(tr.destinations.reasonNamed.path_name.replace('{name}', '"nul"'))
      expect(text).toContain(tr.destinations.fixHint.path_name)
    } finally {
      i18n.global.locale.value = 'en'
    }
  })

  // Short names review 7 (I-1, I-2): each folder refusal its own words and fix — never the roots
  // hint for a data-directory refusal, nor for an SFTP folder that is missing.
  it('gives each folder refusal its own fix, and an SFTP folder its own words', async () => {
    const TestChecklist = (await import('../src/destinations/TestChecklist.vue')).default
    mountApp(TestChecklist, {
      props: {
        running: false,
        type: 'folder',
        steps: [{ step: 'auth', ok: false, ms: null, reason: 'path', why: 'data' }],
      },
    })
    let text = document.body.textContent ?? ''
    expect(text).toContain(en.destinations.pathWhy.data)
    expect(text).toContain(en.destinations.pathWhyFix.data)
    expect(text).not.toContain(en.destinations.pathWhyFix.roots)
    document.body.innerHTML = ''
    mountApp(TestChecklist, {
      props: {
        running: false,
        type: 'sftp',
        steps: [{ step: 'auth', ok: false, ms: null, reason: 'path' }],
      },
    })
    text = document.body.textContent ?? ''
    expect(text).toContain(en.destinations.reason.path_sftp)
    expect(text).toContain(en.destinations.fixHint.path_sftp)
    expect(text).not.toContain('MM_BACKUP_FOLDER_ROOTS')
  })

  it('does not promise that sending fails while the last test failed', () => {
    expect(en.destinations.editor.saveUntestedHelp).not.toMatch(/until it passes/i)
    expect(tr.destinations.editor.saveUntestedHelp).not.toMatch(/test geçene kadar/i)
  })
})
