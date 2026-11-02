import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type {
  AiAgentStep,
  AiChatLine,
  AiChatTurnRecord,
  AiChatView,
  AiStatus,
  JobView,
} from '@mongo-manager/shared'
import AssistantPanel from '../src/ai/chat/AssistantPanel.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { confirmGuard } from '../src/ds/confirmGuard'
import { useAssistantStore, storedSteps } from '../src/ai/chat/store'
import { useTabsStore } from '../src/stores/tabs'
import { openCollectionTab } from '../src/workspace/openTabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { useDialogStore } from '../src/stores/dialogs'
import { useJobsStore } from '../src/jobs/store'
import { useSessionStore } from '../src/stores/session'
import { useOidcSignInStore } from '../src/stores/oidcSignIn'
import { withoutAgentLine } from '../src/ai/chat/store'
import { connectionReason } from '../src/ai/chat/agentWords'

/** Every kind a connection's failure has (the server's ConnectionErrorKind, and a busy pool). */
const CONNECTION_KINDS = [
  'auth',
  'network',
  'dns',
  'tls',
  'timeout',
  'ssh',
  'ssh-host-key',
  'dependency',
  'config',
  'busy',
  'unsupported',
  'oidc',
  'encryption',
  'closed',
  'unknown',
  'pool',
]
import { i18n } from '../src/i18n'
import { mockApi, mountApp, type Handler } from './support/app'
import { byLabel, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  confirmGuard.armMs = 0
  document.body.innerHTML = ''
})

const STATUS = (samples = true): AiStatus => ({
  enabled: true,
  allowServerJs: false,
  providers: [{ id: 'p1', name: 'Local', kind: 'openai', model: 'm', local: true, samples, isDefault: true }],
  limits: { perMinute: 10, perDay: 200, perUser: 2, concurrent: 8 },
  chat: { days: 30, chats: 50, messages: 200 },
})
const CONN = {
  id: 'c1',
  name: 'Sales Mongo',
  aiPolicy: 'any',
  permissions: ['documents:read', 'ai:use'],
  settings: { hosts: [] },
}

const step = (over: Partial<AiAgentStep>): AiAgentStep => ({
  id: '1.1',
  tool: 'create_collection',
  kind: 'write',
  place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'users' },
  state: 'awaiting',
  ...over,
})
const CREATE = step({
  proposal: {
    payload: { kind: 'collection', name: 'users' },
    preview: { databaseExists: false, exists: false },
  },
})
const DROP = step({
  id: '1.2',
  tool: 'drop_collection',
  proposal: {
    payload: { drop: 'sales.users' },
    preview: { documents: 3 },
    typed: 'users',
    destructive: true,
  },
})

