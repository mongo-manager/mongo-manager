import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { DashboardSchema, type IndexAdvice, type JobView, type Widget } from '@mongo-manager/shared/browser'
import NextActionsWidget from '../src/workspace/overview/widgets/NextActionsWidget.vue'
import { factsOf, stepKey, suggest, visible, type Signals } from '../src/workspace/overview/nextActions'
import { collectionPlace, databasePlace } from '../src/stores/places'
import { useJobsStore } from '../src/jobs/store'
import { useDashboardStore } from '../src/stores/dashboard'
import { usePlacesStore } from '../src/stores/places'
import { useTabsStore } from '../src/stores/tabs'
import { useSessionStore } from '../src/stores/session'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const NOW = Date.UTC(2026, 9, 16, 12)
const job = (id: string, state: JobView['state'], hoursAgo: number): JobView =>
  ({
    id,
    kind: 'export',
    connectionId: 'c1',
    db: 'shop',
    coll: 'orders',
    targetConnectionId: null,
    target: '',
    state,
    progress: null,
    estimate: null,
    error: 'secret error text',
    startedAt: NOW - hoursAgo * 3_600_000,
    finishedAt: NOW - hoursAgo * 3_600_000 + 1000,
    mine: true,
    cancellable: false,
  }) as unknown as JobView
const ADVICE: IndexAdvice = {
  suggestions: [
    {
      ns: 'shop.orders',
      key: [
        ['status', 1],
        ['at', -1],
      ],
      count: 12,
      totalMs: 5000,
      avgMs: 416,
      ratio: 900,
      reason: { equality: ['status'], sort: ['at'], range: [] },
    },
  ],
  unneeded: [],
  skipped: 0,
  refused: {},
} as unknown as IndexAdvice
const SIGNALS = (over: Partial<Signals> = {}): Signals => ({
  now: NOW,
  firing: [
    { id: 'al2', connectionId: 'c1' },
    { id: 'al1', connectionId: null },
  ],
  jobs: [job('j1', 'failed', 2), job('j2', 'failed', 5), job('j3', 'done', 1), job('old', 'failed', 72)],
  schedules: 1,
  liveSyncs: 0,
  recent: [
    collectionPlace('c1', 'shop', 'orders'),
    collectionPlace('c1', 'shop', 'users'),
    databasePlace('c1', 'shop'),
  ],
  open: new Set([collectionPlace('c1', 'shop', 'orders').key]),
  advice: { connectionId: 'c1', db: 'shop', advice: ADVICE, canCreate: true },
  ...over,
})

