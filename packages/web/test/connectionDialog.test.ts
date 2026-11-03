import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, SECRET_MASK, type ConnectionSettings } from '@mongo-manager/shared'
import ConnectionDialog from '../src/connections/ConnectionDialog.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useToastStore } from '../src/stores/toasts'
import { queryKeys } from '../src/api/connections'
import { connectedIn } from '../src/connections/reachability'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, check, choose, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const TLS_OFF = { enabled: false, allowInvalidHostnames: false, allowInvalidCertificates: false }
const dto = (overrides: Record<string, unknown> = {}) => ({
  id: 'c9',
  name: 'Local',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {
    scheme: 'mongodb',
    hosts: [{ host: 'localhost', port: 27017 }],
    auth: { mechanism: 'none' },
    tls: TLS_OFF,
    options: {},
  },
  uri: 'mongodb://localhost:27017',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions: [...PERMISSIONS],
  ...overrides,
})

/** A new form starts empty (user report 2026-10-16): the host Test and Save need. */
async function enterHost(host = 'db.local'): Promise<void> {
  await section('Server')
  await typeInto(byLabel('Host'), host)
}

/** The dialog's primary button: "Save and connect" for a new connection, "Save" for an edited one. */
const save = (): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    ['Save and connect', 'Save'].includes(b.textContent?.trim() ?? ''),
  )!

/** The sections are under "Advanced options" (user request 2026-10-16): opened first when closed. */
async function section(name: string): Promise<void> {
  const toggle = document.querySelector<HTMLButtonElement>('[data-advanced-toggle]')
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    toggle.click()
    await flushPromises()
  }
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent?.trim() === name,
  )
  if (!tab) throw new Error(`No section ${name}`)
  tab.click()
  await flushPromises()
}

// Fourth review of the unreachable fix (I2): an edit forgets its old settings' answer: the connection
// is not connected (nothing that needs its server shown) until its databases are read again.
describe('saving an edit of a connection', () => {
  it('forgets whether it was connected', async () => {
    const stored = dto({
      id: 'c1',
      name: 'Prod',
      settings: {
        scheme: 'mongodb',
        hosts: [{ host: 'db1', port: 27017 }],
        auth: { mechanism: 'NONE' },
        tls: TLS_OFF,
        options: {},
      },
    })
    mockApi({ 'PATCH connections/c1': () => [200, stored] })
    const { queryClient } = mountApp(ConnectionDialog, { props: { connection: stored } })
    queryClient.setQueryData(queryKeys.databases('c1'), { databases: [], totalSize: 0 })
    expect(connectedIn(queryClient, 'c1')).toBe(true)
    await typeInto(byLabel('Name'), 'Prod 2')
    save().click()
    await flushPromises()
    expect(connectedIn(queryClient, 'c1')).toBe(false)
  })
})