/** The panel in agent mode beside a collection tab; `lines` start the turn's stream, `push` adds more. */
async function agentPanel(
  opts: { on?: boolean; lines?: AiChatLine[]; handlers?: Record<string, Handler>; samples?: boolean } = {},
) {
  let on = opts.on ?? true
  const api = mockApi({
    'GET ai/status': () => [200, STATUS(opts.samples ?? true)],
    'GET connections': () => [200, [CONN]],
    'GET ai/chats': () => [200, []],
    'GET me/ai-agent': () => [200, { on, available: true }],
    'PUT me/ai-agent': (body) => {
      on = (body as { on: boolean }).on
      return [200, { on, available: true }]
    },
    ...opts.handlers,
  })
  const bodies: unknown[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const enc = new TextEncoder()
  /** A few turns of the event loop: the stream's reader lets the browser paint between chunks. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5)
      else await new Promise((r) => setTimeout(r, 0))
      await flushPromises()
    }
    await nextTick()
  }
  const push = async (lines: AiChatLine[]) => {
    // The turn's request is made a few ticks after Enter: its stream must be open before lines go.
    for (let i = 0; i < 50 && !controller; i++) await settle()
    controller!.enqueue(enc.encode(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'))
    await settle()
  }
  const fallback = api.fetchMock.getMockImplementation()!
  api.fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!String(input).endsWith('/ai/agent')) return fallback(input, init)
    bodies.push(JSON.parse(String(init.body)))
    return new Response(
      new ReadableStream({
        start(c) {
          controller = c
          c.enqueue(enc.encode((opts.lines ?? []).map((l) => JSON.stringify(l)).join('\n') + '\n'))
        },
      }),
    )
  })
  const tabs = useTabsStore()
  tabs.open({
    kind: 'collection',
    title: 'shop.orders',
    params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
  })
  const store = useAssistantStore()
  store.show()
  const { queryClient } = mountApp(AssistantPanel)
  mountApp(ToastHost)
  await flushPromises()
  /** The turn's stream ends (the store then reads the chat back). */
  const end = async () => {
    controller!.close()
    await settle()
  }
  return { ...api, bodies, push, end, store, tabs, queryClient }
}
const composer = () => byLabel<HTMLTextAreaElement>('Message the assistant')
const enter = (el: HTMLElement) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
const START: AiChatLine[] = [
  { type: 'chat', id: 'ch1', title: 'add users', turn: 'u1', run: '11111111-1111-4111-8111-111111111111' },
  {
    type: 'context',
    sent: null,
    provider: { id: 'p1', name: 'Local', model: 'm', kind: 'openai' },
    history: { sent: 0, leftOut: [] },
    agent: {
      connections: [
        {
          name: 'Sales Mongo',
          access: 'admin',
          readOnly: false,
          policy: 'any',
          writes: true,
          defaultDatabase: 'sales',
        },
      ],
      documents: false,
    },
  },
]
const card = () => document.querySelector<HTMLElement>('[data-agent-card]')
const cardButton = (which: 'confirm' | 'decline') =>
  document.querySelector<HTMLButtonElement>(`[data-agent-card] [data-agent-${which}]`)!
const RUN = '11111111-1111-4111-8111-111111111111'

describe('agent mode in the assistant panel (W6.3 §5, §6)', () => {
  it('offers the person’s own switch and keeps it on the server', async () => {
    const { calls } = await agentPanel({ on: false })
    const toggle = document.querySelector<HTMLInputElement>('[data-agent-mode] input[role="switch"]')!
    expect(toggle.checked).toBe(false)
    expect(document.querySelector('[data-agent-context]')).toBeNull()
    toggle.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT' && c.path === 'me/ai-agent')!.body).toEqual({ on: true })
    expect(document.querySelector('[data-agent-context]')).not.toBeNull()
    // UI review of wave B: said on the switch's tooltip, the window kept for the conversation.
    expect(document.querySelector('[data-agent-mode]')!.getAttribute('title')).toContain(
      'Every change waits for your confirmation',
    )
  })

  it('sends an agent turn naming the tab in view; documents only when allowed for this message', async () => {
    const { bodies } = await agentPanel({ lines: [] })
    expect(document.body.textContent).toContain('Looking at shop.orders on Sales Mongo')
    await typeInto(composer(), 'add a users collection on Sales Mongo')
    enter(composer())
    await flushPromises()
    expect(bodies[0]).toMatchObject({
      message: 'add a users collection on Sales Mongo',
      language: 'en',
      provider: 'p1',
      documents: false,
      focus: { connectionId: 'c1', db: 'shop', coll: 'orders' },
      // Design 2026-10-25 (A4): the browser's time zone, for the times the person gives.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  // A4: a schedule's card says what it keeps; a schedule refused for want of a destination offers
  // the destinations page; every schedule refusal has its words.
  it('says what a schedule keeps and in which zone, and opens the destinations for an administrator', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    useSessionStore().me = { permissions: ['settings:manage'] } as never
    await typeInto(composer(), 'haftalık yedek kur')
    enter(composer())
    await flushPromises()
    const schedule = (over: Partial<AiAgentStep>) =>
      step({
        id: '1.4',
        tool: 'create_backup_schedule',
        place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
        ...over,
      })
    await push([
      {
        type: 'step',
        step: schedule({
          proposal: {
            payload: { name: 'Weekly' },
            preview: {
              words: 'Every Monday at 03:00',
              retention: { last: 7, daily: 30, weekly: 0, monthly: 0 },
              nextRuns: [Date.UTC(2026, 10, 2, 18, 0)],
              timeZone: 'Asia/Tokyo',
            },
          },
        }),
      },
    ])
    // Review of A4 (M4): no "0 weekly"; (M2): the next runs in the schedule's own zone, named.
    expect(card()!.textContent).toContain('Keeps the last 7 and 30 daily backups.')
    expect(card()!.textContent).not.toContain('0 weekly')
    expect(card()!.textContent).toContain('GMT+9')
    // 18:00 UTC is 03:00 in Tokyo: the time itself in the schedule's zone.
    expect(card()!.textContent).toContain('03:00')
    await push([{ type: 'step', step: schedule({ state: 'refused', reason: 'no_destination' }) }])
    document
      .querySelector<HTMLButtonElement>(
        '[data-agent-step="create_backup_schedule"] [data-agent-destinations]',
      )!
      .click()
    await flushPromises()
    expect(tabs.active?.kind).toBe('destinations')
    for (const lang of ['en', 'tr'] as const)
      for (const reason of [
        'key_required',
        'schedule_limit',
        'schedules_off',
        'no_destination',
        'destination_needed',
        'encrypted_only',
        'personal_plain',
        'cadence_cron',
        'cadence_never',
        'cadence_min_gap',
      ])
        expect(i18n.global.te(`ai.agent.reason.${reason}`, lang)).toBe(true)
  })

  // Review of A4 (I3): the destinations page is an administrator's — another person is told whom to ask.
  it('offers no destinations page to someone who may not open it', async () => {
    const { push } = await agentPanel({ lines: START })
    useSessionStore().me = { permissions: [] } as never
    await typeInto(composer(), 'haftalık yedek kur')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          id: '1.4',
          tool: 'create_backup_schedule',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
          state: 'refused',
          reason: 'no_destination',
        }),
      },
    ])
    const here = document.querySelector('[data-agent-step="create_backup_schedule"]')!
    expect(here.querySelector('[data-agent-destinations]')).toBeNull()
    expect(here.textContent).toContain('Ask an administrator')
  })

  it('cannot allow documents when the provider may not receive them, and says why', async () => {
    await agentPanel({ samples: false })
    const chip = document.querySelector<HTMLButtonElement>('[data-agent-documents]')!
    expect(chip.disabled).toBe(true)
    expect(document.body.textContent).toContain('This provider may not receive sample documents')
  })

  it('lists steps as they run and shows a change as a card: where, exactly what, the preview', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'add users')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          id: '0.1',
          tool: 'list_databases',
          kind: 'read',
          place: { connectionId: 'c1', connection: 'Sales Mongo' },
          state: 'running',
        }),
      },
    ])
    expect(document.querySelector('[data-agent-step="list_databases"]')!.textContent).toContain('Working…')
    await push([
      {
        type: 'step',
        step: step({
          id: '0.1',
          tool: 'list_databases',
          kind: 'read',
          place: { connectionId: 'c1', connection: 'Sales Mongo' },
          state: 'done',
          sent: 'names',
          summary: { databases: 2 },
        }),
      },
      { type: 'step', step: CREATE },
    ])
    const steps = document.querySelector('[data-agent-step="list_databases"]')!.textContent!
    expect(steps).toContain('2 databases')
    expect(steps).toContain('Sent: names only')
    const c = card()!
    expect(c.textContent).toContain('Create a collection')
    expect(c.textContent).toContain('Sales Mongo · sales.users')
    expect(c.textContent).toContain('The database sales is new')
    expect(c.textContent).toContain('"name": "users"')
    expect(document.body.textContent).toContain('A change is waiting for your confirmation.')
  })

  it('confirms once through the run, and the step then says what was done', async () => {
    const decided: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'done', summary: { created: 'sales.users' } }]
        },
      },
    })
    await typeInto(composer(), 'add users')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: CREATE }])
    cardButton('confirm').click()
    cardButton('confirm').click()
    await flushPromises()
    expect(decided).toEqual([{ call: '1.1', decision: 'confirm' }])
    await push([
      { type: 'step', step: step({ state: 'done', sent: 'outcome', summary: { created: 'sales.users' } }) },
    ])
    expect(card()).toBeNull()
    expect(document.querySelector('[data-agent-step="create_collection"]')!.textContent).toContain(
      'Created sales.users',
    )
  })

  it('a destructive change waits for its name typed; Decline answers at once', async () => {
    const decided: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'declined' }]
        },
      },
    })
    await typeInto(composer(), 'drop users')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: DROP }])
    expect(card()!.textContent).toContain('It holds 3 documents, lost for good.')
    expect(cardButton('confirm').disabled).toBe(true)
    const typed = document.querySelector<HTMLInputElement>(
      '[data-agent-card] [data-agent-typed] input, [data-agent-card] input[data-agent-typed]',
    )
    await typeInto(typed!, 'user')
    expect(cardButton('confirm').disabled).toBe(true)
    await typeInto(typed!, 'users')
    expect(cardButton('confirm').disabled).toBe(false)
    cardButton('decline').click()
    await flushPromises()
    expect(decided).toEqual([{ call: '1.2', decision: 'decline' }])
  })

  it('keeps Confirm from being pressed until the app’s moment passed (no double click into it)', async () => {
    confirmGuard.armMs = 600
    vi.useFakeTimers()
    const decided: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'done', summary: {} }]
        },
      },
    })
    await typeInto(composer(), 'add users')
    enter(composer())
    await vi.runOnlyPendingTimersAsync()
    await push([{ type: 'step', step: CREATE }])
    expect(cardButton('confirm').disabled).toBe(true)
    cardButton('confirm').click()
    await flushPromises()
    expect(decided).toEqual([])
    await vi.advanceTimersByTimeAsync(700)
    expect(cardButton('confirm').disabled).toBe(false)
    cardButton('confirm').click()
    await flushPromises()
    expect(decided).toHaveLength(1)
  })

  it('says a refused answer in words and lets the person answer again', async () => {
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: () => [
          400,
          { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'typed_name' } },
        ],
      },
    })
    await typeInto(composer(), 'drop users')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: DROP }])
    const typed = document.querySelector<HTMLInputElement>('[data-agent-card] input')!
    await typeInto(typed, 'users')
    cardButton('confirm').click()
    await flushPromises()
    expect(card()!.textContent).toContain('Type the name exactly to confirm.')
    expect(cardButton('decline').disabled).toBe(false)
  })

  // The AI database manager (design 2026-10-25, A3): a backup's card says when the kept copy goes and
  // where it is sent, asks its password as the app's backup dialog does, and the job opens from its step.
  it('asks a backup’s password twice, says its expiry and destinations, and opens its job', async () => {
    const BACKUP = step({
      id: '1.3',
      tool: 'run_backup',
      place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
      proposal: {
        payload: { scope: { kind: 'database', db: 'sales' }, format: 'mmbak' },
        preview: {
          namespaces: 2,
          format: 'mmbak',
          expiresInHours: 24,
          destinations: ['Archive S3'],
          deleteLocal: true,
        },
        password: true,
      },
    })
    const { push, tabs } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: () => [
          200,
          { state: 'done', summary: { started: true, job: 'j1' } },
        ],
      },
    })
    await typeInto(composer(), 'demo db’sini yedekle')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: BACKUP }])
    expect(card()!.textContent).toContain('removed after 24 hours')
    expect(card()!.textContent).toContain('Archive S3')
    const inputs = card()!.querySelectorAll<HTMLInputElement>('input[type="password"]')
    expect(inputs).toHaveLength(2)
    // Review of A3 (minor 16): the hint read with the fields, the length the shared one.
    const fields = card()!.querySelector('[data-agent-password]')!
    expect(document.getElementById(fields.getAttribute('aria-describedby')!)!.textContent).toContain('12')
    await typeInto(inputs[0]!, 'correct-horse-battery-1')
    await typeInto(inputs[1]!, 'correct-horse-battery-2')
    expect(cardButton('confirm').disabled).toBe(true)
    await typeInto(inputs[1]!, 'correct-horse-battery-1')
    await push([
      {
        type: 'step',
        step: { ...BACKUP, state: 'done', summary: { started: true, job: 'j1' }, proposal: undefined },
      },
    ])
    document.querySelector<HTMLButtonElement>('[data-agent-step="run_backup"] [data-agent-job]')!.click()
    await flushPromises()
    expect(tabs.active?.kind).toBe('jobs')
    // Review of A3 (I6): the job itself, opened with its details.
    expect(useJobsStore().focused).toBe('j1')
  })

  // The AI database manager (design 2026-10-25, A5): a connection checked — said in words, the app
  // shown it connected, and a sign-in offered where the person must sign in.
  it('says a connection was checked, shows it connected in the app, and offers the sign-in it needs', async () => {
    const oidc = (id: string, name: string, environment?: string) => ({
      ...CONN,
      id,
      name,
      settings: { hosts: [], auth: { mechanism: 'MONGODB-OIDC', oidc: environment ? { environment } : {} } },
    })
    const { push, calls, queryClient } = await agentPanel({
      lines: START,
      handlers: {
        'GET connections': () => [200, [CONN, oidc('c2', 'Sso'), oidc('c3', 'Workload', 'azure')]],
        'GET connections/c1/databases': () => [200, { databases: [] }],
      },
    })
    await typeInto(composer(), 'is Sales Mongo up?')
    enter(composer())
    await flushPromises()
    const reads = () =>
      calls.filter((c) => c.method === 'GET' && c.path === 'connections/c1/databases').length
    const at = (connectionId: string, connection: string) => ({ connectionId, connection })
    const check = (id: string, place: AiAgentStep['place'], summary: AiAgentStep['summary']) =>
      push([
        {
          type: 'step',
          step: step({ id, tool: 'check_connection', kind: 'read', place, state: 'done', summary }),
        },
      ])
    // As the sidebar holds it for a connection not expanded (re-review of A5, W1): pending, never read.
    queryClient.getQueryCache().build(queryClient, { queryKey: ['connections', 'c1', 'databases'] })
    expect(queryClient.getQueryState(['connections', 'c1', 'databases'])?.status).toBe('pending')
    const before = reads()
    // Not reached: the app is not asked to read it again.
    await check('1.5', at('c1', 'Sales Mongo'), { connected: false, problem: 'network' })
    await flushPromises()
    expect(reads()).toBe(before)
    expect(document.querySelector('[data-agent-step="check_connection"]')!.textContent).toContain(
      'the server does not answer',
    )
    await check('1.6', at('c1', 'Sales Mongo'), { connected: true })
    await vi.waitFor(() => expect(reads()).toBe(before + 1))
    expect(document.querySelectorAll('[data-agent-step="check_connection"]')[1]!.textContent).toContain(
      'Connected',
    )
    // Steps that never opened it (a job, the backups, the list) ask nothing (re-review, M-b).
    queryClient.removeQueries({ queryKey: ['connections', 'c1', 'databases'], exact: true })
    for (const [n, tool] of (
      ['get_job', 'list_jobs', 'list_backups', 'run_backup', 'create_backup_schedule'] as const
    ).entries())
      await push([
        {
          type: 'step',
          step: step({
            id: `2.${n}`,
            tool,
            kind: 'read',
            place: at('c1', 'Sales Mongo'),
            state: 'done',
            summary: {},
          }),
        },
      ])
    await flushPromises()
    expect(reads()).toBe(before + 1)
    // A read there opened it: the app's view is read again where it has none.
    await push([
      {
        type: 'step',
        step: step({
          id: '1.65',
          tool: 'count_documents',
          kind: 'read',
          place: at('c1', 'Sales Mongo'),
          state: 'done',
          summary: { documents: 2 },
        }),
      },
    ])
    await vi.waitFor(() => expect(reads()).toBe(before + 2))
    // A later read there, with the app's view already answered, asks nothing again.
    await push([
      {
        type: 'step',
        step: step({
          id: '1.7',
          tool: 'list_databases',
          kind: 'read',
          place: at('c1', 'Sales Mongo'),
          state: 'done',
          summary: { databases: 2 },
        }),
      },
    ])
    await flushPromises()
    expect(reads()).toBe(before + 2)
    // A sign-in the person can make is offered; a workload's identity has no one to sign in (M5).
    const request = vi.spyOn(useOidcSignInStore(), 'request')
    await check('1.8', at('c2', 'Sso'), { connected: false, problem: 'oidc' })
    await check('1.9', at('c3', 'Workload'), { connected: false, problem: 'oidc' })
    const [, , sso, workload] = document.querySelectorAll('[data-agent-step="check_connection"]')
    expect(sso!.textContent).toContain('sign in')
    expect(workload!.querySelector('[data-agent-sign-in]')).toBeNull()
    sso!.querySelector<HTMLButtonElement>('[data-agent-sign-in]')!.click()
    expect(request).toHaveBeenCalledWith('c2')
    // Every kind worded in both languages, and the agent's own refusal keeps its words (review, I1).
    for (const lang of ['en', 'tr'] as const)
      for (const kind of CONNECTION_KINDS)
        expect(i18n.global.te(`ai.agent.reason.${connectionReason(kind)}`, lang)).toBe(true)
    expect(i18n.global.t('ai.agent.reason.connection_unknown', {}, { locale: 'en' })).toContain('may not use')
  })

  // The AI database manager (design 2026-10-25, B1): the person's schedules — listed, changed on cards
  // that say the backups a change removes now, each step said in words and opening the Schedules page.
  it('says what it did to a schedule, the backups a change removes on its card, and opens Schedules', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    await typeInto(composer(), 'keep less of Weekly')
    enter(composer())
    await flushPromises()
    const at = { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' }
    await push([
      {
        type: 'step',
        step: step({
          id: '1.1',
          tool: 'list_schedules',
          kind: 'read',
          place: null,
          state: 'done',
          summary: { schedules: 2 },
        }),
      },
      {
        type: 'step',
        step: step({
          id: '1.2',
          tool: 'update_schedule',
          kind: 'write',
          place: at,
          state: 'awaiting',
          proposal: {
            payload: { updateSchedule: 'Weekly', retention: { last: 7, daily: 30, weekly: 0, monthly: 0 } },
            preview: { removals: 23, retention: { last: 7, daily: 30, weekly: 0, monthly: 0 } },
          },
        }),
      },
    ])
    const listed = document.querySelector('[data-agent-step="list_schedules"]')!
    expect(listed.textContent).toContain('List schedules')
    expect(listed.textContent).toContain('2 schedules')
    const card = document.querySelector('[data-agent-card]')!
    expect(card.textContent).toContain('Change a schedule')
    expect(card.textContent).toContain('23 backups will be removed now')
    await push([
      {
        type: 'step',
        step: step({
          id: '1.2',
          tool: 'update_schedule',
          kind: 'write',
          place: at,
          state: 'done',
          summary: { schedule: 'Weekly', did: 'updated' },
        }),
      },
    ])
    const changed = document.querySelector('[data-agent-step="update_schedule"]')!
    expect(changed.textContent).toContain('Changed the schedule Weekly')
    changed.querySelector<HTMLButtonElement>('[data-agent-schedules]')!.click()
    expect(tabs.active).toMatchObject({ kind: 'schedules' })
    for (const lang of ['en', 'tr'] as const) {
      for (const tool of [
        'list_schedules',
        'run_schedule',
        'pause_schedule',
        'resume_schedule',
        'update_schedule',
        'delete_schedule',
      ])
        expect(i18n.global.te(`ai.agent.tool.${tool}`, lang)).toBe(true)
      for (const did of ['started', 'paused', 'resumed', 'updated', 'deleted'])
        expect(i18n.global.te(`ai.agent.summary.schedule.${did}`, lang)).toBe(true)
      for (const reason of ['schedule_unknown', 'schedule_paused', 'schedule_active', 'paused_by_admin'])
        expect(i18n.global.te(`ai.agent.reason.${reason}`, lang)).toBe(true)
    }
  })

  // The AI database manager (design 2026-10-25, B2): a restore on its card — the target typed, what it
  // overwrites said, and an encrypted backup's password asked once, as the backup was made.
  it('restores on a card that says what it overwrites, the backup’s password asked once', async () => {
    const { push, bodies } = await agentPanel({
      lines: START,
      handlers: {
        'POST ai/agent/runs/run1/decide': () => [200, { state: 'done', summary: { started: true } }],
      },
    })
    await typeInto(composer(), 'restore last night')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          id: '1.1',
          tool: 'restore_backup',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
          state: 'awaiting',
          proposal: {
            payload: { restore: 'sales-2026-10-25', into: 'sales', mode: 'replace' },
            preview: {
              namespaces: 3,
              existing: 2,
              lost: 120,
              lostUnknown: true,
              skipped: 1,
              warnings: ['capped', 'source'],
              capped: ['sales.events'],
              from: 'Prod',
              made: Date.UTC(2026, 9, 25, 3, 0, 5),
            },
            typed: 'sales',
            destructive: true,
            password: true,
            opening: true,
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('Restore a backup')
    expect(card.textContent).toContain('3 collections are restored')
    expect(card.textContent).toContain('2 of them are there already')
    expect(card.textContent).toContain('120 documents are overwritten')
    expect(card.textContent).toContain('whose count is not known')
    expect(card.textContent).toContain('1 collection of the backup is left out')
    // Fourth review of B2 (I2): named, with what a cap does (fifth review: plural, quoted, neutral).
    expect(card.textContent).toContain(
      '“sales.events” is capped: it keeps only as many documents as its cap allows — writing into it may remove its oldest.',
    )
    expect(card.textContent).toContain('the server the backup was made of')
    expect(card.textContent).toContain('A backup of Prod.')
    // I1: which backup, by when it was made (seconds included: two made a minute apart differ).
    // Fifth review (M-6): as this browser says that time, wherever it is.
    const at = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' })
    expect(card.textContent).toContain(`Made ${at.format(Date.UTC(2026, 9, 25, 3, 0, 5))}.`)
    // One field, any length: the password the backup was made with, never asked twice.
    const fields = card.querySelectorAll<HTMLInputElement>('[data-agent-password] input[type="password"]')
    expect(fields).toHaveLength(1)
    await typeInto(card.querySelector<HTMLInputElement>('[data-agent-typed]')!, 'sales')
    await typeInto(fields[0]!, 'short')
    const confirm = card.querySelector<HTMLButtonElement>('[data-agent-confirm]')!
    expect(confirm.disabled).toBe(false)
    for (const lang of ['en', 'tr'] as const) {
      expect(i18n.global.te('ai.agent.tool.restore_backup', lang)).toBe(true)
      for (const reason of [
        'backup_unknown',
        'restore_in_app',
        'plan_changed',
        'backup_password',
        'backup_key_needed',
        'password_short',
        'restore_confirm_ttl',
        'restore_confirm_personal',
        'restore_confirm_masked',
        'restore_permissions',
        'restore_personal_replace',
        'restore_timeseries_replace',
        'restore_series_version',
        'restore_tools_unavailable',
        'restore_add_rules_forbidden',
        'restore_too_many_rules',
      ])
        expect(i18n.global.te(`ai.agent.reason.${reason}`, lang), reason).toBe(true)
    }
    void bodies
  })

  // Design 2026-10-25 (B5): a read step shows its documents in the panel, from the person's own read —
  // asked for, not read before; the same read the agent made, kept out of the person's recent queries.
  it('shows a find step’s documents from the person’s own read, on asking', async () => {
    const finds: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        'POST connections/c1/databases/sales/collections/orders/find': (body) => {
          finds.push(body)
          return [
            200,
            {
              documents: [
                { document: { _id: { $oid: '65f000000000000000000001' }, status: 'shipping' }, hash: 'h1' },
                { document: { _id: { $oid: '65f000000000000000000002' }, status: 'shipping' }, hash: 'h2' },
              ],
              hasMore: false,
            },
          ]
        },
      },
    })
    await typeInto(composer(), 'shipping orders')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'find_documents',
          kind: 'read',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'done',
          sent: 'counts',
          summary: { returned: 2, more: false },
          results: {
            kind: 'find',
            filter: { status: 'shipping' },
            sort: { n: { $numberInt: '-1' } },
            limit: 5,
          },
        }),
      },
    ])
    expect(finds).toEqual([])
    const show = document.querySelector<HTMLButtonElement>('[data-agent-results]')!
    expect(show.textContent).toContain('Show documents')
    expect(show.getAttribute('aria-expanded')).toBe('false')
    show.click()
    await flushPromises()
    await nextTick()
    expect(finds).toEqual([
      {
        filter: { status: 'shipping' },
        sort: { n: { $numberInt: '-1' } },
        skip: 0,
        limit: 5,
        record: false,
      },
    ])
    const region = document.getElementById(show.getAttribute('aria-controls')!)!
    expect(show.getAttribute('aria-expanded')).toBe('true')
    expect(region.textContent).toContain('65f000000000000000000002')
    expect(region.textContent).toContain('Read as you and shown here only')
    // Review of B5 (M3): no row menu whose actions nothing would handle.
    expect(region.querySelector('button[aria-label^="Actions for document"]')).toBeNull()
    // Hidden and shown again: read once.
    show.click()
    await nextTick()
    expect(
      document
        .getElementById(show.getAttribute('aria-controls')!)!
        .querySelector<HTMLElement>('[data-agent-results-list]')!.style.display,
    ).toBe('none')
    show.click()
    await flushPromises()
    expect(finds).toHaveLength(1)
  })

  // Review of B5 (I1): the turn stored and drawn from the chat, its steps still show their documents
  // (kept in this browser's memory beside the turn; the server never keeps them).
  it('still shows a find step’s documents once its turn is stored', async () => {
    const finds: unknown[] = []
    const record: AiChatTurnRecord = {
      connectionId: null,
      namespace: null,
      rulesVersion: null,
      sources: [{ connectionId: 'c1', rulesVersion: 0 }],
      parts: { schema: false, current: false, indexes: false, validator: false, samples: 0 },
      provider: { id: 'p1', name: 'Local', model: 'm', kind: 'openai' },
      local: true,
      usage: { input: 1, output: 1 },
      state: 'done',
      agent: {
        steps: [
          {
            tool: 'find_documents',
            connectionId: 'c1',
            namespace: 'sales.orders',
            state: 'done',
            sent: 'counts',
            summary: { returned: 1, more: false },
          },
        ],
        connections: 1,
        documents: false,
      },
    }
    const view: AiChatView = {
      id: 'ch1',
      title: 'add users',
      full: false,
      messages: [
        { id: 'u1', role: 'user', text: 'shipping orders', createdAt: 1, turn: record },
        { id: 'a1', role: 'assistant', text: 'Here.', createdAt: 1, blocks: [] },
      ],
    }
    const { push, end, store } = await agentPanel({
      lines: START,
      handlers: {
        'GET ai/chats/ch1': () => [200, view],
        'POST connections/c1/databases/sales/collections/orders/find': (body) => {
          finds.push(body)
          return [
            200,
            {
              documents: [{ document: { _id: { $oid: '65f000000000000000000003' } }, hash: 'h3' }],
              hasMore: false,
            },
          ]
        },
      },
    })
    await typeInto(composer(), 'shipping orders')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'find_documents',
          kind: 'read',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'done',
          sent: 'counts',
          summary: { returned: 1, more: false },
          results: { kind: 'find', filter: {}, limit: 5 },
        }),
      },
      { type: 'text', delta: 'Here.' },
      { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true },
    ])
    await end()
    await vi.waitFor(() => expect(store.live).toBeNull())
    const show = document.querySelector<HTMLButtonElement>('[data-agent-results]')!
    expect(show).not.toBeNull()
    show.click()
    await flushPromises()
    expect(finds).toHaveLength(1)
    expect(document.getElementById(show.getAttribute('aria-controls')!)!.textContent).toContain(
      '65f000000000000000000003',
    )
    // Another chat forgets it.
    store.newChat()
    await flushPromises()
  })

  it('shows an aggregation step’s documents from the person’s own run', async () => {
    const runs: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        'POST connections/c1/databases/sales/collections/orders/aggregate/run': (body) => {
          runs.push(body)
          return new Response(
            [
              JSON.stringify({ document: { _id: 'shipping', n: { $numberInt: '7' } }, hash: 'a1' }),
              JSON.stringify({ end: { count: 1, truncated: false, bytes: 40 } }),
            ].join('\n') + '\n',
            { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
          )
        },
      },
    })
    await typeInto(composer(), 'group them')
    enter(composer())
    await flushPromises()
    const stages = [{ $group: { _id: '$status', n: { $sum: { $numberInt: '1' } } } }]
    await push([
      {
        type: 'step',
        step: step({
          tool: 'run_aggregation',
          kind: 'read',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'done',
          sent: 'counts',
          summary: { returned: 1 },
          results: { kind: 'aggregate', stages, limit: 3 },
        }),
      },
    ])
    document.querySelector<HTMLButtonElement>('[data-agent-results]')!.click()
    // The run's lines are read with a turn of the event loop between chunks.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await flushPromises()
    }
    expect(runs).toEqual([{ stages, limit: 3, remember: false }])
    expect(document.querySelector('[data-agent-results-list]')!.textContent).toContain('shipping')
  })

  // Design 2026-10-25 (C1): an export's card says how many documents go, and where the file is.
  it('says what an export takes and where its file is', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'export the shipping orders')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'export_documents',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'awaiting',
          proposal: {
            payload: { export: 'sales.orders', format: 'csv', source: 'query' },
            preview: { documents: 2, format: 'csv' },
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('Export documents')
    expect(card.textContent).toContain('2 documents are exported.')
    expect(card.textContent).toContain('Written as CSV, downloaded from Background jobs.')
    for (const lang of ['en', 'tr'] as const)
      for (const key of ['tool.export_documents', 'preview.exported', 'preview.exportFormat'])
        expect(i18n.global.te(`ai.agent.${key}`, lang), key).toBe(true)
  })

  // Design 2026-10-25 (C3): a validator's card says what it would refuse now and what it replaces.
  it('says how many documents break proposed rules, and the rules they replace', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'require n')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'set_validator',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'awaiting',
          proposal: {
            payload: {
              validator: { $jsonSchema: { required: ['n'] } },
              validationLevel: 'strict',
              validationAction: 'error',
            },
            preview: { failing: 1, total: 3, replaces: true },
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('Set validation rules')
    expect(card.textContent).toContain('1 document there breaks these rules now.')
    expect(card.textContent).toContain('They replace the collection’s rules.')
  })

  // Review of C3 (I3, M8, M10, nit 14): the step's words; a removal, a bound, an uncounted test, a level.
  it('says rules removed or set, and what a card for them changes', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'rules')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          id: '1.1',
          tool: 'set_validator',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'done',
          sent: 'outcome',
          summary: { validator: 'set' },
        }),
      },
      {
        type: 'step',
        step: step({
          id: '1.2',
          tool: 'set_validator',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'items' },
          state: 'awaiting',
          proposal: {
            payload: {
              validator: { n: { $exists: true } },
              validationLevel: 'moderate',
              validationAction: 'warn',
            },
            preview: {
              failingUnknown: true,
              total: 9,
              replaces: true,
              level: 'moderate',
              action: 'warn',
              currentRules: { n: { $type: 'int' } },
            },
            destructive: true,
          },
        }),
      },
    ])
    expect(document.querySelector('[data-agent-step="set_validator"]')!.textContent).toContain('Rules set')
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('could not be counted in time')
    expect(card.textContent).toContain('They replace the collection’s rules.')
    expect(card.textContent).toContain('Level: moderate (was strict).')
    expect(card.textContent).toContain('Action: warn only (was refuse the write).')
    // Re-review of C3 (minor 6): the rules replaced beside what is sent, not in it.
    const replaced = card.querySelector<HTMLElement>('[data-agent-replaced]')!
    expect(replaced.textContent).toContain('Rules replaced')
    expect(replaced.textContent).toContain('"$type": "int"')
  })

  // Design 2026-10-25 (C3): a copy's card — how many go, into what, as the person sees it.
  it('says what a copy takes and what it goes into', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'copy orders')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'copy_collection',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'awaiting',
          proposal: {
            payload: { copy: 'sales.orders', to: 'Sales Mongo / sales.archive', mode: 'replace' },
            preview: {
              documents: 120,
              documentsAbout: true,
              targetExists: true,
              targetDocuments: 7,
              mode: 'replace',
              masked: true,
            },
            typed: 'sales.archive',
            destructive: true,
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('Copy a collection')
    expect(card.textContent).toContain('About 120 documents are copied.')
    expect(card.textContent).toContain(
      'It goes into a collection there already (7 documents), replaced whole.',
    )
    expect(card.textContent).toContain('Copied as you see it: personal fields hidden.')
  })

  // Review of C1 (M3, M6): a count only bounded said as such; a SQL file's dialect; a compressed file.
  it('says an export’s count as a bound, its dialect and its compression', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'export all as mysql')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'export_documents',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'orders' },
          state: 'awaiting',
          proposal: {
            payload: { export: 'sales.orders', format: 'sql', dialect: 'mysql', gzip: true, filter: {} },
            preview: {
              documents: 10000,
              documentsAtLeast: true,
              format: 'sql',
              dialect: 'mysql',
              compressed: true,
            },
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('At least 10,000 documents are exported.')
    expect(card.textContent).toContain(
      'Written as SQL (MySQL), downloaded from Background jobs. Compressed (gzip).',
    )
  })

  // Design 2026-10-25 (B7): the page the person is on goes with the turn — an app page alone, a
  // connection's section with its connection — and the context bar says it.
  it('sends the page the person is on as the turn’s focus', async () => {
    const { push, bodies, tabs } = await agentPanel({ lines: START })
    const { useTabSectionsStore } = await import('../src/stores/tabSections')
    tabs.open({ kind: 'schedules', title: '' })
    await flushPromises()
    expect(document.body.textContent).toContain('Scheduled backups')
    await typeInto(composer(), 'pause the nightly one')
    enter(composer())
    await flushPromises()
    await push([])
    expect((bodies.at(-1) as { focus: unknown }).focus).toEqual({ page: 'schedules' })
    const id = tabs.open({ kind: 'connection', title: 'Sales Mongo', params: { connectionId: 'c1' } })
    useTabSectionsStore().setValue(id, 'shown', 'performance')
    await flushPromises()
    expect(document.body.textContent).toContain('Performance on Sales Mongo')
    const store = useAssistantStore()
    store.newChat()
    await flushPromises()
    await typeInto(composer(), 'what is slow here?')
    enter(composer())
    await flushPromises()
    await push([])
    expect((bodies.at(-1) as { focus: unknown }).focus).toEqual({ connectionId: 'c1', page: 'performance' })
  })

  // Design 2026-10-25 (B4): a new MongoDB user's password typed on its card — said as the user's, twice,
  // and sent with the decision only.
  it('asks a new MongoDB user’s password on its card, as the user’s', async () => {
    const decided: unknown[] = []
    const { push } = await agentPanel({
      on: true,
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'done', summary: { created: 'reports' } }]
        },
      },
    })
    await typeInto(composer(), 'make a reports user')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          id: '1.1',
          tool: 'create_user',
          kind: 'write',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
          state: 'awaiting',
          proposal: {
            payload: { createUser: 'reports', database: 'sales', roles: ['read@sales'] },
            preview: {},
            password: true,
            passwordFor: 'user',
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('Create a MongoDB user')
    expect(card.textContent).toContain('never kept, logged or shown to the assistant')
    expect(card.textContent).not.toContain('It goes to the backup only')
    expect(card.querySelector('[data-agent-password] legend')!.textContent).toContain(
      'The new user’s password',
    )
    const fields = card.querySelectorAll<HTMLInputElement>('[data-agent-password] input[type="password"]')
    // Review of B4 (I2): Database Access's field — generated, shown and copied, at most what MongoDB takes,
    // and never the backup's warning.
    expect(fields).toHaveLength(1)
    expect(fields[0]!.maxLength).toBe(256)
    expect(card.textContent).not.toContain('this backup cannot be opened')
    expect(card.querySelector('[data-agent-password]')!.textContent).toContain('Generate')
    const confirm = card.querySelector<HTMLButtonElement>('[data-agent-confirm]')!
    await typeInto(fields[0]!, 'too-short')
    expect(confirm.disabled).toBe(true)
    await typeInto(fields[0]!, 'a-strong-password-1')
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await flushPromises()
    expect(decided.at(-1)).toMatchObject({ decision: 'confirm', password: 'a-strong-password-1' })
    for (const lang of ['en', 'tr'] as const) {
      for (const tool of ['list_users', 'list_roles', 'create_user', 'drop_user'])
        expect(i18n.global.te(`ai.agent.tool.${tool}`, lang), tool).toBe(true)
      for (const key of ['summary.users', 'summary.roles', 'preview.userRoles', 'card.userPassword'])
        expect(i18n.global.te(`ai.agent.${key}`, lang), key).toBe(true)
      for (const reason of [
        'user_exists',
        'user_unknown',
        'broad_role',
        'role_unknown',
        'external_user',
        'own_account',
        'password_invalid',
      ])
        expect(i18n.global.te(`ai.agent.reason.${reason}`, lang), reason).toBe(true)
    }
  })

  // User report 2026-10-25 ("ajan modu aktif değilse çalışmıyor"): a plain turn asked for a change
  // says the agent does it; one click turns agent mode on and asks the agent the same, in the same chat.
  it('hands a change the plain assistant cannot make to the agent, in the same chat', async () => {
    const { push, bodies, fetchMock, calls } = await agentPanel({ on: true, lines: START })
    // Documents ticked while the agent was on, then agent mode turned off: the tick stays behind.
    const chip = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Documents',
    )!
    chip.click()
    await flushPromises()
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    document.querySelector<HTMLInputElement>('input[role="switch"]')!.click()
    await flushPromises()
    const enc = new TextEncoder()
    const before = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (!String(input).endsWith('/ai/chat')) return before(input, init)
      const plain: AiChatLine[] = [
        { type: 'chat', id: 'ch1', title: 'add a user', turn: 'u1' },
        { type: 'text', delta: 'I cannot add it; the agent can.\n[[agent]]' },
        { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true, agentAsked: true },
      ]
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(plain.map((l) => JSON.stringify(l)).join('\n')))
            c.close()
          },
        }),
      )
    })
    await typeInto(composer(), 'add a user named Gökhan')
    enter(composer())
    await flushPromises()
    await vi.waitFor(() => expect(document.body.textContent).toContain('I cannot add it; the agent can.'))
    // The line is the panel's, never the person's to read.
    expect(document.body.textContent).not.toContain('[[agent]]')
    // Drawn a tick after the answer (under a loaded run, not at once).
    const ask = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Ask the agent to do it'),
      )
      expect(found).toBeDefined()
      return found!
    })
    // Elsewhere now, Documents ticked: the handoff is about the turn's collection, with no values.
    const tabs = useTabsStore()
    tabs.open({
      kind: 'collection',
      title: 'shop.users',
      params: { connectionId: 'c1', db: 'shop', coll: 'users' },
    })
    await flushPromises()
    ask.click()
    await flushPromises()
    await push([])
    expect(calls.some((c) => c.method === 'PUT' && c.path === 'me/ai-agent')).toBe(true)
    // About the turn's own collection, never documents' values without this message's consent.
    expect(bodies.at(-1)).toMatchObject({ message: 'add a user named Gökhan', chat: 'ch1', documents: false })
    // Exactly as the server takes it (a key more is refused).
    expect((bodies.at(-1) as { focus: unknown }).focus).toEqual({
      connectionId: 'c1',
      db: 'shop',
      coll: 'orders',
    })
  })

  // Review of the chat entry (M1): the line is found without a pattern that a long answer slows.
  it('finds the agent line at once in a long answer, and leaves a bracket that starts a list alone', () => {
    const long = '\n['.concat(' '.repeat(200_000), 'x')
    const started = performance.now()
    expect(withoutAgentLine(long)).toBe(long)
    expect(performance.now() - started).toBeLessThan(50)
    expect(withoutAgentLine('done\n[[agent]]')).toBe('done')
    expect(withoutAgentLine('done\n[[ag')).toBe('done')
    expect(withoutAgentLine('a list:\n[')).toBe('a list:\n[')
    expect(withoutAgentLine('say [[agent]] to ask')).toBe('say [[agent]] to ask')
  })

  // Review of the chat entry (M2): where the agent may only read, no change is handed to it.
  it('offers no handoff where the agent may only read', async () => {
    const { fetchMock } = await agentPanel({
      on: false,
      lines: START,
      handlers: {
        'GET me/ai-agent': () => [200, { on: false, available: true, policy: 'read', assistant: true }],
      },
    })
    const before = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (!String(input).endsWith('/ai/chat')) return before(input, init)
      const plain: AiChatLine[] = [
        { type: 'chat', id: 'ch1', title: 'add a user', turn: 'u1' },
        { type: 'text', delta: 'The agent does it.\n[[agent]]' },
        { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true, agentAsked: true },
      ]
      return new Response(new Blob([plain.map((l) => JSON.stringify(l)).join('\n')]).stream())
    })
    await typeInto(composer(), 'add a user')
    enter(composer())
    await flushPromises()
    await vi.waitFor(() => expect(document.body.textContent).toContain('The agent does it.'))
    expect(document.querySelector('[data-ask-agent]')).toBeNull()
  })

  // The AI database manager (design 2026-10-25, A2): an administrator's policy, said where the switch is.
  it('says agent mode is off on the server, the switch off and disabled', async () => {
    await agentPanel({
      handlers: {
        'GET me/ai-agent': () => [200, { on: true, available: false, assistant: true, policy: 'off' }],
      },
    })
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-agent-mode] input')!
    expect(input.disabled).toBe(true)
    expect(input.checked).toBe(false)
    expect(document.querySelector('[data-agent-mode]')!.textContent).toContain(
      'An administrator turned agent mode off on this server.',
    )
  })

  // Review of A2 (I1): the person's own switch was on — a message goes to the plain assistant, not
  // to an agent the server refuses.
  it('sends to the plain assistant while the agent is off on the server', async () => {
    const { bodies } = await agentPanel({
      handlers: {
        'GET me/ai-agent': () => [200, { on: true, available: false, assistant: true, policy: 'off' }],
      },
    })
    await flushPromises()
    const sent: string[] = []
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[RequestInfo | URL]> } }
    await typeInto(composer(), 'hi')
    enter(composer())
    await flushPromises()
    for (const [input] of fetchMock.mock.calls) sent.push(new URL(String(input)).pathname)
    expect(sent.some((p) => p.endsWith('/ai/chat'))).toBe(true)
    expect(bodies).toHaveLength(0)
  })

  // Review of A2 (I1): turned off by an administrator while this panel was open — the refusal reads
  // the switch again, so it says so at once.
  it('reads the switch again when a turn is refused for the policy', async () => {
    let policy = 'full'
    const { fetchMock, calls } = await agentPanel({
      handlers: {
        'GET me/ai-agent': () => [200, { on: true, available: policy !== 'off', assistant: true, policy }],
      },
    })
    await flushPromises()
    const through = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) =>
      String(input).endsWith('/ai/agent')
        ? new Response(
            JSON.stringify({ code: 'FORBIDDEN', message: 'x', details: { reason: 'agent_policy_off' } }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )
        : through(input, init),
    )
    policy = 'off'
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === 'me/ai-agent').length
    const before = reads()
    await typeInto(composer(), 'hi')
    enter(composer())
    await flushPromises()
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before))
    await flushPromises()
    expect(document.querySelector<HTMLInputElement>('[data-agent-mode] input')!.disabled).toBe(true)
  })

  // Second re-review (minor 3): a card ended by the policy — the usual way now — reads the switch again.
  it('reads the switch again when a step ends for the policy', async () => {
    let policy = 'full'
    const { push, calls } = await agentPanel({
      lines: START,
      handlers: {
        'GET me/ai-agent': () => [200, { on: true, available: policy !== 'off', assistant: true, policy }],
      },
    })
    await typeInto(composer(), 'add users')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: CREATE }])
    policy = 'read'
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === 'me/ai-agent').length
    const before = reads()
    await push([
      { type: 'step', step: { ...CREATE, state: 'error', reason: 'agent_policy_read', proposal: undefined } },
    ])
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before))
  })

  // Second re-review (minor 2): Enter confirms from a password field only — never from the field's
  // own buttons (show, copy, generate), which keep their own Enter.
  it('confirms a backup with Enter in its password fields, never from their buttons', async () => {
    const decided: unknown[] = []
    const BACKUP = step({
      id: '1.5',
      tool: 'run_backup',
      place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
      proposal: { payload: { format: 'mmbak' }, preview: { namespaces: 1, format: 'mmbak' }, password: true },
    })
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'done', summary: { started: true } }]
        },
      },
    })
    await typeInto(composer(), 'back up')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: BACKUP }])
    const inputs = card()!.querySelectorAll<HTMLInputElement>('input[type="password"]')
    await typeInto(inputs[0]!, 'correct-horse-battery-1')
    await typeInto(inputs[1]!, 'correct-horse-battery-1')
    const button = card()!.querySelector<HTMLButtonElement>('[data-agent-password] button')!
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 800))
    await flushPromises()
    expect(decided).toEqual([])
    inputs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(decided).toHaveLength(1))
  })

  // Re-review (M6): a confirmation refused for the policy reads the switch again too.
  it('reads the switch again when a confirmation is refused for the policy', async () => {
    let policy = 'full'
    const { push, calls } = await agentPanel({
      lines: START,
      handlers: {
        'GET me/ai-agent': () => [200, { on: true, available: policy !== 'off', assistant: true, policy }],
        [`POST ai/agent/runs/${RUN}/decide`]: () => [
          403,
          { code: 'FORBIDDEN', message: 'x', details: { reason: 'agent_policy_read' } },
        ],
      },
    })
    await typeInto(composer(), 'add users')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: CREATE }])
    policy = 'read'
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === 'me/ai-agent').length
    const before = reads()
    cardButton('confirm').click()
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before))
  })

  it('says the agent may only read on this server, beside the switch', async () => {
    await agentPanel({
      handlers: { 'GET me/ai-agent': () => [200, { on: true, available: true, policy: 'read' }] },
    })
    await flushPromises()
    expect(document.querySelector('[data-agent-mode]')!.textContent).toContain('read only on this server')
  })

  // The AI database manager (design 2026-10-25, A1): what the person asked for, shown — the find run
  // in the opened collection, a pipeline put in its builder (run there unless it writes).
  it('opens a collection with the find the agent gives, and runs it there', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    await typeInto(composer(), 'orders that are shipping')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'open',
        target: {
          connectionId: 'c1',
          db: 'sales',
          coll: 'orders',
          section: 'documents',
          show: { kind: 'query', filter: { status: 'shipping' }, sort: { total: { $numberInt: '-1' } } },
        },
      },
    ])
    await flushPromises()
    const opened = tabs.tabs.find((t) => t.params.db === 'sales' && t.params.coll === 'orders')!
    expect(tabs.active?.id).toBe(opened.id)
    const state = useCollectionViewsStore().stateFor(opened.id)
    expect(state.section).toBe('documents')
    expect(state.query.filter).toEqual({ status: 'shipping' })
    expect(state.query.sort).toEqual({ total: { $numberInt: '-1' } })
  })

  // Review of A1: the person's own query is not replaced unasked; a cancel leaves it all as it was.
  it('asks before replacing a query being written, and a cancel changes nothing', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    const tabId = openCollectionTab(tabs, 'c1', 'sales', 'orders')
    const state = useCollectionViewsStore().stateFor(tabId)
    state.draft = { ...state.draft, filter: '{ mine: 1 }' }
    const before = JSON.stringify(state.query)
    await typeInto(composer(), 'shipping ones')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'open',
        target: {
          connectionId: 'c1',
          db: 'sales',
          coll: 'orders',
          section: 'documents',
          show: { kind: 'query', filter: { status: 'shipping' }, limit: 25 },
        },
      },
    ])
    await vi.waitFor(() => expect(useDialogStore().current).not.toBeNull())
    useDialogStore().settle(false)
    await flushPromises()
    expect(state.draft.filter).toBe('{ mine: 1 }')
    expect(JSON.stringify(state.query)).toBe(before)
  })

  it('shows as many documents as the agent asked for', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    await typeInto(composer(), 'the first 25')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'open',
        target: {
          connectionId: 'c1',
          db: 'sales',
          coll: 'orders',
          section: 'documents',
          show: { kind: 'query', filter: {}, limit: 25 },
        },
      },
    ])
    await flushPromises()
    const state = useCollectionViewsStore().stateFor(
      tabs.tabs.find((t) => t.params.db === 'sales' && t.params.coll === 'orders')!.id,
    )
    expect(state.query.limit).toBe(25)
    expect(state.draft.limit).toBe(25)
  })

  it('puts a pipeline in the builder and runs it, one that writes never', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    await typeInto(composer(), 'group them')
    enter(composer())
    await flushPromises()
    const open = (coll: string, stages: Array<Record<string, unknown>>, writes: boolean) =>
      push([
        {
          type: 'open',
          target: {
            connectionId: 'c1',
            db: 'sales',
            coll,
            section: 'aggregations',
            show: { kind: 'pipeline', stages, writes },
          },
        },
      ])
    await open('orders', [{ $match: {} }], false)
    await flushPromises()
    let agg = useCollectionViewsStore().stateFor(
      tabs.tabs.find((t) => t.params.db === 'sales' && t.params.coll === 'orders')!.id,
    ).aggregation
    expect(agg.cards.map((c) => c.operator)).toEqual(['$match'])
    expect(agg.runOnArrival).not.toBeNull()
    await open('logs', [{ $match: {} }, { $out: 'copied' }], true)
    await flushPromises()
    agg = useCollectionViewsStore().stateFor(
      tabs.tabs.find((t) => t.params.db === 'sales' && t.params.coll === 'logs')!.id,
    ).aggregation
    expect(agg.cards.map((c) => c.operator)).toEqual(['$match', '$out'])
    expect(agg.runOnArrival).toBeNull()
  })

  it('opens the tab the agent asks for, and the collection a step touched', async () => {
    const { push, tabs } = await agentPanel({ lines: START })
    await typeInto(composer(), 'show users')
    enter(composer())
    await flushPromises()
    await push([
      { type: 'open', target: { connectionId: 'c1', db: 'sales', coll: 'users', section: 'schema' } },
    ])
    const opened = tabs.tabs.find((t) => t.params.coll === 'users')!
    expect(tabs.active?.id).toBe(opened.id)
    expect(useCollectionViewsStore().stateFor(opened.id).section).toBe('schema')
    await push([
      {
        type: 'step',
        step: step({
          id: '2.1',
          tool: 'count_documents',
          kind: 'read',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'logs' },
          state: 'done',
          summary: { count: 4 },
        }),
      },
    ])
    document
      .querySelector<HTMLButtonElement>('[data-agent-step="count_documents"] [data-agent-open]')!
      .click()
    await nextTick()
    expect(tabs.tabs.some((t) => t.params.coll === 'logs')).toBe(true)
  })

  it('draws a stored agent turn’s steps, and what was sent', async () => {
    const record: AiChatTurnRecord = {
      connectionId: null,
      namespace: null,
      rulesVersion: null,
      sources: [{ connectionId: 'c1', rulesVersion: 0 }],
      parts: { schema: false, current: false, indexes: false, validator: false, samples: 0 },
      provider: { id: 'p1', name: 'Local', model: 'm', kind: 'openai' },
      local: true,
      usage: { input: 1, output: 1 },
      state: 'done',
      agent: {
        steps: [
          {
            tool: 'insert_documents',
            connectionId: 'c1',
            namespace: 'sales.users',
            state: 'done',
            sent: 'outcome',
            summary: { inserted: 1 },
          },
        ],
        connections: 2,
        documents: false,
      },
    }
    const view: AiChatView = {
      id: 'ch1',
      title: 'add users',
      full: false,
      messages: [
        { id: 'u1', role: 'user', text: 'add a demo user', createdAt: 1, turn: record },
        { id: 'a1', role: 'assistant', text: 'Done.', createdAt: 1, blocks: [] },
      ],
    }
    await agentPanel({ handlers: { 'GET ai/chats/ch1': () => [200, view] } })
    await useAssistantStore().openChat('ch1')
    await flushPromises()
    const row = document.querySelector('[data-agent-step="insert_documents"]')!.textContent!
    expect(row).toContain('Insert documents')
    expect(row).toContain('Sales Mongo · sales.users')
    expect(row).toContain('Sent: the outcome only')
    // What it did stays with the stored turn.
    expect(row).toContain('Inserted 1 document')
    expect(document.body.textContent).toContain(
      'Sent: your words and the names of 2 connections (no addresses)',
    )
  })

  // Security review of W6.3 (I3): a TTL index deletes documents; the card says how many at once.
  it('shows a TTL index as a destructive change: what would expire now, the name typed', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'expire logs')
    enter(composer())
    await push([
      {
        type: 'step',
        step: step({
          id: '1.3',
          tool: 'create_index',
          proposal: {
            payload: { key: { createdAt: 1 }, options: { expireAfterSeconds: 0 } },
            preview: { expiring: 3 },
            typed: 'users',
            destructive: true,
          },
        }),
      },
    ])
    expect(card()!.textContent).toContain('3 documents would be deleted within a minute')
    expect(cardButton('confirm').disabled).toBe(true)
  })

  it('says a refusal of the review in words: a personal field, a count that changed', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'count')
    enter(composer())
    await push([
      {
        type: 'step',
        step: step({
          id: '1.4',
          tool: 'count_documents',
          kind: 'read',
          state: 'refused',
          reason: 'personal_field',
        }),
      },
      {
        type: 'step',
        step: step({ id: '1.5', tool: 'delete_documents', state: 'error', reason: 'count_changed' }),
      },
      {
        type: 'step',
        step: step({
          id: '1.6',
          tool: 'run_aggregation',
          kind: 'read',
          state: 'refused',
          reason: 'diagnostic_stage',
        }),
      },
      {
        type: 'step',
        step: step({
          id: '1.7',
          tool: 'count_documents',
          kind: 'read',
          state: 'refused',
          reason: 'source_unknown',
        }),
      },
    ])
    const text = document.querySelector('[data-agent-steps]')!.textContent!
    expect(text).toContain('It names a personal field')
    expect(text).toContain('The number of matching documents changed')
    expect(text).toContain('other clients’ queries')
    expect(text).toContain('could not be read')
  })

  it('reads in Turkish', async () => {
    i18n.global.locale.value = 'tr'
    const { push } = await agentPanel({ lines: START })
    const box = byLabel<HTMLTextAreaElement>('Asistana mesaj yazın')
    await typeInto(box, 'kullanıcı ekle')
    enter(box)
    await flushPromises()
    await push([{ type: 'step', step: CREATE }])
    expect(card()!.textContent).toContain('Koleksiyon oluştur')
    expect(card()!.textContent).toContain('Onayla')
    expect(card()!.textContent).toContain('Reddet')
  })
})

