// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { AiHistoryItem, AiUsage } from '@mongo-manager/shared'
import AiHistoryView from '../src/ai/history/AiHistoryView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useSessionStore } from '../src/stores/session'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { aiHistoryKeys } from '../src/api/aiHistory'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

// A fixed noon, the clock set to it for every test: a run that starts just after midnight saw a job
// of a minute ago under Yesterday (2026-10-24).
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const item = (over: Partial<AiHistoryItem> = {}): AiHistoryItem => ({
  id: '00000000-0000-4000-8000-000000000001',
  at: NOW - 60_000,
  action: 'query',
  chatId: null,
  connectionId: 'c1',
  namespace: 'shop.orders',
  provider: { id: 'p1', name: 'Claude', kind: 'anthropic', model: 'claude-sonnet-5' },
  outcome: 'ok',
  usage: { input: 1200, output: 300 },
  ms: 2400,
  cost: { amount: 0.0081, currency: 'USD' },
  preview: 'orders over 100 paid by card',
  thread: null,
  step: null,
  chain: null,
  ...over,
})
const USAGE: AiUsage = {
  since: NOW - 30 * 86_400_000,
  totals: { requests: 2, input: 1_250_000, output: 300_000, cost: [{ amount: 8.25, currency: 'USD' }] },
  byModel: [
    {
      provider: 'Claude',
      kind: 'anthropic',
      model: 'claude-sonnet-5',
      requests: 2,
      input: 1_250_000,
      output: 300_000,
      cost: [{ amount: 8.25, currency: 'USD' }],
    },
  ],
}

function signIn(admin: boolean): void {
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = {
    mode: 'team',
    user: { id: 'u1', username: 'ada', role: admin ? 'admin' : 'editor' },
    permissions: admin ? ['settings:manage', 'ai:use'] : ['ai:use'],
  } as never
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  signIn(false)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const queries: URLSearchParams[] = []
function api(items: AiHistoryItem[], extra: Parameters<typeof mockApi>[0] = {}) {
  queries.length = 0
  return mockApi({
    'GET ai/history': (_b, url) => {
      queries.push(url.searchParams)
      return [200, { items, next: null }]
    },
    'GET ai/usage': (_b, url) => [
      200,
      url.searchParams.get('all') === '1'
        ? {
            ...USAGE,
            byUser: [{ userId: 'u2', username: 'grace', requests: 5, input: 10, output: 4, cost: [] }],
          }
        : USAGE,
    ],
    'GET ai/history/settings': () => [200, { days: 90, keepContent: true }],
    ...extra,
  })
}
const lines = () => [...document.querySelectorAll('[data-request]')]
/** The button named `text` inside `root`. */
const inside = (root: Element, text: string) => {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`No button "${text}"`)
  return found
}
/** Opens the list's "…" menu and chooses "Delete all"; the entry chosen. */
async function deleteAllFromMenu(): Promise<HTMLElement> {
  document.querySelector<HTMLButtonElement>('[data-history-list] button[aria-label="Actions"]')!.click()
  await flushPromises()
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (m) => m.textContent?.trim() === 'Delete all',
  )!
  entry.click()
  await flushPromises()
  return entry
}