// User request 2026-10-16: "too many tabs; connecting to a database cannot take this long". A new
// connection is its string, its name and its colour; everything else is under Advanced options.
describe('a new connection in one short form', () => {
  const toggle = () => document.querySelector<HTMLButtonElement>('[data-advanced-toggle]')!
  const fieldError = (el: HTMLInputElement) =>
    el.getAttribute('aria-invalid') === 'true'
      ? document.getElementById(el.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent
      : null

  it('asks for the string, the name, a colour and a star, and keeps the rest under Advanced options', async () => {
    mockApi({})
    mountApp(ConnectionDialog)
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().hasAttribute('aria-controls')).toBe(false)
    expect(toggle().textContent).toContain('Advanced options')
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(byLabel('Connection string')).toBeTruthy()
    expect(byLabel('Name')).toBeTruthy()
    // The colours are named once, by their legend (review M3).
    const colours = [...document.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')?.textContent === 'Color',
    )!
    expect(colours.querySelector('[role="radiogroup"]')).toBeNull()
    expect(colours.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(2)
    const star = document.querySelector<HTMLButtonElement>('[data-favorite-toggle]')!
    expect(star.getAttribute('aria-pressed')).toBe('false')
    star.click()
    await flushPromises()
    expect(star.getAttribute('aria-pressed')).toBe('true')
    expect(button('Save and connect')).toBeTruthy()
    toggle().click()
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().getAttribute('aria-controls')).toBeTruthy()
    const tablist = document.querySelector('[role="tablist"]')!
    expect(tablist.getAttribute('aria-labelledby')).toBe(toggle().id)
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim())).toEqual([
      'Server',
      'Authentication',
      'TLS / SSL',
      'SSH tunnel',
      'Encryption',
      'Access & grouping',
      'Options',
    ])
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent?.trim()).toBe('Server')
    // The favourite is the star by the name, not a second checkbox (review UX 5).
    await section('Access & grouping')
    expect(document.querySelector('[role="tabpanel"]')!.textContent).not.toContain('Favorite')
  })

  // Review I2: with nothing typed, Test asks for a string where it is typed, the long form stays shut.
  it('asks for a connection string where it is typed, and keeps Advanced options closed', async () => {
    mockApi({})
    mountApp(ConnectionDialog)
    await flushPromises()
    expect(
      document.getElementById(button('Test connection').getAttribute('aria-describedby')!)!.textContent,
    ).toBe('Paste a connection string to test, and name it to save.')
    button('Test connection').click()
    await flushPromises()
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(byLabel('Connection string'))
    expect(fieldError(byLabel('Connection string'))).toBe(
      'Paste a connection string here, or enter a host under Advanced options.',
    )
  })

  it('opens Server at the host for whoever would rather type the host and port', async () => {
    mockApi({})
    mountApp(ConnectionDialog)
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-host-instead]')!.click()
    await flushPromises()
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(byLabel('Host'))
  })

  // Review I1, M6: a wrong name marks nothing under Advanced options; a wrong SSH host opens its tab
  // and has the focus.
  it('opens Advanced options only for what is wrong in there, and focuses it', async () => {
    let issue = 'name'
    mockApi({
      'POST connections/parse-uri': () => [
        200,
        {
          settings: {
            scheme: 'mongodb',
            hosts: [{ host: 'db1' }],
            auth: { mechanism: 'none' },
            tls: TLS_OFF,
            options: {},
          },
        },
      ],
      'POST connections': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ path: issue, message: 'Wrong' }],
        },
      ],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Connection string'), 'db1')
    byLabel('Connection string').dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
    save().click()
    await flushPromises()
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().querySelector('.bg-danger')).toBeNull()
    expect(document.activeElement).toBe(byLabel('Name'))
    issue = 'settings.ssh.host'
    save().click()
    await flushPromises()
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="tab"][aria-selected="true"]')!.textContent?.trim()).toBe(
      'SSH tunnel',
    )
  })

  it('edits an existing connection with Advanced options open, saving without connecting', async () => {
    mockApi({})
    mountApp(ConnectionDialog, { props: { connection: dto() } })
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(button('Save')).toBeTruthy()
    expect(document.querySelector('[data-connection-target]')!.textContent).toBe(
      'Connects to: localhost:27017 · no authentication',
    )
  })

  // Review M1: a duplicate says what it points to and starts on its name.
  it('duplicates with the short form, saying what the copy points to, on its name', async () => {
    mockApi({})
    mountApp(ConnectionDialog, { props: { connection: dto(), duplicate: true } })
    await flushPromises()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-connection-target]')!.textContent).toContain('localhost:27017')
    expect(document.activeElement).toBe(byLabel('Name'))
  })

  // Review I4: the result of a test is brought into view.
  it('brings the test result into view', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    mockApi({
      'POST connections/test': () => [
        200,
        { ok: true, latencyMs: 3, serverVersion: '8.2.6', topology: 'standalone' },
      ],
    })
    mountApp(ConnectionDialog, { props: { connection: dto() } })
    await flushPromises()
    button('Test connection').click()
    await flushPromises()
    await flushPromises()
    expect(scroll).toHaveBeenCalled()
  })
})

// User report 2026-10-16: a new connection's form, nothing typed, offered Test and Save at once.
// Review of the fix: the buttons stay focusable (aria-disabled), so their reason is read and a click
// goes to what is missing.
describe('what the connection editor asks before it tests or saves', () => {
  const testButton = () => button('Test connection') as HTMLButtonElement
  const saveButton = save
  const off = (b: HTMLButtonElement) => b.getAttribute('aria-disabled') === 'true'
  const reason = (b: HTMLButtonElement) =>
    document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent?.trim()

  it('starts empty, Test and Save off, and says what they need', async () => {
    const { calls } = mockApi({ 'POST connections': () => [200, dto()] })
    mountApp(ConnectionDialog)
    await flushPromises()
    expect(off(testButton())).toBe(true)
    expect(off(saveButton())).toBe(true)
    expect(reason(testButton())).toBe('Paste a connection string to test, and name it to save.')
    expect(
      document.getElementById(saveButton().getAttribute('aria-describedby')!)!.getAttribute('role'),
    ).toBe('status')
    // Enter in a field, or a click on Save, sends nothing: the missing name gets the focus.
    byLabel('Name').closest('form')!.requestSubmit()
    saveButton().click()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(document.activeElement).toBe(byLabel('Name'))
    // Test asks for the connection string where it is typed (Advanced options closed).
    testButton().click()
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Connection string'))
    await section('Server')
    expect(byLabel('Host').value).toBe('')
    expect(byLabel('Host').placeholder).toBe('localhost')
    expect(byLabel('Port').placeholder).toBe('27017')
    await typeInto(byLabel('Host'), 'db.local')
    expect(off(testButton())).toBe(false)
    expect(testButton().hasAttribute('aria-describedby')).toBe(false)
    expect(off(saveButton())).toBe(true)
    expect(reason(saveButton())).toBe('Enter a name to save.')
    await typeInto(byLabel('Name'), '  ')
    expect(off(saveButton())).toBe(true)
    await typeInto(byLabel('Name'), 'Local')
    expect(off(saveButton())).toBe(false)
    expect(saveButton().hasAttribute('aria-describedby')).toBe(false)
  })

  it('needs every host row filled, and shows an SRV name as the example for SRV', async () => {
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Name'), 'Cluster')
    await enterHost('db1')
    button('Add host').click()
    await flushPromises()
    expect(off(saveButton())).toBe(true)
    expect(reason(saveButton())).toBe('Enter a host to test or save.')
    saveButton().click()
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Host', 1))
    await choose(byLabel<HTMLSelectElement>('Scheme'), 'mongodb+srv')
    expect(byLabel('Host').placeholder).toBe('cluster0.example.mongodb.net')
  })

  it('saves once on a double click', async () => {
    let answer!: () => void
    const { calls } = mockApi({
      'POST connections': () => new Promise((r) => (answer = () => r([200, dto()]))) as never,
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Name'), 'Local')
    await enterHost()
    saveButton().click()
    await flushPromises()
    saveButton().click()
    byLabel('Host').closest('form')!.requestSubmit()
    await flushPromises()
    answer()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'POST' && c.path === 'connections')).toHaveLength(1)
  })

  it('goes to its own missing field, never to a page field of the same name behind it', async () => {
    const behind = Object.assign(document.createElement('td'), { tabIndex: 0 })
    behind.dataset.connectionField = 'name'
    document.body.append(behind)
    mountApp(ConnectionDialog)
    await flushPromises()
    await section('Server')
    saveButton().click()
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Name'))
  })

  it('saves an edited connection only once something changed, and not after the change is undone', async () => {
    mockApi({ 'PATCH connections/c9': () => [200, dto()] })
    mountApp(ConnectionDialog, { props: { connection: dto() } })
    await flushPromises()
    expect(off(testButton())).toBe(false)
    expect(off(saveButton())).toBe(true)
    expect(reason(saveButton())).toBe('Change something to save.')
    await typeInto(byLabel('Name'), 'Local 2')
    expect(off(saveButton())).toBe(false)
    await typeInto(byLabel('Name'), 'Local')
    expect(off(saveButton())).toBe(true)
  })
})