// Fifth review of B2 (M-1): several capped targets are said as several, in both languages.
describe('a restore card’s capped targets', () => {
  it('says one, or several, as such', () => {
    const t = i18n.global.t
    const key = 'ai.agent.preview.restoreWarn.cappedNames'
    i18n.global.locale.value = 'en'
    expect(t(key, { names: '“a.x”' }, 1)).toContain('“a.x” is capped: it keeps')
    expect(t(key, { names: '“a.x” and “a.y”' }, 2)).toContain('“a.x” and “a.y” are capped: they keep')
    i18n.global.locale.value = 'tr'
    expect(t(key, { names: '“a.x” ve “a.y”' }, 2)).toContain('sınırlarının izin verdiği')
    i18n.global.locale.value = 'en'
  })
})

// Design 2026-10-25 (B3): the server's health in words, and the card that stops an operation.
describe('the server tools’ words', () => {
  it('says what each found and what a kill stops, in both languages', () => {
    for (const lang of ['en', 'tr'] as const) {
      for (const key of [
        'ai.agent.summary.members',
        'ai.agent.summary.operations',
        'ai.agent.summary.queries',
        'ai.agent.summary.suggestions',
        'ai.agent.summary.killed',
        'ai.agent.preview.killOperation',
        'ai.agent.reason.operation_unknown',
        // Review of B3: an operation finished, changed or Mongo Manager's own; MongoDB's refusal;
        // the kinds of operation; a standalone server and its version.
        'ai.agent.reason.operation_finished',
        'ai.agent.reason.operation_changed',
        'ai.agent.reason.operation_own',
        'ai.agent.reason.mongo_not_permitted',
        'ai.agent.opKind.query',
        'ai.agent.opKind.insert',
        'ai.agent.opKind.command',
        'ai.agent.opKind.update',
        'ai.agent.opKind.remove',
        'ai.agent.opKind.getmore',
        'ai.agent.opKind.killcursors',
        'ai.agent.preview.killOperationNoNs',
        'ai.agent.summary.version',
        'ai.agent.summary.mode.standalone',
        'ai.agent.summary.mode.sharded',
        'ai.agent.summary.unneeded',
      ])
        expect(i18n.global.te(key, lang), `${lang} ${key}`).toBe(true)
    }
    i18n.global.locale.value = 'en'
    expect(
      i18n.global.t('ai.agent.preview.killOperation', {
        op: i18n.global.t('ai.agent.opKind.insert'),
        ns: 'shop.orders',
        secs: '12',
      }),
    ).toBe('Stops an insert on shop.orders, running for 12 s.')
  })
})