describe('AI history page (user, 2026-10-09: "AI yaptırdığımız işleri nerde görüyoruz")', () => {
  it('sums the requests, tokens and cost, and says how long requests are kept', async () => {
    api([item()])
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.querySelector('[data-usage-requests]')!.textContent).toBe('2')
    expect(document.querySelector('[data-usage-tokens]')!.textContent).toMatch(/1\.6M/)
    expect(document.querySelector('[data-usage-cost]')!.textContent).toBe('$8.25')
    // One card of figures (spec §2), and the models as a named table.
    expect(document.querySelector('[data-usage]')!.tagName).toBe('DL')
    expect(document.querySelector('[data-by-model] table')!.getAttribute('aria-label')).toBe('By model')
    expect(document.querySelector('[data-by-model]')!.textContent).toContain('claude-sonnet-5')
    // One sentence after the other, a space between them.
    expect(document.body.textContent).toContain('Only you can read your requests. Kept for 90 days.')
  })

  it('lists each request by day: the words asked, where, the model, the tokens and the cost', async () => {
    api([
      item(),
      item({ id: '00000000-0000-4000-8000-000000000002', at: NOW - 3 * 86_400_000, cost: null }),
      item({
        id: '00000000-0000-4000-8000-000000000004',
        at: NOW - 3 * 86_400_000,
        cost: { amount: 0.000045, currency: 'USD' },
      }),
    ])
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.querySelectorAll('[data-day]')).toHaveLength(2)
    expect(document.querySelector('[data-day] h4')!.textContent).toBe('Today')
    const first = lines()[0]!.textContent!
    expect(first).toContain('orders over 100 paid by card')
    expect(first).toContain('shop')
    expect(first).toContain('orders')
    expect(first).toContain('claude-sonnet-5')
    expect(first).toContain('1,200 → 300')
    expect(first).toContain('$0.0081')
    // No price, no cost — never a made-up zero.
    expect(lines()[1]!.textContent).not.toContain('$')
    expect(lines()[2]!.textContent).toContain('$0.000045')
  })

  it('opens a request with what was asked and answered, its exact tokens and its cost', async () => {
    const one = item()
    const { calls } = api([one], {
      [`GET ai/history/${one.id}`]: () => [
        200,
        {
          ...one,
          content: {
            prompt: 'orders over 100 paid by card',
            answer: 'Here is the query.\n```json\n{ "filter": { "total": { "$gt": 100 } } }\n```',
            result: { kind: 'query', filter: { total: { $gt: 100 } } },
          },
        },
      ],
    })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    const drawer = document.querySelector('[data-request-details]')!
    expect(drawer.querySelector('[data-request-prompt]')!.textContent).toContain(
      'orders over 100 paid by card',
    )
    // Drawn as the AI panel draws it: the code in a block, no Markdown fences shown.
    const answer = drawer.querySelector('[data-request-answer]')!
    expect(answer.textContent).toContain('Here is the query.')
    expect(answer.querySelector('pre')!.textContent).toContain('"$gt": 100')
    expect(answer.textContent).not.toContain('```')
    expect(drawer.querySelector('[data-request-tokens]')!.textContent).toContain(
      '1,200 in · 300 out · 1,500 in all',
    )
    expect(drawer.querySelector('[data-request-cost]')!.textContent).toBe('$0.0081')
    expect(drawer.textContent).toContain('$gt')
    expect(calls.some((c) => c.path === `ai/history/${one.id}`)).toBe(true)
    // Its query opens in its collection.
    button('Open in its collection').click()
    await flushPromises()
    const tabs = useTabsStore()
    expect(tabs.active).toMatchObject({
      kind: 'collection',
      params: { connectionId: 'c1', db: 'shop', coll: 'orders' },
    })
  })

  it('writes the time taken in the reader’s language (Turkish: a decimal comma)', async () => {
    i18n.global.locale.value = 'tr'
    const one = item()
    api([one], { [`GET ai/history/${one.id}`]: () => [200, { ...one, content: null }] })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-request-details]')!.textContent).toContain('2,4 sn')
  })

  it('says when the words were not kept, instead of an empty request', async () => {
    const one = item({ preview: null })
    api([one], { [`GET ai/history/${one.id}`]: () => [200, { ...one, content: null }] })
    mountApp(AiHistoryView)
    await flushPromises()
    expect(lines()[0]!.textContent).toContain('Words not kept')
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-request-details]')!.textContent).toContain(
      'What was asked and answered was not kept for this request.',
    )
    expect(document.body.textContent).not.toContain('Open in its collection')
  })

  it('shows a "needs a pipeline" answer as answered, and a refusal as failed', async () => {
    api([
      item({ outcome: 'needs_pipeline' }),
      item({ id: '00000000-0000-4000-8000-000000000003', outcome: 'key_refused' }),
    ])
    mountApp(AiHistoryView)
    await flushPromises()
    expect(lines()[0]!.querySelector('.text-danger')).toBeNull()
    expect(lines()[1]!.querySelector('.text-danger')).not.toBeNull()
  })

  it('filters by outcome and kind, and searches the words', async () => {
    api([item()])
    mountApp(AiHistoryView)
    await flushPromises()
    button('Failed').click()
    await flushPromises()
    expect(queries.at(-1)!.get('outcome')).toBe('failed')
    const kind = byLabel<HTMLSelectElement>('Kind')
    kind.value = 'chat'
    kind.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(queries.at(-1)!.get('action')).toBe('chat')
    await typeInto(byLabel('Search what was asked and answered'), 'card')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(queries.at(-1)!.get('q')).toBe('card')
    button('Clear filters').click()
    await flushPromises()
    expect([...queries.at(-1)!.keys()].sort()).toEqual(['limit'])
  })

  it('deletes one request, or all of them, after asking', async () => {
    const one = item()
    const { calls } = api([one], {
      [`GET ai/history/${one.id}`]: () => [200, { ...one, content: null }],
      [`DELETE ai/history/${one.id}`]: () => [204],
      'DELETE ai/history': () => [204],
    })
    mountApp(AiHistoryView)
    mountApp(DialogHost)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    inside(document.querySelector('[data-request-details]')!, 'Delete').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    inside(document.querySelector('[role="dialog"]')!, 'Delete').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `ai/history/${one.id}`)).toBe(true)
    await deleteAllFromMenu()
    inside(document.querySelector('[role="dialog"]')!, 'Delete all').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'ai/history')).toBe(true)
  })

  // UI redesign R2–R5 spec §2: a destructive action lives in the "…" menu, as a danger item, confirmed.
  it('keeps "Delete all" in the list’s menu, not as a button, and asks before deleting', async () => {
    const { calls } = api([item()], { 'DELETE ai/history': () => [204] })
    mountApp(AiHistoryView)
    mountApp(DialogHost)
    await flushPromises()
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete all')).toBe(
      false,
    )
    const entry = await deleteAllFromMenu()
    expect(entry.className).toContain('text-danger')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    inside(document.querySelector('[role="dialog"]')!, 'Delete all').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === 'ai/history')).toBe(true)
  })

  it('offers no "Delete all" while the list is filtered', async () => {
    api([item()])
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.querySelector('[data-history-list] button[aria-label="Actions"]')).not.toBeNull()
    button('Failed').click()
    await flushPromises()
    expect(document.querySelector('[data-history-list] button[aria-label="Actions"]')).toBeNull()
  })

  it('offers everyone’s usage to an administrator only, by user and never with words', async () => {
    api([item()])
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.body.textContent).not.toContain('Everyone’s usage')
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    signIn(true)
    api([item()])
    mountApp(AiHistoryView)
    await flushPromises()
    byLabel<HTMLInputElement>('Everyone’s usage').click()
    await flushPromises()
    const byUser = document.querySelector('[data-by-user]')!
    expect(byUser.textContent).toContain('grace')
    expect(byUser.textContent).toContain('No price set')
  })

  it('says when no price is set, and shows an administrator where to set one', async () => {
    const unpriced = { ...USAGE, totals: { ...USAGE.totals, cost: [] } }
    api([item({ cost: null })], { 'GET ai/usage': () => [200, unpriced] })
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.querySelector('[data-usage-cost]')!.textContent).toBe('—')
    expect(document.body.textContent).toContain('Cost · no price set')
    expect(document.querySelector('[data-set-prices]')).toBeNull()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    signIn(true)
    api([item({ cost: null })], { 'GET ai/usage': () => [200, unpriced] })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(document.querySelector('[data-set-prices]') as HTMLButtonElement).click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({ kind: 'aiSettings' })
  })

  it('never lets a slower answer for an earlier filter replace the newer list', async () => {
    let releaseSlow: (() => void) | undefined
    mockApi({
      'GET ai/history': async (_b, url) => {
        if (url.searchParams.get('q') === 'ab') {
          await new Promise<void>((r) => (releaseSlow = r))
          return [200, { items: [item({ preview: 'old search' })], next: 'stale' }]
        }
        return [200, { items: [item({ preview: 'everything' })], next: null }]
      },
      'GET ai/usage': () => [200, USAGE],
      'GET ai/history/settings': () => [200, { days: 90, keepContent: true }],
    })
    mountApp(AiHistoryView)
    await flushPromises()
    await typeInto(byLabel('Search what was asked and answered'), 'ab')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    await typeInto(byLabel('Search what was asked and answered'), '')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    releaseSlow!()
    await flushPromises()
    expect(lines().map((l) => l.textContent)).toEqual([expect.stringContaining('everything')])
    expect(document.body.textContent).not.toContain('Show more')
  })

  it('offers to search older requests when a search stopped early', async () => {
    api([item()], {
      'GET ai/history': (_b, url) => [
        200,
        { items: url.searchParams.get('q') ? [] : [item()], next: url.searchParams.get('q') ? '5:9' : null },
      ],
    })
    mountApp(AiHistoryView)
    await flushPromises()
    await typeInto(byLabel('Search what was asked and answered'), 'old')
    await new Promise((r) => setTimeout(r, 300))
    await flushPromises()
    expect(button('Search older requests')).toBeTruthy()
  })

  // User report 2026-10-25: an agent turn's steps — the changes it proposed among them — shown with
  // its request, as its chat shows them; a place opens where it is.
  it('shows what an agent turn did, step by step, with the request', async () => {
    const one = item({ action: 'chat', chatId: 'chat1', connectionId: null, namespace: null })
    api([one], {
      'GET connections': () => [
        200,
        [
          { id: 'c1', name: 'Sales Mongo', settings: { hosts: [] } },
          // One a person signs in to: its sign-in is the live chat's, never a record's.
          { id: 'c2', name: 'Sso', settings: { hosts: [], auth: { mechanism: 'MONGODB-OIDC', oidc: {} } } },
        ],
      ],
      [`GET ai/history/${one.id}`]: () => [
        200,
        {
          ...one,
          content: {
            prompt: 'add a users collection and a demo user',
            answer: 'Done.',
            steps: [
              {
                tool: 'create_collection',
                connectionId: 'c1',
                namespace: 'sales.users',
                state: 'done',
                sent: 'outcome',
              },
              {
                tool: 'insert_documents',
                connectionId: 'c1',
                namespace: 'sales.users',
                state: 'done',
                summary: { inserted: 1 },
              },
              { tool: 'drop_collection', connectionId: 'gone', namespace: 'sales.old', state: 'declined' },
              { tool: 'drop_collection', connectionId: 'c1', namespace: 'sales.tmp', state: 'done' },
              {
                tool: 'check_connection',
                connectionId: 'c2',
                namespace: 'sso',
                state: 'done',
                summary: { connected: false, problem: 'oidc', job: '0b5c3e3a-1111-4111-8111-000000000001' },
              },
              {
                tool: 'create_collection',
                connectionId: 'c1',
                namespace: 'sales.x',
                state: 'refused',
                reason: 'read_only',
              },
              { tool: 'create_collection', connectionId: 'c1', namespace: 'sales.never', state: 'declined' },
              {
                tool: 'list_collections',
                connectionId: 'gone',
                namespace: 'old',
                state: 'done',
                summary: { collections: 2 },
              },
              {
                tool: 'create_backup_schedule',
                connectionId: 'c1',
                namespace: null,
                state: 'refused',
                reason: 'no_destination',
              },
            ],
          },
        },
      ],
    })
    const tabs = useTabsStore()
    tabs.open({ kind: 'aiHistory', title: '' })
    mountApp(AiHistoryView)
    await flushPromises()
    lines()[0]!.querySelector('button')!.click()
    await flushPromises()
    const steps = document.querySelector('[data-request-steps]')!
    expect(steps.textContent).toContain('What the agent did')
    const shown = [...steps.querySelectorAll('[data-agent-step]')]
    expect(shown.map((s) => s.getAttribute('data-agent-step'))).toEqual([
      'create_collection',
      'insert_documents',
      'drop_collection',
      'drop_collection',
      'check_connection',
      'create_collection',
      'create_collection',
      'list_collections',
      'create_backup_schedule',
    ])
    // Before the answer, as the chat draws them (N6).
    expect(steps.compareDocumentPosition(document.querySelector('[data-request-answer]')!) & 4).toBe(4)
    // A page of what happened: no sign-in, no job, nothing to open that is gone or never was (M2, M3).
    expect(
      steps.querySelector('[data-agent-sign-in], [data-agent-job], [data-agent-destinations]'),
    ).toBeNull()
    expect(shown[2]!.querySelector('[data-agent-open]')).toBeNull()
    expect(shown[3]!.querySelector('[data-agent-open]')).toBeNull()
    // A change declined left nothing to open; nor a place on a connection not listed (M-c).
    expect(shown[6]!.querySelector('[data-agent-open]')).toBeNull()
    expect(shown[7]!.querySelector('[data-agent-open]')).toBeNull()
    // Why, without what to do about it now (no destinations button, no advice to add one).
    expect(shown[8]!.textContent).not.toMatch(/Add one|administrator/)
    // Why it ended so (M4).
    expect(shown[5]!.textContent).toContain('read-only')
    expect(shown[0]!.textContent).toContain('Sales Mongo · sales.users')
    expect(shown[1]!.textContent).toContain('Inserted 1 document')
    // A connection not in the list is said so, never by its id.
    expect(shown[2]!.textContent).toContain('A connection not in your list')
    expect(shown[2]!.textContent).not.toContain('gone')
    shown[0]!.querySelector<HTMLButtonElement>('[data-agent-open]')!.click()
    await flushPromises()
    expect(tabs.active).toMatchObject({ kind: 'collection', params: { db: 'sales', coll: 'users' } })
  })

  it('opens a request as a page in the tab, with one scroll, and goes back to the list where it was', async () => {
    const one = item()
    api([one], {
      [`GET ai/history/${one.id}`]: () => [
        200,
        { ...one, content: { prompt: 'p', answer: 'a', samples: 3 } },
      ],
    })
    mountApp(AiHistoryView)
    await flushPromises()
    const line = lines()[0]!.querySelector('button')!
    line.click()
    await flushPromises()
    // User, 2026-10-09: "yandan drawer olarak açma, iç sayfa olarak aç" — no drawer, no list behind it.
    expect(document.querySelector('[data-request-drawer]')).toBeNull()
    const page = document.querySelector<HTMLElement>('[data-request-page]')!
    expect(page).not.toBeNull()
    expect((document.querySelector('[data-history-list]') as HTMLElement).style.display).toBe('none')
    // Its heading takes the focus, so a screen reader hears where it is.
    expect(document.activeElement).toBe(page.querySelector('h2'))
    // Nothing inside scrolls on its own: the page does.
    expect(page.querySelectorAll('.max-h-96, .max-h-48')).toHaveLength(0)
    expect(document.querySelector('[data-request-samples]')!.textContent).toContain(
      '3 sample documents went to the provider; their values are not kept.',
    )
    inside(page, 'AI history').click()
    await flushPromises()
    expect(document.querySelector('[data-request-page]')).toBeNull()
    expect((document.querySelector('[data-history-list]') as HTMLElement).style.display).toBe('')
    expect(document.activeElement).toBe(lines()[0]!.querySelector('button'))
    // Escape goes back too.
    lines()[0]!.querySelector('button')!.click()
    await flushPromises()
    document
      .querySelector('[data-request-page]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-request-page]')).toBeNull()
  })

  it('reloads the list when the history changes elsewhere (a price entered prices old requests)', async () => {
    api([item()])
    const { queryClient } = mountApp(AiHistoryView)
    await flushPromises()
    const before = queries.length
    await queryClient.invalidateQueries({ queryKey: aiHistoryKeys.all })
    await flushPromises()
    expect(queries.length).toBe(before + 1)
  })

  it('keeps the pages read and the request open when the history is counted again', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, preview: `request ${i}` }),
    )
    queries.length = 0
    mockApi({
      'GET ai/history': (_b, url) => {
        queries.push(url.searchParams)
        const limit = Number(url.searchParams.get('limit'))
        const from = url.searchParams.get('before') ? 50 : 0
        // Counted again, the 60th request is no longer among those listed.
        const list = url.searchParams.get('before') || limit === 50 ? many : many.slice(0, 59)
        const page = list.slice(from, from + limit)
        return [200, { items: page, next: from + limit < list.length ? '9:9' : null }]
      },
      [`GET ai/history/${many[59]!.id}`]: () => [200, { ...many[59], content: null }],
      'GET ai/usage': () => [200, USAGE],
      'GET ai/history/settings': () => [200, { days: 90, keepContent: true }],
    })
    const { queryClient } = mountApp(AiHistoryView)
    await flushPromises()
    button('Show more').click()
    await flushPromises()
    expect(lines()).toHaveLength(60)
    ;(lines()[59]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    await queryClient.invalidateQueries({ queryKey: aiHistoryKeys.all })
    await flushPromises()
    expect(queries.at(-1)!.get('limit')).toBe('60')
    // The request open stays open though the page read again no longer holds it.
    expect(document.querySelector('[data-request-page]')).not.toBeNull()
  })

  it('opens the request a link names, straight away (user: "url ai-history/istekId olsun")', async () => {
    const one = item()
    api([], {
      [`GET ai/history/${one.id}`]: () => [200, { ...one, content: { prompt: 'linked words', answer: 'a' } }],
    })
    mountApp(AiHistoryView, { props: { requestId: one.id } })
    await flushPromises()
    expect(document.querySelector('[data-request-page] [data-request-prompt]')!.textContent).toContain(
      'linked words',
    )
  })

  it('says a linked request is not there — deleted, past its days, or another person’s — and nothing more', async () => {
    const id = '00000000-0000-4000-8000-0000000000ee'
    api([item()], {
      [`GET ai/history/${id}`]: () => [404, { code: 'NOT_FOUND', message: 'Request not found' }],
    })
    mountApp(AiHistoryView, { props: { requestId: id } })
    await flushPromises()
    const page = document.querySelector('[data-request-page]')!
    expect(page.querySelector('[data-request-missing]')!.textContent).toContain(
      'This request cannot be shown',
    )
    inside(page, 'AI history').click()
    await flushPromises()
    expect(lines()).toHaveLength(1)
  })

  it('puts the request opened in the tab (and so in the URL), and takes it out on going back', async () => {
    const one = item()
    api([one], { [`GET ai/history/${one.id}`]: () => [200, { ...one, content: null }] })
    const tabs = useTabsStore()
    const id = tabs.open({ kind: 'aiHistory', title: '' })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    expect(tabs.active).toMatchObject({ id, params: { requestId: one.id } })
    inside(document.querySelector('[data-request-page]')!, 'AI history').click()
    await flushPromises()
    expect(tabs.active?.params).toEqual({})
  })

  it('shows where a request was asked, plainly: its connection, database and collection', async () => {
    api([item()], { 'GET connections': () => [200, [{ id: 'c1', name: 'Production' }]] })
    mountApp(AiHistoryView)
    await flushPromises()
    const where = lines()[0]!.querySelector('[data-namespace]')!
    expect(where.textContent).toContain('shop')
    expect(where.textContent).toContain('orders')
  })

  it('never shows the request opened before while the next one is read, and focuses the next one', async () => {
    const a = item({ id: '00000000-0000-4000-8000-0000000000a1', preview: 'request A' })
    const c = item({ id: '00000000-0000-4000-8000-0000000000c1', preview: 'request C' })
    let releaseC: (() => void) | undefined
    api([a, c], {
      [`GET ai/history/${a.id}`]: () => [200, { ...a, content: { prompt: 'words of A', answer: '' } }],
      [`GET ai/history/${c.id}`]: async () => {
        await new Promise<void>((r) => (releaseC = r))
        return [200, { ...c, action: 'pipeline', content: { prompt: 'words of C', answer: '' } }]
      },
    })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    inside(document.querySelector('[data-request-page]')!, 'AI history').click()
    await flushPromises()
    ;(lines()[1]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    const page = document.querySelector('[data-request-page]')!
    expect(page.textContent).not.toContain('words of A')
    expect(page.querySelector('[data-request-details]')).toBeNull()
    releaseC!()
    await flushPromises()
    await flushPromises()
    expect(page.textContent).toContain('words of C')
    expect(document.activeElement?.textContent).toContain('Pipeline')
  })

  it('says a missing request at once, without trying again', async () => {
    const id = '00000000-0000-4000-8000-0000000000ef'
    const { calls } = api([], {
      [`GET ai/history/${id}`]: () => [404, { code: 'NOT_FOUND', message: 'Request not found' }],
    })
    mountApp(AiHistoryView, { props: { requestId: id } })
    await flushPromises()
    expect(document.querySelector('[data-request-missing]')).not.toBeNull()
    expect(calls.filter((x) => x.path === `ai/history/${id}`)).toHaveLength(1)
  })

  it('returns the focus to the list from a missing request, and after deleting', async () => {
    const id = '00000000-0000-4000-8000-0000000000ee'
    const one = item()
    api([one], {
      [`GET ai/history/${id}`]: () => [404, { code: 'NOT_FOUND', message: 'Request not found' }],
      [`GET ai/history/${one.id}`]: () => [200, { ...one, content: null }],
      [`DELETE ai/history/${one.id}`]: () => [204],
    })
    mountApp(AiHistoryView, { props: { requestId: id } })
    mountApp(DialogHost)
    await flushPromises()
    inside(document.querySelector('[data-request-page]')!, 'AI history').click()
    await flushPromises()
    expect(document.activeElement?.id).toBe('ai-history-requests')
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    inside(document.querySelector('[data-request-details]')!, 'Delete').click()
    await flushPromises()
    inside(document.querySelector('[role="dialog"]')!, 'Delete').click()
    await flushPromises()
    await flushPromises()
    expect(document.activeElement?.id).toBe('ai-history-requests')
  })

  it('reads the place out in order, and offers to open the collection only on a connection still there', async () => {
    const one = item()
    api([one], {
      [`GET ai/history/${one.id}`]: () => [200, { ...one, content: null }],
      'GET connections': () => [200, []],
    })
    mountApp(AiHistoryView, { props: { requestId: one.id } })
    await flushPromises()
    const place = document.querySelector('[data-request-place]')!
    expect(place.querySelector('[data-namespace]')!.textContent!.replace(/\s+/g, ' ')).toContain(
      'shop › orders',
    )
    expect(place.textContent).not.toContain('Open the collection')
    expect(document.querySelector('[data-request-page] nav')!.getAttribute('aria-label')).toBe(
      'Back to AI history',
    )
  })

  it('says when the collection asked of is no longer there, and offers to open it no more', async () => {
    const one = item()
    api([one], {
      [`GET ai/history/${one.id}`]: () => [
        200,
        { ...one, content: { prompt: 'p', answer: 'a', result: { kind: 'query', filter: {} } } },
      ],
      'GET connections': () => [200, [{ id: 'c1', name: 'Production' }]],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [{ name: 'customers', type: 'collection' }],
      ],
    })
    mountApp(AiHistoryView, { props: { requestId: one.id } })
    await flushPromises()
    await flushPromises()
    const page = document.querySelector('[data-request-page]')!
    expect(page.querySelector('[data-place-gone]')!.textContent).toContain(
      'This collection is no longer there',
    )
    expect(page.textContent).not.toContain('Open the collection')
    expect(page.textContent).not.toContain('Open in its collection')
    // The request itself is all there.
    expect(page.querySelector('[data-request-prompt]')!.textContent).toContain('p')
  })

  it('says when the connection asked on is no longer there', async () => {
    const one = item()
    api([one], {
      [`GET ai/history/${one.id}`]: () => [
        200,
        { ...one, content: { prompt: 'p', answer: 'a', result: { kind: 'query', filter: {} } } },
      ],
      'GET connections': () => [200, []],
    })
    mountApp(AiHistoryView, { props: { requestId: one.id } })
    await flushPromises()
    await flushPromises()
    const page = document.querySelector('[data-request-page]')!
    expect(page.querySelector('[data-place-gone]')!.textContent).toContain(
      'This connection is no longer there',
    )
    expect(page.textContent).not.toContain('Open in its collection')
  })

  it('says there is nothing yet, and nothing matching', async () => {
    api([])
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.body.textContent).toContain('No AI request yet')
    button('Failed').click()
    await flushPromises()
    expect(document.body.textContent).toContain('No request matches these filters.')
  })

  it('says the requests could not be read, and reads them again on Retry', async () => {
    let fail = true
    api([], {
      'GET ai/history': (_b, url) => {
        queries.push(url.searchParams)
        return fail ? [500, { code: 'INTERNAL', message: 'boom' }] : [200, { items: [item()], next: null }]
      },
    })
    mountApp(AiHistoryView)
    await flushPromises()
    expect(document.querySelector('[data-history-list] [role="alert"]')).not.toBeNull()
    fail = false
    button('Retry').click()
    await flushPromises()
    expect(document.querySelector('[data-history-list] [role="alert"]')).toBeNull()
    expect(lines()).toHaveLength(1)
  })
})