// User report 2026-10-16: the connection string sat inside Server, wanted "mongodb://", and filled the
// form only through a button nobody took for what it was. It is the form's first field now: what is
// typed or pasted fills the form by itself, and a line says what was read.
describe('the connection string, first in the form', () => {
  const LOCAL: Partial<ConnectionSettings> = {
    scheme: 'mongodb',
    hosts: [{ host: 'localhost', port: 27017 }],
    auth: { mechanism: 'none' },
    tls: TLS_OFF,
    options: {},
  }
  const uriField = () => byLabel('Connection string')
  const status = () => document.querySelector('[data-uri-status]')!
  const fieldError = (el: HTMLInputElement) =>
    el.getAttribute('aria-invalid') === 'true'
      ? document.getElementById(el.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent
      : null
  const leave = async (el: HTMLElement) => {
    el.dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
  }
  const parses = (calls: Array<{ path: string; body: unknown }>) =>
    calls.filter((c) => c.path === 'connections/parse-uri').map((c) => (c.body as { uri: string }).uri)
  afterEach(() => vi.useRealTimers())

  it('starts there, reads host:port as mongodb://, fills the form and names the connection', async () => {
    const { calls } = mockApi({ 'POST connections/parse-uri': () => [200, { settings: LOCAL }] })
    mountApp(ConnectionDialog)
    await flushPromises()
    expect(document.activeElement).toBe(uriField())
    await typeInto(uriField(), '  localhost:27017 ')
    await leave(uriField())
    expect(parses(calls)).toEqual(['mongodb://localhost:27017'])
    expect(status().getAttribute('role')).toBe('status')
    expect(status().textContent).toBe(
      'Read: localhost:27017 · no authentication. Server, Authentication, TLS and Options now follow this string; SSH and certificates stay as they were.',
    )
    expect(byLabel('Name').value).toBe('localhost:27017')
    expect(save().getAttribute('aria-disabled')).toBeNull()
    await section('Server')
    expect(byLabel('Host').value).toBe('localhost')
    // A section switch keeps what was typed and read (review I4).
    await section('Access & grouping')
    expect(uriField().value).toBe('  localhost:27017 ')
    expect(status().textContent).toContain('Read: localhost:27017')
  })

  it('fills a new connection while you type, after a pause, and never with an error then', async () => {
    vi.useFakeTimers()
    const { calls } = mockApi({
      'POST connections/parse-uri': (body) =>
        (body as { uri: string }).uri === 'mongodb://localhost:27017'
          ? [200, { settings: LOCAL }]
          : [400, { code: 'VALIDATION_ERROR', message: 'Invalid host' }],
    })
    mountApp(ConnectionDialog)
    await typeInto(uriField(), 'localhost:')
    await vi.advanceTimersByTimeAsync(800)
    expect(fieldError(uriField())).toBeNull()
    // The same text, left: the refusal is said now (review M2).
    await leave(uriField())
    expect(fieldError(uriField())).toContain('This connection string could not be read: Invalid host')
    await typeInto(uriField(), 'localhost:27017')
    expect(fieldError(uriField())).toBeNull()
    await vi.advanceTimersByTimeAsync(800)
    expect(parses(calls).at(-1)).toBe('mongodb://localhost:27017')
    expect(status().textContent).toContain('Read')
  })

  it('says why timeoutMS is refused in the app’s language', async () => {
    i18n.global.locale.value = 'tr'
    mockApi({
      'POST connections/parse-uri': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'timeoutMS is not supported: the app bounds each operation itself',
          details: { reason: 'option_not_supported', option: 'timeoutMS' },
        },
      ],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Bağlantı dizesi'), 'mongodb://h/?timeoutMS=5000')
    await leave(byLabel('Bağlantı dizesi'))
    const error = fieldError(byLabel('Bağlantı dizesi'))
    expect(error).toContain('timeoutMS desteklenmiyor')
    expect(error).not.toContain('is not supported')
    // The string was read; it is refused, not unreadable.
    expect(error).not.toContain('okunamadı')
  })

  it('keeps a name you typed, and says a refusal in the app’s language on the field', async () => {
    i18n.global.locale.value = 'tr'
    mockApi({
      'POST connections/parse-uri': (body) =>
        (body as { uri: string }).uri.startsWith('mongodb://')
          ? [200, { settings: LOCAL }]
          : [400, { code: 'VALIDATION_ERROR', message: 'Invalid scheme' }],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Ad'), 'Benim sunucum')
    await typeInto(byLabel('Bağlantı dizesi'), 'localhost:27017')
    await leave(byLabel('Bağlantı dizesi'))
    expect(byLabel('Ad').value).toBe('Benim sunucum')
    expect(status().textContent).toContain('Okunan: localhost:27017 · kimlik doğrulama yok')
    await typeInto(byLabel('Bağlantı dizesi'), 'mongodb+srv://')
    await leave(byLabel('Bağlantı dizesi'))
    expect(fieldError(byLabel('Bağlantı dizesi'))).toContain('Bu bağlantı dizesi okunamadı')
    // "mongodb:/host" is a typo of the scheme (review M7), said without asking the server.
    await typeInto(byLabel('Bağlantı dizesi'), 'mongodb:/db1')
    await leave(byLabel('Bağlantı dizesi'))
    expect(fieldError(byLabel('Bağlantı dizesi'))).toContain('iki eğik çizgi')
  })

  // Review I1, I2: editing, the name has the focus, a pause rewrites nothing, and a half-typed user
  // never takes the stored password with it.
  it('editing, starts on the name, rewrites only when told, and keeps the stored password', async () => {
    vi.useFakeTimers()
    const stored = dto({
      settings: {
        scheme: 'mongodb',
        hosts: [{ host: 'db', port: 27017 }],
        auth: { mechanism: 'DEFAULT', username: 'admin', password: SECRET_MASK },
        tls: TLS_OFF,
        options: {},
      },
    })
    const { calls } = mockApi({
      'POST connections/parse-uri': (body) => {
        const uri = (body as { uri: string }).uri
        return [
          200,
          {
            settings: {
              scheme: 'mongodb',
              hosts: [
                {
                  host: uri === 'mongodb://adm' ? 'adm' : 'db',
                  port: uri.endsWith(':27018') ? 27018 : 27017,
                },
              ],
              auth: uri.includes('admin@')
                ? { mechanism: 'DEFAULT', username: 'admin' }
                : { mechanism: 'none' },
              tls: TLS_OFF,
              options: {},
            },
          },
        ]
      },
      'PATCH connections/c9': () => [200, stored],
    })
    mountApp(ConnectionDialog, { props: { connection: stored } })
    await flushPromises()
    expect(document.activeElement).toBe(byLabel('Name'))
    await typeInto(uriField(), 'adm')
    await vi.advanceTimersByTimeAsync(1000)
    expect(parses(calls)).toEqual([])
    await leave(uriField())
    await typeInto(uriField(), 'admin@db:27018')
    await leave(uriField())
    vi.useRealTimers()
    expect(byLabel('Name').value).toBe('Local')
    save().click()
    await flushPromises()
    await flushPromises()
    const body = calls.find((c) => c.method === 'PATCH')!.body as { settings: ConnectionSettings }
    expect(body.settings.auth).toMatchObject({ username: 'admin', password: SECRET_MASK })
  })

  // Review I5, M3: Save reads a string not read yet first; Enter on a read string saves.
  it('reads a string not yet read before it saves, and Enter on a read one saves', async () => {
    const { calls } = mockApi({
      'POST connections/parse-uri': () => [200, { settings: LOCAL }],
      'POST connections': () => [200, dto()],
    })
    mountApp(ConnectionDialog)
    await typeInto(uriField(), 'localhost:27017')
    save().click()
    await flushPromises()
    await flushPromises()
    const saved = calls.find((c) => c.method === 'POST' && c.path === 'connections')!
    expect((saved.body as { settings: ConnectionSettings }).settings.hosts).toEqual([
      { host: 'localhost', port: 27017 },
    ])
    document.body.innerHTML = ''
    const again = mockApi({
      'POST connections/parse-uri': () => [200, { settings: LOCAL }],
      'POST connections': () => [200, dto()],
    })
    mountApp(ConnectionDialog)
    await typeInto(uriField(), 'localhost:27017')
    await leave(uriField())
    uriField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    uriField().closest('form')!.requestSubmit()
    await flushPromises()
    await flushPromises()
    expect(again.calls.some((c) => c.method === 'POST' && c.path === 'connections')).toBe(true)
  })

  it('asks before closing with a string typed but not read', async () => {
    mockApi({})
    const { wrapper } = mountApp(ConnectionDialog)
    mountApp(DialogHost)
    await typeInto(uriField(), 'localhost:27017')
    ;(document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(document.body.textContent).toContain('Discard your changes?')
  })

  // Review M1: an answer for what the field held before applies nothing.
  it('applies no answer for text the field no longer holds', async () => {
    let answer!: () => void
    mockApi({
      'POST connections/parse-uri': () =>
        new Promise((r) => (answer = () => r([200, { settings: LOCAL }]))) as never,
    })
    mountApp(ConnectionDialog)
    await typeInto(uriField(), 'localhost:27017')
    await leave(uriField())
    await typeInto(uriField(), '')
    answer()
    await flushPromises()
    expect(status().textContent).toBe('')
    expect(byLabel('Name').value).toBe('')
  })

  // Review M5: an IPv6 host in brackets; an AWS access key is not shown as a user.
  it('writes an IPv6 host in brackets and never shows an AWS access key', async () => {
    mockApi({
      'POST connections/parse-uri': () => [
        200,
        {
          settings: {
            scheme: 'mongodb',
            hosts: [{ host: '::1', port: 27017 }],
            auth: { mechanism: 'MONGODB-AWS', username: 'AKIAEXAMPLE' },
            tls: TLS_OFF,
            options: {},
          },
        },
      ],
    })
    mountApp(ConnectionDialog)
    await typeInto(uriField(), '[::1]:27017')
    await leave(uriField())
    expect(status().textContent).toContain('Read: [::1]:27017 · with authentication')
    expect(status().textContent).not.toContain('AKIA')
    expect(byLabel('Name').value).toBe('[::1]:27017')
  })
})

describe('connection editor', () => {
  it('creates a connection from the form', async () => {
    const { calls } = mockApi({ 'POST connections': () => [200, dto()] })
    const { wrapper } = mountApp(ConnectionDialog)
    await flushPromises()
    await typeInto(byLabel('Name'), ' Local ')
    await section('Server')
    await typeInto(byLabel('Host'), 'db.local')
    save().click()
    await flushPromises()
    // The save itself: the Server section also asks what this server offers (Docker, 2026-11-02).
    expect(calls.findLast((c) => c.method === 'POST')).toMatchObject({
      method: 'POST',
      path: 'connections',
      body: {
        name: 'Local',
        favorite: false,
        readOnly: false,
        settings: {
          scheme: 'mongodb',
          hosts: [{ host: 'db.local' }],
          auth: { mechanism: 'none' },
          tls: { enabled: false },
          options: {},
        },
      },
    })
    expect(wrapper.emitted('saved')?.[0]?.[1]).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(useToastStore().toasts.at(-1)?.message).toBe('Connection saved.')
  })

  it('fills the form from a pasted URI and keeps its password (Review Focus 2)', async () => {
    const parsed: Partial<ConnectionSettings> = {
      scheme: 'mongodb',
      hosts: [{ host: 'h1', port: 27018 }, { host: 'h2' }],
      replicaSet: 'rs0',
      auth: { mechanism: 'DEFAULT', username: 'ada', password: SECRET_MASK },
      tls: TLS_OFF,
      options: {},
    }
    const { calls } = mockApi({
      'POST connections/parse-uri': () => [200, { settings: parsed }],
      'POST connections': () => [200, dto()],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Name'), 'Cluster')
    await typeInto(byLabel('Connection string'), 'mongodb://ada:p%40ss@h1:27018,h2/?replicaSet=rs0')
    byLabel('Connection string').dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
    expect(document.querySelector('[data-uri-status]')?.textContent).toContain(
      'Read: h1:27018, h2 · user ada · replica set rs0',
    )
    await section('Server')
    expect(byLabel('Host', 1).value).toBe('h2')
    save().click()
    await flushPromises()
    const body = calls.findLast((c) => c.method === 'POST' && c.path === 'connections')!.body as {
      settings: ConnectionSettings
    }
    expect(body.settings.auth).toEqual({ mechanism: 'DEFAULT', username: 'ada', password: 'p@ss' })
    expect(body.settings.hosts).toEqual([{ host: 'h1', port: 27018 }, { host: 'h2' }])
    expect(body.settings.replicaSet).toBe('rs0')
  })

  // Review minor 4: parse-uri masks the session token too; the pasted URI still has it.
  it('keeps a session token of a pasted AWS connection string', async () => {
    const parsed: Partial<ConnectionSettings> = {
      scheme: 'mongodb',
      hosts: [{ host: 'h1' }],
      auth: {
        mechanism: 'MONGODB-AWS',
        username: 'AKIA',
        password: SECRET_MASK,
        mechanismProperties: `AWS_SESSION_TOKEN:${SECRET_MASK}`,
      },
      tls: TLS_OFF,
      options: {},
    }
    const { calls } = mockApi({
      'POST connections/parse-uri': () => [200, { settings: parsed }],
      'POST connections': () => [200, dto()],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Name'), 'Atlas')
    await typeInto(
      byLabel('Connection string'),
      'mongodb://AKIA:s%2Fk@h1/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN%3At%2Bk%3A1',
    )
    byLabel('Connection string').dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
    save().click()
    await flushPromises()
    const body = calls.at(-1)!.body as { settings: ConnectionSettings }
    expect(body.settings.auth).toMatchObject({
      password: 's/k',
      mechanismProperties: 'AWS_SESSION_TOKEN:t+k:1',
    })
  })

  it('shows server validation errors on the right field and section', async () => {
    mockApi({
      'POST connections': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: [{ path: 'settings.hosts.0.host', message: 'Invalid host name' }],
        },
      ],
    })
    mountApp(ConnectionDialog)
    await typeInto(byLabel('Name'), 'Bad')
    await enterHost('bad host')
    save().click()
    await flushPromises()
    const host = byLabel('Host')
    expect(host.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(host.getAttribute('aria-describedby')!)!.textContent).toContain(
      'Invalid host name',
    )
    const serverTab = [...document.querySelectorAll('[role="tab"]')].find(
      (b) => b.textContent?.trim() === 'Server',
    )!
    expect(serverTab.getAttribute('aria-selected')).toBe('true')
  })

  it('pins the SSH host key seen on the first successful test', async () => {
    const { calls } = mockApi({
      'POST connections/test': () => [
        200,
        {
          ok: true,
          latencyMs: 12,
          serverVersion: '8.2.6',
          topology: 'standalone',
          sshFingerprint: 'SHA256:abc',
        },
      ],
    })
    mountApp(ConnectionDialog)
    await enterHost()
    await section('SSH tunnel')
    await check(byLabel('Connect through an SSH tunnel'))
    await typeInto(byLabel('SSH host'), 'jump')
    await typeInto(byLabel('SSH username'), 'u')
    button('Test connection').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({
      settings: { ssh: { enabled: true, host: 'jump', port: 22, username: 'u', method: 'password' } },
    })
    expect(document.querySelector('[data-test="test-result"]')!.textContent).toContain(
      'Connected: MongoDB 8.2.6 · standalone · 12 ms',
    )
    expect(byLabel('Host key fingerprint').value).toBe('SHA256:abc')
  })

  it('says which MongoDB versions are supported when the server is too old (phase 1h)', async () => {
    const message = 'MongoDB 5.0.26 is not supported. mongo-manager supports MongoDB 6.0 and later.'
    mockApi({ 'POST connections/test': () => [200, { ok: false, error: { kind: 'unsupported', message } }] })
    mountApp(ConnectionDialog)
    await enterHost()
    button('Test connection').click()
    await flushPromises()
    const text = document.querySelector('[data-test="test-result"]')!.textContent
    expect(text).toContain(
      'This MongoDB version is not supported. Mongo Manager supports MongoDB 6.0 and later.',
    )
    expect(text).toContain('MongoDB 5.0.26')
  })

  it('offers to trust a changed SSH host key only on explicit request', async () => {
    mockApi({
      'POST connections/test': () => [
        200,
        { ok: false, error: { kind: 'ssh-host-key', message: 'changed', sshFingerprint: 'SHA256:new' } },
      ],
    })
    mountApp(ConnectionDialog)
    await enterHost()
    await section('SSH tunnel')
    await check(byLabel('Connect through an SSH tunnel'))
    await typeInto(byLabel('Host key fingerprint'), 'SHA256:old')
    button('Test connection').click()
    await flushPromises()
    expect(document.querySelector('[data-test="test-result"]')!.textContent).toContain(
      "The SSH server's host key does not match the saved one.",
    )
    expect(byLabel('Host key fingerprint').value).toBe('SHA256:old')
    button('Trust the new key').click()
    await flushPromises()
    expect(byLabel('Host key fingerprint').value).toBe('SHA256:new')
  })

  it('keeps stored secrets when editing and explains a refused reuse (Review Focus 1)', async () => {
    const stored = dto({
      id: 'c1',
      name: 'Prod',
      settings: {
        scheme: 'mongodb',
        hosts: [{ host: 'db1', port: 27017 }],
        auth: { mechanism: 'DEFAULT', username: 'ada', password: SECRET_MASK },
        tls: TLS_OFF,
        options: {},
      },
    })
    const { calls } = mockApi({
      'POST connections/test': () => [
        200,
        { ok: true, latencyMs: 1, serverVersion: '8.0.0', topology: 'standalone' },
      ],
      'PATCH connections/c1': () => [
        400,
        {
          code: 'VALIDATION_ERROR',
          message: 'Masked secrets cannot be reused for a different server; enter them again',
        },
      ],
    })
    mountApp(ConnectionDialog, { props: { connection: stored } })
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Edit connection')
    await section('Authentication')
    expect(byLabel('Password').value).toBe(SECRET_MASK)
    expect(document.body.textContent).toContain('The saved secret is kept')
    button('Test connection').click()
    await flushPromises()
    expect(calls.at(-1)!.body).toMatchObject({
      connectionId: 'c1',
      settings: { auth: { password: SECRET_MASK } },
    })
    await section('Server')
    await typeInto(byLabel('Host'), 'evil')
    save().click()
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: 'connections/c1' })
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Masked secrets cannot be reused')
  })

  it('duplicates without the stored secrets', async () => {
    const stored = dto({
      settings: { ...dto().settings, auth: { mechanism: 'DEFAULT', username: 'ada', password: SECRET_MASK } },
    })
    mountApp(ConnectionDialog, { props: { connection: stored, duplicate: true } })
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('Duplicate connection')
    expect(byLabel('Name').value).toBe('Local (copy)')
    await section('Authentication')
    expect(byLabel('Password').value).toBe('')
  })

  it('opens from the sidebar', async () => {
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
      'GET connections': () => [200, []],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    mountApp(WorkspaceView, { plugins: [router] })
    await flushPromises()
    button('Add connection').click()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('New connection'),
    )
  })
})

describe('TLS options that switch off server verification (audit minor)', () => {
  it('mark both as insecure and warn while either is on', async () => {
    mockApi({})
    mountApp(ConnectionDialog)
    await flushPromises()
    await section('TLS / SSL')
    await check(byLabel('Use TLS/SSL'))
    await flushPromises()
    expect(byLabel('Allow invalid host names (insecure)')).toBeTruthy()
    expect(byLabel('Allow invalid certificates (insecure)')).toBeTruthy()
    expect(document.body.textContent).not.toContain('does not verify the server')
    await check(byLabel('Allow invalid host names (insecure)'))
    await flushPromises()
    const warning = document.querySelector('[data-test="tls-insecure"]')!
    expect(warning.getAttribute('role')).toBe('alert')
    expect(warning.textContent).toContain('does not verify the server')
  })
})

/** W7, W8: what the server offers (GET connections/capabilities). */
const capabilities = (over: Record<string, unknown> = {}) => ({
  mode: 'local',
  distribution: 'npm',
  kerberos: { available: true, status: 'available', allowed: true },
  encryption: { available: true, status: 'available', serverCryptShared: false, ownCryptSharedPath: true },
  oidc: { workloadIdentity: true, redirectUri: 'http://localhost:4321/oidc/callback' },
  ...over,
})

describe('sign-in methods that never borrow the server’s own identity', () => {
  it('asks AWS for the connection’s keys', async () => {
    mockApi({ 'GET connections/capabilities': () => [200, capabilities()] })
    mountApp(ConnectionDialog)
    await flushPromises()
    await section('Authentication')
    const mechanism = byLabel<HTMLSelectElement>('Mechanism')
    await choose(mechanism, 'MONGODB-AWS')
    expect(byLabel('Access key ID')).toBeTruthy()
    expect(byLabel('Secret access key').getAttribute('type')).toBe('password')
    expect(document.body.textContent).toContain('AWS_SESSION_TOKEN')
  })

  // W8: Kerberos is offered with a strong warning; the server's state decides what is said.
  it('warns that Kerberos signs in as the server’s account, and sends its own fields only', async () => {
    const { calls } = mockApi({
      'GET connections/capabilities': () => [200, capabilities()],
      'POST connections/test': () => [200, { ok: false, error: { kind: 'auth', message: 'no' } }],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    await section('Authentication')
    await choose(byLabel<HTMLSelectElement>('Mechanism'), 'GSSAPI')
    expect(document.querySelector('[data-test="kerberos-warning"]')!.textContent).toContain(
      'computer account Mongo Manager runs as',
    )
    await typeInto(byLabel('Principal'), 'ana@CORP.EXAMPLE')
    await typeInto(byLabel('Service name'), 'mongodb')
    await choose(byLabel<HTMLSelectElement>('Canonicalize host name'), 'forward')
    await enterHost()
    button('Test connection').click()
    await flushPromises()
    const sent = calls.find((c) => c.path === 'connections/test')!.body as {
      settings: { auth: Record<string, unknown> }
    }
    expect(sent.settings.auth).toEqual({
      mechanism: 'GSSAPI',
      username: 'ana@CORP.EXAMPLE',
      kerberos: { serviceName: 'mongodb', canonicalizeHostName: 'forward' },
    })
  })

  it('says Kerberos is not in this package, or turned off in team mode', async () => {
    mockApi({
      'GET connections/capabilities': () => [
        200,
        capabilities({
          distribution: 'standalone',
          kerberos: { available: false, status: 'not_in_package', allowed: true },
        }),
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    await section('Authentication')
    await choose(byLabel<HTMLSelectElement>('Mechanism'), 'GSSAPI')
    expect(document.querySelector('[data-test="kerberos-unavailable"]')!.textContent).toContain(
      'not available in this package',
    )
  })

  // W7: OIDC asks for no password; a workload identity is said to be the machine's own.
  it('offers OIDC with its redirect address and allowed hosts, and warns about a workload identity', async () => {
    const { calls } = mockApi({
      'GET connections/capabilities': () => [200, capabilities()],
      'POST connections/test': () => [
        200,
        { ok: false, error: { kind: 'oidc', message: 'x', issuer: 'https://idp.example' } },
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    await section('Authentication')
    await choose(byLabel<HTMLSelectElement>('Mechanism'), 'MONGODB-OIDC')
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    expect(byLabel('Redirect address').getAttribute('placeholder')).toBe(
      'http://localhost:4321/oidc/callback',
    )
    await typeInto(byLabel('Allowed hosts'), 'db.corp.example, *.corp.example')
    expect(document.querySelector('[data-test="oidc-workload-warning"]')).toBeNull()
    await choose(byLabel<HTMLSelectElement>('Workload identity'), 'azure')
    expect(document.querySelector('[data-test="oidc-workload-warning"]')!.textContent).toContain(
      'cloud identity of the computer',
    )
    await choose(byLabel<HTMLSelectElement>('Workload identity'), '')
    await enterHost('db.corp.example')
    button('Test connection').click()
    await flushPromises()
    const sent = calls.find((c) => c.path === 'connections/test')!.body as {
      settings: { auth: Record<string, unknown> }
    }
    expect(sent.settings.auth).toEqual({
      mechanism: 'MONGODB-OIDC',
      oidc: { allowedHosts: ['db.corp.example', '*.corp.example'] },
    })
    expect(document.querySelector('[data-test="test-issuer"]')!.textContent).toContain('https://idp.example')
  })

  it('still shows Kerberos on a connection saved with it, to be changed', async () => {
    mockApi({})
    mountApp(ConnectionDialog, {
      props: {
        connection: dto({
          settings: { ...dto().settings, auth: { mechanism: 'GSSAPI', username: 'u@REALM' } },
        }),
      },
    })
    await flushPromises()
    await section('Authentication')
    expect(byLabel<HTMLSelectElement>('Mechanism').value).toBe('GSSAPI')
  })
})

// User report 2026-11-02: in Docker, localhost is Mongo Manager's own container, and the connection
// failed with ECONNREFUSED. The form says so where the host is typed, with a way out.
describe('a loopback host while Mongo Manager runs in Docker', () => {
  // User report 2026-11-02: a connection to localhost that works (--network host, or a MongoDB in
  // the container's own network) was told localhost is the container. Said only once it failed.
  it('says nothing for a connection to localhost that works, nor for one just typed', async () => {
    mockApi({ 'GET connections/capabilities': () => [200, capabilities({ distribution: 'docker' })] })
    mountApp(ConnectionDialog, { props: { connection: dto() } })
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Host').value).toBe('localhost')
    expect(document.querySelector('[data-docker-localhost]')).toBeNull()
    document.body.innerHTML = ''
    mountApp(ConnectionDialog)
    await flushPromises()
    await enterHost('localhost')
    await flushPromises()
    expect(document.querySelector('[data-docker-localhost]')).toBeNull()
  })

  it('explains, after a test that reached no server, that localhost is the container', async () => {
    mockApi({
      'GET connections/capabilities': () => [200, capabilities({ distribution: 'docker' })],
      'POST connections/test': () => [
        200,
        {
          ok: false,
          error: { kind: 'network', message: 'Could not reach the server: ECONNREFUSED ::1:27017' },
        },
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    await enterHost('localhost')
    button('Test connection').click()
    await flushPromises()
    const hint = document.querySelector('[data-docker-localhost]')!
    expect(hint.textContent).toContain('localhost is its own container')
    ;[...hint.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('host.docker.internal'))!
      .click()
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Host').value).toBe('host.docker.internal')
    expect(document.querySelector('[data-docker-localhost]')).toBeNull()
  })

  it('after a failed test of a pasted string, switches the string and the hosts it was read into', async () => {
    const { calls } = mockApi({
      'GET connections/capabilities': () => [200, capabilities({ distribution: 'docker' })],
      'POST connections/parse-uri': (body) => {
        const uri = (body as { uri: string }).uri
        const host = uri.includes('host.docker.internal') ? 'host.docker.internal' : 'localhost'
        return [
          200,
          {
            settings: {
              scheme: 'mongodb',
              hosts: [{ host, port: 27021 }],
              auth: { mechanism: 'none' },
              tls: TLS_OFF,
              options: {},
            },
          },
        ]
      },
      'POST connections/test': () => [
        200,
        {
          ok: false,
          error: { kind: 'network', message: 'Could not reach the server: ECONNREFUSED ::1:27021' },
        },
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    await typeInto(byLabel('Connection string'), 'mongodb://localhost:27021')
    byLabel('Connection string').dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
    button('Test connection').click()
    await flushPromises()
    const hint = document.querySelector('[data-docker-localhost]')!
    ;[...hint.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('host.docker.internal'))!
      .click()
    await flushPromises()
    expect(byLabel<HTMLInputElement>('Connection string').value).toBe('mongodb://host.docker.internal:27021')
    button('Test connection').click()
    await flushPromises()
    const tested = calls.findLast((c) => c.path === 'connections/test')!.body as {
      settings: ConnectionSettings
    }
    expect(tested.settings.hosts).toEqual([{ host: 'host.docker.internal', port: 27021 }])
  })

  // Review of 1.0.1 (M4): a sign-in refused means localhost reached a server (--network host).
  it('says nothing after a test whose server answered', async () => {
    mockApi({
      'GET connections/capabilities': () => [200, capabilities({ distribution: 'docker' })],
      'POST connections/parse-uri': () => [
        200,
        {
          settings: {
            scheme: 'mongodb',
            hosts: [{ host: 'localhost', port: 27021 }],
            auth: { mechanism: 'none' },
            tls: TLS_OFF,
            options: {},
          },
        },
      ],
      'POST connections/test': () => [
        200,
        { ok: false, error: { kind: 'auth', message: 'Authentication failed' } },
      ],
    })
    mountApp(ConnectionDialog)
    await flushPromises()
    await typeInto(byLabel('Connection string'), 'mongodb://localhost:27021')
    byLabel('Connection string').dispatchEvent(new FocusEvent('blur'))
    await flushPromises()
    button('Test connection').click()
    await flushPromises()
    expect(document.querySelector('[data-test="test-result"]')).not.toBeNull()
    expect(document.querySelector('[data-docker-localhost]')).toBeNull()
  })

  it('says nothing outside Docker, or for another host', async () => {
    mockApi({ 'GET connections/capabilities': () => [200, capabilities()] })
    mountApp(ConnectionDialog)
    await flushPromises()
    await enterHost('127.0.0.1')
    await flushPromises()
    expect(document.querySelector('[data-docker-localhost]')).toBeNull()
  })
})