// Design 2026-10-25 (C4): a plan of changes, and a backup made before a change that loses data.
describe('a plan of changes and a backup first, in the panel (C4)', () => {
  const PLAN = step({
    id: '1.1',
    tool: 'plan_changes',
    kind: 'ui',
    place: null,
    state: 'done',
    summary: { changes: 3 },
    plan: {
      title: 'Archive the orders',
      changes: [
        { tool: 'create_collection', about: 'A collection for the archive' },
        { tool: 'copy_collection', about: 'The old orders copied into it' },
        { tool: 'delete_documents', about: 'The old orders deleted' },
      ],
    },
  })
  const items = () =>
    [...document.querySelectorAll<HTMLElement>('[data-agent-plan] [data-agent-plan-item]')].map(
      (li) => li.dataset.agentPlanItem,
    )

  it('lists the plan’s changes in its order, each with how it went, and what was left once it stopped', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'archive the old orders')
    enter(composer())
    await flushPromises()
    await push([
      { type: 'step', step: PLAN },
      {
        type: 'step',
        step: step({ id: '2.1', state: 'done', planItem: 0, summary: { created: 'sales.archive' } }),
      },
      {
        type: 'step',
        step: step({
          id: '3.1',
          tool: 'copy_collection',
          planItem: 1,
          proposal: { payload: { copy: 'sales.orders', to: 'Sales Mongo / sales.archive', mode: 'insert' } },
        }),
      },
    ])
    const plan = document.querySelector<HTMLElement>('[data-agent-plan]')!
    expect(plan.getAttribute('aria-label')).toBe('Plan: Archive the orders')
    expect(plan.textContent).toContain('The old orders copied into it')
    expect(items()).toEqual(['done', 'awaiting', 'todo'])
    expect(document.querySelector('[data-agent-step="plan_changes"]')!.textContent).toContain(
      '3 changes planned',
    )
    await push([
      { type: 'step', step: step({ id: '3.1', tool: 'copy_collection', planItem: 1, state: 'declined' }) },
    ])
    expect(items()).toEqual(['done', 'declined', 'skipped'])
    expect(plan.textContent).toContain('Not proposed: the plan stopped')
  })

  it('backs up first from the card, with its password asked twice, and holds Confirm until the backup is made', async () => {
    const decided: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'backing_up', job: 'j1' }]
        },
      },
    })
    await typeInto(composer(), 'drop the old orders')
    enter(composer())
    await flushPromises()
    const DROP = step({
      tool: 'drop_collection',
      place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'old' },
      proposal: {
        payload: { drop: 'sales.old' },
        preview: { documents: 5 },
        typed: 'old',
        destructive: true,
        backup: { scope: 'collection', db: 'sales', coll: 'old' },
      },
    })
    await push([{ type: 'step', step: DROP }])
    const section = document.querySelector<HTMLElement>('[data-agent-backup]')!
    expect(section.textContent).toContain('Back up sales.old first')
    const start = section.querySelector<HTMLButtonElement>('[data-agent-backup-start]')!
    expect(start.disabled).toBe(true)
    const [password, repeat] = [...section.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    await typeInto(password!, 'correct horse battery staple 9')
    await typeInto(repeat!, 'correct horse battery staple')
    expect(start.disabled).toBe(true)
    await typeInto(repeat!, 'correct horse battery staple 9')
    expect(start.disabled).toBe(false)
    start.click()
    await flushPromises()
    expect(decided).toEqual([
      { call: '1.1', decision: 'backup', backupPassword: 'correct horse battery staple 9' },
    ])
    await typeInto(document.querySelector<HTMLInputElement>('[data-agent-typed]')!, 'old')
    await push([{ type: 'step', step: { ...DROP, backup: { state: 'running', job: 'j1' } } }])
    expect(document.querySelector('[data-agent-backup-state]')!.textContent).toContain('Backing up')
    expect(cardButton('confirm').disabled).toBe(true)
    await push([{ type: 'step', step: { ...DROP, backup: { state: 'done', job: 'j1' } } }])
    expect(document.querySelector('[data-agent-backup-state]')!.textContent).toContain('Backed up.')
    expect(cardButton('confirm').disabled).toBe(false)
    expect(document.querySelector('[data-agent-backup] [data-agent-backup-start]')).toBeNull()
    // The step says it was backed up first, and opens the backup's job.
    await push([
      {
        type: 'step',
        step: step({
          tool: 'drop_collection',
          state: 'done',
          summary: { dropped: 'sales.old' },
          backup: { state: 'done', job: 'j1' },
        }),
      },
    ])
    const done = document.querySelector<HTMLElement>('[data-agent-step="drop_collection"]')!
    expect(done.querySelector('[data-agent-step-backup]')!.textContent).toContain('Backed up first.')
    expect(done.querySelector('[data-agent-backup-job]')).not.toBeNull()
  })
})