describe('AI history chains (user, 2026-10-09: "düzeltmeler ilk işleme bağlı görünsün")', () => {
  const T = '6f1d3c1e-1111-4a5b-9c9d-0000000000c1'
  const step = (n: number, prompt: string, over: Partial<AiHistoryItem> = {}) =>
    item({
      id: `00000000-0000-4000-8000-0000000001${n}0`,
      action: 'pipeline',
      thread: T,
      step: n,
      at: NOW - (4 - n) * 60_000,
      preview: prompt,
      usage: { input: 1000 * n, output: 100 * n },
      cost: { amount: 0.01 * n, currency: 'USD' },
      ...over,
    })
  const head = step(1, 'paid orders by city', {
    chain: {
      steps: 3,
      at: NOW - 60_000,
      usage: { input: 6000, output: 600 },
      ms: 9000,
      cost: [{ amount: 0.06, currency: 'USD' }],
      outcome: 'ok',
      latest: '00000000-0000-4000-8000-000000000130',
    },
  })
  const pipeline = (n: number) => ({ kind: 'pipeline', stages: [{ $limit: n }] })
  const steps = [
    {
      ...step(1, 'paid orders by city'),
      content: { prompt: 'paid orders by city', answer: 'one', result: pipeline(1) },
    },
    { ...step(2, 'only Istanbul'), content: { prompt: 'only Istanbul', answer: 'two', result: pipeline(2) } },
    {
      ...step(3, 'sort by total'),
      content: { prompt: 'sort by total', answer: 'three', result: pipeline(3) },
    },
  ]
  /** Each step read alone (a link to it) comes with its chain's sums. */
  const byId = (list = steps, chain: AiHistoryItem['chain'] = head.chain) =>
    Object.fromEntries(
      list.map((s) => [`GET ai/history/${s.id}`, () => [200, { ...s, chain }] as [number, unknown]]),
    )
  const withThread = (extra: Parameters<typeof mockApi>[0] = {}) =>
    api([head], { [`GET ai/history/threads/${T}`]: () => [200, { steps }], ...byId(), ...extra })

  it('shows a pipeline and its refinements as one line, with the chain’s tokens and cost', async () => {
    withThread()
    mountApp(AiHistoryView)
    await flushPromises()
    const line = lines()[0]!.textContent!
    expect(line).toContain('paid orders by city')
    expect(line).toContain('2 refinements')
    expect(line).toContain('6,000 → 600')
    expect(line).toContain('$0.06')
  })

  it('files a chain under the day of its latest step, where its order puts it', async () => {
    api([
      { ...head, at: NOW - 3 * 86_400_000 },
      item({ id: '00000000-0000-4000-8000-0000000000f1', at: NOW - 2 * 86_400_000 }),
    ])
    mountApp(AiHistoryView)
    await flushPromises()
    const days = [...document.querySelectorAll('[data-day]')]
    expect(days[0]!.querySelector('h4')!.textContent).toBe('Today')
    expect(days[0]!.textContent).toContain('paid orders by city')
    expect(days).toHaveLength(2)
  })

  it('opens the chain: every step in order, the latest shown, the totals, and the latest pipeline', async () => {
    withThread()
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    const drawer = document.querySelector('[data-chain-details]')!
    // The steps, as a list to choose from; the latest is shown, its words beside the list.
    const items = [...drawer.querySelectorAll<HTMLButtonElement>('[data-chain-step]')]
    expect(items.map((s) => s.textContent)).toEqual([
      expect.stringContaining('First request'),
      expect.stringContaining('Refinement 1'),
      expect.stringContaining('Refinement 2'),
    ])
    expect(items.map((s) => s.getAttribute('aria-current'))).toEqual([null, null, 'step'])
    const shown = () => drawer.querySelector('[data-chain-shown]')!
    expect(shown().querySelector('[data-request-prompt]')!.textContent).toContain('sort by total')
    expect(drawer.querySelectorAll('[data-request-prompt]')).toHaveLength(1)
    items[0]!.click()
    await flushPromises()
    expect(items[0]!.getAttribute('aria-current')).toBe('step')
    expect(shown().querySelector('[data-request-prompt]')!.textContent).toContain('paid orders by city')
    // What it wrote has its own heading, apart from the answer.
    expect(shown().querySelector('[data-request-result] h4')!.textContent!.trim()).toBe('What it wrote')
    expect(drawer.querySelector('[data-chain-tokens]')!.textContent).toContain('6,000 in · 600 out')
    // The page says the chain once, and its day once.
    expect(drawer.querySelector('h2')!.textContent!.trim()).toBe('Pipeline and its refinements')
    const when = drawer.querySelector('[data-chain-when]')!.textContent!
    const day = (ms: number) => new Date(ms).toLocaleDateString('en', { dateStyle: 'medium' })
    // The latest day is said once; both steps fall on it (noon), so the day comes once before both times.
    expect(when.split(day(NOW - 60_000))).toHaveLength(2)
    expect(when).toMatch(/^[^,]+, \d{4}, .+ – .+$/)
    expect(drawer.querySelector('[data-chain-cost]')!.textContent).toBe('$0.06')
    inside(drawer, 'Open the latest pipeline').click()
    await flushPromises()
    expect(useTabsStore().active).toMatchObject({
      kind: 'collection',
      params: { db: 'shop', coll: 'orders' },
    })
  })

  it('opens a chain on its latest step, and puts each step chosen in the URL', async () => {
    withThread()
    const tabs = useTabsStore()
    tabs.open({ kind: 'aiHistory', title: '' })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    expect(tabs.active?.params).toEqual({ requestId: steps[2]!.id })
    document.querySelectorAll<HTMLButtonElement>('[data-chain-step]')[0]!.click()
    // The step chosen is marked at once, before it is read.
    await nextTick()
    expect(document.querySelectorAll('[data-chain-step]')[0]!.getAttribute('aria-current')).toBe('step')
    await flushPromises()
    expect(tabs.active?.params).toEqual({ requestId: steps[0]!.id })
    expect(document.querySelector('[data-chain-shown] [data-request-prompt]')!.textContent).toContain(
      'paid orders by city',
    )
  })

  it('deletes a step, or the whole chain, after asking', async () => {
    const { calls } = withThread({
      [`DELETE ai/history/${steps[1]!.id}`]: () => [204],
      [`DELETE ai/history/threads/${T}`]: () => [204],
    })
    mountApp(AiHistoryView)
    mountApp(DialogHost)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    const drawer = document.querySelector('[data-chain-details]')!
    drawer.querySelectorAll<HTMLButtonElement>('[data-chain-step]')[1]!.click()
    await flushPromises()
    inside(drawer.querySelector('[data-chain-shown]')!, 'Delete this step').click()
    await flushPromises()
    inside(document.querySelector('[role="dialog"]')!, 'Delete').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `ai/history/${steps[1]!.id}`)).toBe(true)
    inside(document.querySelector('[data-chain-details]')!, 'Delete the chain').click()
    await flushPromises()
    inside(document.querySelector('[role="dialog"]')!, 'Delete the chain').click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `ai/history/threads/${T}`)).toBe(true)
  })

  it('follows the chain when its first step is deleted, down to the one request left', async () => {
    let deleted = false
    const left = { ...steps[1]!, chain: null, content: undefined }
    mockApi({
      'GET ai/history': () => [200, { items: deleted ? [left] : [head], next: null }],
      [`GET ai/history/threads/${T}`]: () => [200, { steps: deleted ? [steps[1]] : steps.slice(0, 2) }],
      ...Object.fromEntries(
        steps.map((s) => [
          `GET ai/history/${s.id}`,
          () => [200, deleted ? { ...s, chain: null } : { ...s, chain: head.chain }] as [number, unknown],
        ]),
      ),
      [`DELETE ai/history/${steps[0]!.id}`]: () => {
        deleted = true
        return [204]
      },
      'GET ai/usage': () => [200, USAGE],
      'GET ai/history/settings': () => [200, { days: 90, keepContent: true }],
    })
    mountApp(AiHistoryView)
    mountApp(DialogHost)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    document.querySelectorAll<HTMLButtonElement>('[data-chain-step]')[0]!.click()
    await flushPromises()
    inside(document.querySelector('[data-chain-shown]')!, 'Delete this step').click()
    await flushPromises()
    inside(document.querySelector('[role="dialog"]')!, 'Delete').click()
    await flushPromises()
    await flushPromises()
    // One request left: the page shows it as a request, not a chain.
    expect(document.querySelector('[data-chain-details]')).toBeNull()
    expect(document.querySelector('[data-request-details] [data-request-prompt]')!.textContent).toContain(
      'only Istanbul',
    )
  })
})