describe('the next steps, worked out without AI (completion W6.2)', () => {
  it('ranks what needs a person first, then index advice, slow queries and places to go back to', () => {
    const list = suggest(SIGNALS())
    expect(list.map((s) => s.kind)).toEqual([
      'alerts',
      'failedJobs',
      'schedules',
      'createIndex',
      'slowQueries',
      'continue',
      'continue',
    ])
    expect(list.find((s) => s.kind === 'failedJobs')).toMatchObject({
      facts: { count: 2 },
      target: { to: 'jobs', jobId: 'j1' },
    })
    expect(list.find((s) => s.kind === 'alerts')!.key).toBe(stepKey('alerts', 'al1,al2'))
    expect(list.find((s) => s.kind === 'createIndex')).toMatchObject({
      facts: { connectionId: 'c1', db: 'shop', coll: 'orders', fields: ['status', 'at'], count: 12 },
    })
    // A place already open in a tab is not suggested again.
    expect(list.filter((s) => s.kind === 'continue').map((s) => s.facts.coll ?? s.facts.db)).toEqual([
      'users',
      'shop',
    ])
    // Facts are names and counts: never an error text or a value.
    expect(JSON.stringify(list.map((s) => s.facts))).not.toContain('secret')
  })

  // Review I2: eight alerts' ids, or a 250-character namespace, made a key the dashboard refused.
  it('keys every step with a short, fixed-length hash, so a dismissal always saves', () => {
    const long = 'n'.repeat(250)
    const many = Array.from({ length: 8 }, () => ({ id: crypto.randomUUID(), connectionId: 'c1' }))
    const steps = suggest(
      SIGNALS({
        firing: many,
        recent: [collectionPlace('c1', long, long)],
        open: new Set(),
        advice: {
          connectionId: 'c1',
          db: long,
          advice: { ...ADVICE, suggestions: [{ ...ADVICE.suggestions[0]!, ns: `${long}.${long}` }] },
          canCreate: true,
        } as Signals['advice'],
      }),
    )
    for (const s of steps) expect(s.key.length, s.key).toBeLessThanOrEqual(40)
    expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length)
    // The same event keeps its key; another gets another.
    const again = suggest(SIGNALS({ firing: many }))
    expect(again.find((s) => s.kind === 'alerts')!.key).toBe(steps.find((s) => s.kind === 'alerts')!.key)
    expect(suggest(SIGNALS({ firing: many.slice(1) })).find((s) => s.kind === 'alerts')!.key).not.toBe(
      again.find((s) => s.kind === 'alerts')!.key,
    )
    const settings = { dismissed: steps.map((s) => s.key) }
    expect(
      DashboardSchema.safeParse({
        version: 1,
        widgets: [{ id: '00000000-0000-4000-8000-0000000000aa', type: 'nextActions', size: 'm', settings }],
      }).success,
    ).toBe(true)
  })

  it('shows at most five, leaving out the dismissed; a new event comes back under a new key', () => {
    const list = suggest(SIGNALS())
    const keys = list.map((s) => s.key)
    expect(visible(list, [])).toHaveLength(5)
    expect(visible(list, [keys[0]!, keys[1]!]).map((s) => s.kind)).toEqual([
      'schedules',
      'createIndex',
      'slowQueries',
      'continue',
      'continue',
    ])
    const later = suggest(SIGNALS({ jobs: [job('j9', 'failed', 0.1)] }))
    expect(visible(later, keys).some((s) => s.kind === 'failedJobs')).toBe(true)
    expect(suggest(SIGNALS({ firing: [], jobs: [], schedules: 0, recent: [], advice: null }))).toEqual([])
  })

  it('gives the AI ids, kinds, names and counts only', () => {
    const facts = factsOf(visible(suggest(SIGNALS()), []))
    expect(facts.map((f) => f.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
    for (const f of facts)
      expect(
        Object.keys(f).every((k) =>
          ['id', 'kind', 'connectionId', 'db', 'coll', 'fields', 'count'].includes(k),
        ),
      ).toBe(true)
  })
})

const CONNECTION = {
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  access: 'admin',
  permissions: ['server:monitor', 'databases:read', 'documents:read', 'indexes:write', 'ai:use'],
  aiPolicy: 'any',
}
const WIDGET = (settings: object = {}): Widget =>
  ({ id: '00000000-0000-4000-8000-0000000000aa', type: 'nextActions', size: 'm', settings }) as Widget

function api(
  over: Record<string, Parameters<typeof mockApi>[0][string]> = {},
  ai = false,
  permissions = CONNECTION.permissions,
) {
  return mockApi({
    'GET connections': () => [200, [{ ...CONNECTION, permissions }]],
    'GET alerts/active': () => [
      200,
      [
        { id: 'al1', connectionId: 'c1', state: 'firing' },
        { id: 'al0', connectionId: 'c1', state: 'resolved' },
      ],
    ],
    'GET backup-schedules': () => [200, { schedules: [] }],
    'GET live-syncs': () => [200, { syncs: [] }],
    'GET connections/c1/server/index-advice': () => [200, ADVICE],
    'GET ai/status': () => [
      200,
      { enabled: ai, providers: ai ? [{ id: 'p1', name: 'Claude', model: 'm' }] : [] },
    ],
    'GET me/dashboard': () => [200, { dashboard: { version: 1, widgets: [WIDGET()] } }],
    'PUT me/dashboard': (body) => [200, { dashboard: body }],
    ...over,
  })
}

async function mountWidget(settings: object = {}) {
  // Signed in: the bell's alerts are read for the signed-in only.
  useSessionStore().status = { mode: 'team', setupRequired: false, authenticated: true } as never
  const places = usePlacesStore()
  places.bindUser('u1')
  places.visit(databasePlace('c1', 'shop'))
  places.visit(collectionPlace('c1', 'shop', 'users'))
  useJobsStore().replaceAll([job('j1', 'failed', 1)])
  const store = useDashboardStore()
  await store.load('u1')
  store.configure(WIDGET().id, settings)
  mountApp(NextActionsWidget, { props: { widget: store.widgets.find((w) => w.type === 'nextActions')! } })
  await flushPromises()
  await flushPromises()
  return store
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-next-action]')]

describe('the Next steps widget', () => {
  it('lists the steps as links that do them, and works with no AI set up', async () => {
    api()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    await mountWidget()
    expect(rows().map((r) => r.dataset.nextAction)).toEqual([
      'alerts',
      'failedJobs',
      'createIndex',
      'slowQueries',
      'continue',
    ])
    expect(rows()[2]!.textContent).toContain('Create an index on orders')
    expect(document.body.textContent).not.toContain('Order with AI')
    rows()[0]!.querySelector<HTMLButtonElement>('button[data-do]')!.click()
    await flushPromises()
    expect(useTabsStore().active?.kind).toBe('alerts')
    rows()
      .find((r) => r.dataset.nextAction === 'slowQueries')!
      .querySelector<HTMLButtonElement>('button[data-do]')!
      .click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({ kind: 'connection', params: { connectionId: 'c1' } })
  })

  it('remembers a dismissal with the dashboard', async () => {
    const { calls } = api()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = await mountWidget()
    const first = rows()[0]!
    first.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click()
    await flushPromises()
    expect(rows().map((r) => r.dataset.nextAction)).not.toContain('alerts')
    const settings = store.widgets.find((w) => w.type === 'nextActions')!.settings as { dismissed?: string[] }
    expect(settings.dismissed).toEqual([stepKey('alerts', 'al1')])
    await store.flush()
    expect(
      calls.some((c) => c.method === 'PUT' && JSON.stringify(c.body).includes(stepKey('alerts', 'al1'))),
    ).toBe(true)
  })

  it('asks the AI for an order only when turned on, sending facts only, and falls back on failure', async () => {
    let sent: unknown = null
    const { calls } = api(
      {
        'POST me/next-actions/rank': (body) => {
          sent = body
          return [
            200,
            {
              order: ['a2', 'a0'],
              titles: { a2: 'Speed up orders with an index' },
              withheld: [],
              provider: { name: 'Claude', model: 'm' },
            },
          ]
        },
      },
      true,
    )
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    await mountWidget()
    expect(calls.some((c) => c.path === 'me/next-actions/rank')).toBe(false)
    // Turned on from the widget's menu: saved with the widget.
    const menu = document.querySelector<HTMLButtonElement>('[data-next-actions-menu] button')!
    menu.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Order with AI'))!
      .click()
    await flushPromises()
    await flushPromises()
    expect(sent).toMatchObject({ language: 'en' })
    expect(JSON.stringify(sent)).not.toContain('secret')
    expect(
      rows()
        .map((r) => r.dataset.nextAction)
        .slice(0, 2),
    ).toEqual(['createIndex', 'alerts'])
    expect(rows()[0]!.textContent).toContain('Speed up orders with an index')
    // Review minor 4: the AI's words never stand alone — what the step does is said beside them.
    expect(rows()[0]!.textContent).toContain('Create an index on orders (status, at)')
    expect(document.body.textContent).toContain('Ordered by Claude')

    // Review minor 2: counts changing (a new failure) ask nothing again; "Reorder" does.
    const asked = () => calls.filter((c) => c.path === 'me/next-actions/rank').length
    expect(asked()).toBe(1)
    useJobsStore().upsert(job('j7', 'failed', 0.5))
    await flushPromises()
    expect(rows().length).toBeGreaterThan(0)
    expect(asked()).toBe(1)
    document.querySelector<HTMLButtonElement>('[data-next-actions-menu] button')!.click()
    await flushPromises()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((m) => m.textContent?.includes('Reorder with AI'))!
      .click()
    await flushPromises()
    expect(asked()).toBe(2)
  })

  // Review minor 3: a Create index step only for who may create one.
  it('suggests creating an index only to someone who may write indexes there', async () => {
    api({}, false, ['server:monitor', 'databases:read', 'documents:read'])
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    await mountWidget()
    const kinds = rows().map((r) => r.dataset.nextAction)
    expect(kinds).not.toContain('createIndex')
    expect(kinds).toContain('slowQueries')
  })

  // Review minor 5: Undo takes back the dismissal only, never another change made since.
  it('undoes a dismissal without undoing anything else', async () => {
    api({}, true)
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = await mountWidget()
    rows()[0]!.querySelector<HTMLButtonElement>('button[data-dismiss]')!.click()
    await flushPromises()
    const id = WIDGET().id
    store.configure(id, { ...(store.widgets.find((w) => w.id === id)!.settings as object), ai: true })
    const toasts = useToastStore()
    const toast = toasts.toasts.at(-1)!
    toasts.runAction(toast.id, 0)
    await flushPromises()
    expect(store.widgets.find((w) => w.id === id)!.settings).toEqual({ ai: true, dismissed: [] })
  })

  it('keeps its own order when the AI fails, and says so', async () => {
    api(
      {
        'POST me/next-actions/rank': () => [
          502,
          { code: 'UPSTREAM_ERROR', message: 'x', details: { reason: 'rate_limited' } },
        ],
      },
      true,
    )
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    await mountWidget({ ai: true })
    expect(rows()[0]!.dataset.nextAction).toBe('alerts')
    expect(document.querySelector('[data-next-actions-ai]')!.textContent).toContain('could not order')
  })
})