// Review of C4.
describe('a plan and a backup first in the panel: the review of C4', () => {
  it('leaves the changes a turn ended before as not reached (I1)', async () => {
    const { push, end } = await agentPanel({ lines: START })
    await typeInto(composer(), 'two collections')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'plan_changes',
          kind: 'ui',
          place: null,
          state: 'done',
          summary: { changes: 2 },
          plan: {
            title: 'Two',
            changes: [
              { tool: 'create_collection', about: 'First' },
              { tool: 'create_collection', about: 'Second' },
            ],
          },
        }),
      },
      {
        type: 'step',
        step: step({ id: '2.1', state: 'done', planItem: 0, summary: { created: 'sales.a' } }),
      },
      { type: 'note', note: 'plan_unfinished' },
      { type: 'done', blocks: [], usage: { input: 1, output: 1 }, local: true },
    ])
    await end()
    const items = [...document.querySelectorAll<HTMLElement>('[data-agent-plan] [data-agent-plan-item]')]
    expect(items.map((li) => li.dataset.agentPlanItem)).toEqual(['done', 'unreached'])
    expect(items[1]!.textContent).toContain('Not reached in this turn')
    expect(document.body.textContent).toContain('The turn ended before the plan’s last change')
    // The title is the list's name, not one of its items.
    expect(document.querySelector('[data-agent-plan]')!.children.length).toBe(2)
  })

  it('starts the backup with Enter in its password, and says how it goes in one live region (nits)', async () => {
    const decided: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'backing_up', job: 'j1' }]
        },
      },
    })
    await typeInto(composer(), 'drop it')
    enter(composer())
    await flushPromises()
    const DROP = step({
      tool: 'drop_collection',
      place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales', coll: 'old' },
      proposal: {
        payload: { drop: 'sales.old' },
        typed: 'old',
        destructive: true,
        backup: { scope: 'collection', db: 'sales', coll: 'old' },
      },
    })
    await push([{ type: 'step', step: DROP }])
    const status = document.querySelector<HTMLElement>('[data-agent-backup] [role="status"]')!
    expect(status.textContent!.trim()).toBe('')
    const [password, repeat] = [
      ...document.querySelectorAll<HTMLInputElement>('[data-agent-backup] input[type="password"]'),
    ]
    await typeInto(password!, 'correct horse battery staple 9')
    await typeInto(repeat!, 'correct horse battery staple 9')
    repeat!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(decided).toEqual([
      { call: '1.1', decision: 'backup', backupPassword: 'correct horse battery staple 9' },
    ])
    // Started, before the stream says so: Confirm held, the same region says it runs.
    await typeInto(document.querySelector<HTMLInputElement>('[data-agent-typed]')!, 'old')
    expect(cardButton('confirm').disabled).toBe(true)
    expect(document.querySelector('[data-agent-backup] [role="status"]')).toBe(status)
    expect(status.textContent).toContain('Backing up')
    await push([{ type: 'step', step: { ...DROP, backup: { state: 'done', job: 'j1' } } }])
    expect(status.textContent).toContain('Backed up.')
  })
})