// User reports 2026-10-25: a chat is one entry, its turns — plain ones and the agent's — all shown.
describe('a chat in the AI history', () => {
  const C = '7a2e4d2f-2222-4b6c-8d0e-0000000000d1'
  const turn = (n: number, prompt: string, over: Partial<AiHistoryItem> = {}) =>
    item({
      id: `00000000-0000-4000-8000-0000000002${n}0`,
      action: 'chat',
      chatId: C,
      connectionId: null,
      namespace: null,
      thread: C,
      step: n,
      at: NOW - (4 - n) * 60_000,
      preview: prompt,
      ...over,
    })
  const head = turn(1, 'hello', {
    chain: {
      steps: 3,
      at: NOW - 60_000,
      usage: { input: 30, output: 9 },
      ms: 900,
      cost: [],
      outcome: 'ok',
      latest: '00000000-0000-4000-8000-000000000230',
    },
  })
  const turns = [
    { ...turn(1, 'hello'), content: { prompt: 'hello', answer: 'Hello.' } },
    { ...turn(2, 'add a user'), content: { prompt: 'add a user', answer: 'The agent does it.' } },
    {
      ...turn(3, 'add a user'),
      content: {
        prompt: 'add a user',
        answer: 'Added.',
        steps: [{ tool: 'insert_documents', connectionId: 'c1', namespace: 'sales.users', state: 'done' }],
      },
    },
  ]
  const chatApi = () =>
    api([head], {
      [`GET ai/history/threads/${C}`]: () => [200, { steps: turns }],
      'GET connections': () => [200, [{ id: 'c1', name: 'Sales Mongo', settings: { hosts: [] } }]],
      ...Object.fromEntries(
        turns.map((t) => [
          `GET ai/history/${t.id}`,
          () => [200, { ...t, chain: head.chain }] as [number, unknown],
        ]),
      ),
    })

  it('lists a chat as one line, by its turns', async () => {
    chatApi()
    mountApp(AiHistoryView)
    await flushPromises()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]!.textContent).toContain('3 turns')
  })

  it('shows every turn of the chat at once, the agent’s steps with its, and opens the chat', async () => {
    chatApi()
    const tabs = useTabsStore()
    tabs.open({ kind: 'aiHistory', title: '' })
    mountApp(AiHistoryView)
    await flushPromises()
    ;(lines()[0]!.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    const page = document.querySelector('[data-chain-details]')!
    expect(page.querySelector('h2')!.textContent).toContain('Chat')
    const shown = [...page.querySelectorAll('[data-chat-turn]')]
    expect(shown.map((t) => t.querySelector('[data-request-prompt]')!.textContent!.trim())).toEqual([
      'hello',
      'add a user',
      'add a user',
    ])
    expect(shown[2]!.querySelector('[data-agent-step="insert_documents"]')).not.toBeNull()
    const open = [...page.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Open the chat'),
    )!
    expect(open).toBeTruthy()
  })
})