// Design 2026-10-25 (C6): a large collection read whole, said while it runs and after.
describe('a whole-collection scan said on its step (C6)', () => {
  it('says it before the read is done, and after', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'find the old ones')
    enter(composer())
    await flushPromises()
    const FIND = { tool: 'find_documents' as const, kind: 'read' as const }
    await push([
      { type: 'step', step: step({ ...FIND, place: null, state: 'running', summary: { scanning: 250000 } }) },
    ])
    const row = () => document.querySelector<HTMLElement>('[data-agent-step="find_documents"]')!
    expect(row().textContent).toContain('it reads the whole collection (about 250,000 documents)')
    await push([
      {
        type: 'step',
        step: step({ ...FIND, state: 'done', sent: 'counts', summary: { returned: 3, scanned: 250000 } }),
      },
    ])
    expect(row().textContent).toContain(
      'Read the whole collection (about 250,000 documents): an index would serve this.',
    )
    // Review of C6 (I2): one that may stop at its first matches, said as such.
    await push([
      {
        type: 'step',
        step: step({
          ...FIND,
          state: 'done',
          sent: 'counts',
          summary: { returned: 3, scanned: 250000, scanMay: true },
        }),
      },
    ])
    expect(row().textContent).toContain(
      'it may have read up to the whole collection (about 250,000 documents)',
    )
  })
})

// Design 2026-10-25 (C7): alert rules and reports on cards.
describe('alert rules and reports on cards (C7)', () => {
  it('says where a rule or report is said, its counts and when, and what was done', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'a morning report')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: step({
          tool: 'create_report',
          place: { connectionId: 'c1', connection: 'Sales Mongo', db: null, coll: null } as never,
          proposal: {
            payload: { name: 'Orders' },
            preview: {
              counts: 2,
              words: 'Every day at 09:00',
              nextRuns: [Date.UTC(2026, 9, 27, 6)],
              timeZone: 'Europe/Istanbul',
              channels: { inApp: true, email: false, webhooks: ['Pager'] },
            },
          },
        }),
      },
    ])
    const card = document.querySelector<HTMLElement>('[data-agent-card]')!
    expect(card.textContent).toContain('Create a scheduled report')
    expect(card.textContent).toContain('It says 2 counts.')
    expect(card.textContent).toContain('Said in the bell and to Pager.')
    expect(card.textContent).toContain('Every day at 09:00')
    await push([
      {
        type: 'step',
        step: step({
          tool: 'create_report',
          state: 'done',
          sent: 'outcome',
          summary: { report: 'ran', name: 'Orders', counts: 2 },
        }),
      },
    ])
    expect(document.querySelector('[data-agent-step="create_report"]')!.textContent).toContain(
      'Report “Orders” ran: 2 counts sent',
    )
  })
})

// Wave C e2e: a stored turn keeps its plan, which change each step was, and a backup made first.
describe('a stored turn’s plan (wave C)', () => {
  it('reads back the plan, each step’s place in it, and the backup made first', () => {
    const steps = storedSteps([
      {
        tool: 'plan_changes',
        connectionId: null,
        namespace: null,
        state: 'done',
        plan: {
          title: 'Two',
          changes: [
            { tool: 'create_collection', about: 'First' },
            { tool: 'drop_collection', about: 'Then' },
          ],
        },
      },
      { tool: 'create_collection', connectionId: 'c1', namespace: 'sales.a', state: 'done', planItem: 0 },
      {
        tool: 'drop_collection',
        connectionId: 'c1',
        namespace: 'sales.b',
        state: 'done',
        planItem: 1,
        backup: { state: 'done', job: 'j1' },
      },
    ])
    expect(steps[0]!.plan).toMatchObject({ title: 'Two' })
    expect(steps.map((s) => s.planItem)).toEqual([undefined, 0, 1])
    expect(steps[2]!.backup).toEqual({ state: 'done', job: 'j1' })
  })

  // 2026-10-31: read again, a step still says how many documents went — not "0 documents".
  it('reads back how many documents a step sent', () => {
    const [step] = storedSteps([
      {
        tool: 'run_aggregation',
        connectionId: 'c1',
        namespace: 'acme.orders',
        state: 'done',
        sent: 'documents',
        documents: 3,
      },
    ])
    expect(step).toMatchObject({ sent: 'documents', documents: 3 })
  })
})

// User request 2026-10-26: "back up the sales database and download it" — without a password where the
// card offers it, and the file downloaded from the step once its job is done.
describe('a backup without a password, and its file from the step', () => {
  const PLAIN_BACKUP = step({
    id: '1.3',
    tool: 'run_backup',
    place: { connectionId: 'c1', connection: 'Sales Mongo', db: 'sales' },
    proposal: {
      payload: { scope: { kind: 'database', db: 'sales' }, format: 'mmbak' },
      preview: { namespaces: 2, format: 'mmbak', expiresInHours: 24 },
      password: true,
      plain: { personal: true },
    },
  })

  it('offers the backup without a password on its card, the person’s choice', async () => {
    const decided: unknown[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        [`POST ai/agent/runs/${RUN}/decide`]: (body) => {
          decided.push(body)
          return [200, { state: 'done', summary: { started: true, format: 'gzip', job: 'j1' } }]
        },
      },
    })
    await typeInto(composer(), 'sales db’sini yedekle ve indir')
    enter(composer())
    await flushPromises()
    await push([{ type: 'step', step: PLAIN_BACKUP }])
    const choices = card()!.querySelectorAll<HTMLInputElement>('[data-agent-format] input[type="radio"]')
    expect(choices).toHaveLength(2)
    // Encrypted unless the person picks otherwise: its password asked, Confirm held for it.
    expect(choices[0]!.checked).toBe(true)
    expect(card()!.querySelectorAll('input[type="password"]')).toHaveLength(2)
    expect(cardButton('confirm').disabled).toBe(true)
    expect(card()!.textContent).toContain('2 namespaces, format mmbak.')
    expect(card()!.querySelector('[data-agent-plain-personal]')).toBeNull()
    choices[1]!.click()
    await flushPromises()
    // Without a password: none asked, what is sent says so, and personal data in clear is said.
    expect(card()!.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(card()!.textContent).toContain('"format": "gzip"')
    // Review (minor 1): the card's words say the format chosen too.
    expect(card()!.textContent).toContain('2 namespaces, format gzip.')
    expect(card()!.querySelector('[data-agent-plain-personal]')!.textContent).toContain(
      'It holds personal data in clear',
    )
    expect(cardButton('confirm').disabled).toBe(false)
    cardButton('confirm').click()
    await flushPromises()
    expect(decided).toEqual([{ call: '1.3', decision: 'confirm', plain: true }])
    for (const lang of ['en', 'tr'] as const) {
      expect(i18n.global.te('ai.agent.download', lang)).toBe(true)
      expect(i18n.global.te('ai.agent.card.plainPersonal', lang)).toBe(true)
      expect(i18n.global.te('ai.agent.reason.no_plain_offer', lang)).toBe(true)
    }
  })

  it('offers no choice on a card that does not offer it', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'yedekle')
    enter(composer())
    await flushPromises()
    await push([
      { type: 'step', step: { ...PLAIN_BACKUP, proposal: { ...PLAIN_BACKUP.proposal!, plain: undefined } } },
    ])
    expect(card()!.querySelector('[data-agent-format]')).toBeNull()
    expect(card()!.querySelectorAll('input[type="password"]')).toHaveLength(2)
  })

  it('downloads the backup from its step once its job is done, the person’s own', async () => {
    const reports: string[] = []
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        'GET transfer/jobs/j1/report': () => {
          reports.push('j1')
          return [200, { kind: 'dump', backupId: 'b1' }]
        },
      },
    })
    await typeInto(composer(), 'yedekle')
    enter(composer())
    await flushPromises()
    const jobs = useJobsStore()
    const job = { id: 'j1', kind: 'backup.dump', state: 'running', mine: true } as never as JobView
    jobs.upsert(job)
    await push([
      {
        type: 'step',
        step: { ...PLAIN_BACKUP, state: 'done', summary: { started: true, job: 'j1' }, proposal: undefined },
      },
    ])
    const download = () =>
      document.querySelector<HTMLAnchorElement>('[data-agent-step="run_backup"] [data-agent-download]')
    // Running: nothing to download yet.
    expect(download()).toBeNull()
    jobs.upsert({ ...job, state: 'done' })
    await flushPromises()
    expect(download()!.getAttribute('href')).toContain('/api/backups/b1/download')
    expect(download()!.hasAttribute('download')).toBe(true)
    expect(download()!.textContent).toContain('Download')
    // Review (nit 8): which file, by its name for a screen reader.
    expect(download()!.getAttribute('aria-label')).toBe('Download the backup')
    expect(reports).toEqual(['j1'])
  })

  it('offers nothing for a job that failed, or one that is not the person’s', async () => {
    const { push, calls } = await agentPanel({ lines: START })
    await typeInto(composer(), 'yedekle')
    enter(composer())
    await flushPromises()
    const jobs = useJobsStore()
    jobs.upsert({ id: 'j1', kind: 'backup.dump', state: 'failed', mine: true } as never as JobView)
    jobs.upsert({ id: 'j2', kind: 'backup.dump', state: 'done', mine: false } as never as JobView)
    await push([
      {
        type: 'step',
        step: { ...PLAIN_BACKUP, state: 'done', summary: { started: true, job: 'j1' }, proposal: undefined },
      },
      {
        type: 'step',
        step: {
          ...PLAIN_BACKUP,
          id: '1.4',
          state: 'done',
          summary: { started: true, job: 'j2' },
          proposal: undefined,
        },
      },
    ])
    expect(document.querySelector('[data-agent-download]')).toBeNull()
    expect(calls.some((c) => c.path.startsWith('transfer/jobs/'))).toBe(false)
  })

  it('downloads an export’s file from its step while it is kept', async () => {
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        'GET transfer/jobs/j3/report': () => [200, { kind: 'export', expiresAt: Date.now() + 3_600_000 }],
      },
    })
    await typeInto(composer(), 'export')
    enter(composer())
    await flushPromises()
    useJobsStore().upsert({ id: 'j3', kind: 'data.export', state: 'done', mine: true } as never as JobView)
    await push([
      {
        type: 'step',
        step: step({
          id: '1.5',
          tool: 'export_documents',
          state: 'done',
          summary: { started: true, job: 'j3' },
        }),
      },
    ])
    await flushPromises()
    expect(
      document
        .querySelector('[data-agent-step="export_documents"] [data-agent-download]')!
        .getAttribute('href'),
    ).toContain('/api/transfer/files/j3')
  })

  // Review (minor 2): a backup made without a password says so on its step.
  it('says on its step that a backup was made without a password', async () => {
    const { push } = await agentPanel({ lines: START })
    await typeInto(composer(), 'yedekle')
    enter(composer())
    await flushPromises()
    await push([
      {
        type: 'step',
        step: {
          ...PLAIN_BACKUP,
          state: 'done',
          summary: { started: true, format: 'gzip', job: 'j9' },
          proposal: undefined,
        },
      },
      {
        type: 'step',
        step: {
          ...PLAIN_BACKUP,
          id: '1.4',
          state: 'done',
          summary: { started: true, format: 'mmbak', job: 'j8' },
          proposal: undefined,
        },
      },
    ])
    const said = [...document.querySelectorAll('[data-agent-step="run_backup"]')].map((e) => e.textContent)
    expect(said[0]).toContain('Without a password: a compressed archive')
    expect(said[1]).not.toContain('Without a password')
    expect(i18n.global.te('ai.agent.summary.plainBackup', 'tr')).toBe(true)
  })

  // Review (nits 5, 6): only a file's job is asked about; an export's link goes once it expired.
  it('asks nothing of a job that makes no file, and offers no expired export', async () => {
    const { push, calls } = await agentPanel({
      lines: START,
      handlers: {
        'GET transfer/jobs/j5/report': () => [200, { kind: 'export', expiresAt: Date.now() - 1000 }],
      },
    })
    await typeInto(composer(), 'kopyala')
    enter(composer())
    await flushPromises()
    const jobs = useJobsStore()
    jobs.upsert({ id: 'j4', kind: 'data.copy', state: 'done', mine: true } as never as JobView)
    jobs.upsert({ id: 'j5', kind: 'data.export', state: 'done', mine: true } as never as JobView)
    await push([
      {
        type: 'step',
        step: step({
          id: '1.6',
          tool: 'copy_collection',
          state: 'done',
          summary: { started: true, job: 'j4' },
        }),
      },
      {
        type: 'step',
        step: step({
          id: '1.7',
          tool: 'export_documents',
          state: 'done',
          summary: { started: true, job: 'j5' },
        }),
      },
    ])
    await flushPromises()
    expect(calls.some((c) => c.path === 'transfer/jobs/j4/report')).toBe(false)
    expect(calls.some((c) => c.path === 'transfer/jobs/j5/report')).toBe(true)
    expect(document.querySelector('[data-agent-download]')).toBeNull()
  })

  // Review (nit 7): a backup made first offers its file beside the change's own job.
  it('offers the file of a backup made first beside the change’s own job', async () => {
    const { push } = await agentPanel({
      lines: START,
      handlers: { 'GET transfer/jobs/j7/report': () => [200, { kind: 'dump', backupId: 'b7' }] },
    })
    await typeInto(composer(), 'geri yükle')
    enter(composer())
    await flushPromises()
    useJobsStore().upsert({ id: 'j7', kind: 'backup.dump', state: 'done', mine: true } as never as JobView)
    await push([
      {
        type: 'step',
        step: step({
          id: '1.8',
          tool: 'restore_backup',
          state: 'done',
          summary: { started: true, job: 'j6' },
          backup: { state: 'done', job: 'j7' },
        }),
      },
    ])
    await flushPromises()
    const restore = document.querySelector('[data-agent-step="restore_backup"]')!
    expect(restore.querySelector('[data-agent-backup-job]')).not.toBeNull()
    expect(restore.querySelector('[data-agent-download]')!.getAttribute('href')).toContain(
      '/api/backups/b7/download',
    )
  })

  it('takes an export’s link away once its file expires while shown', async () => {
    const { push } = await agentPanel({
      lines: START,
      handlers: {
        'GET transfer/jobs/j10/report': () => [200, { kind: 'export', expiresAt: Date.now() + 1500 }],
      },
    })
    await typeInto(composer(), 'export')
    enter(composer())
    await flushPromises()
    useJobsStore().upsert({ id: 'j10', kind: 'data.export', state: 'done', mine: true } as never as JobView)
    await push([
      {
        type: 'step',
        step: step({
          id: '1.9',
          tool: 'export_documents',
          state: 'done',
          summary: { started: true, job: 'j10' },
        }),
      },
    ])
    await flushPromises()
    expect(document.querySelector('[data-agent-download]')).not.toBeNull()
    await new Promise((r) => setTimeout(r, 1700))
    await flushPromises()
    expect(document.querySelector('[data-agent-download]')).toBeNull()
  })
})
