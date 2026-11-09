// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AiHistoryItem, AiUsage } from '@mongo-manager/shared'
import AiHistoryView from '../src/ai/history/AiHistoryView.vue'
import { useSessionStore } from '../src/stores/session'
import { useToastStore } from '../src/stores/toasts'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

const NOW = Date.now()
const ID = '00000000-0000-4000-8000-000000000001'
const THREAD = '00000000-0000-4000-8000-0000000000f1'
const item = (over: Partial<AiHistoryItem> = {}): AiHistoryItem => ({
  id: ID,
  at: NOW - 60_000,
  action: 'query',
  chatId: null,
  connectionId: 'c1',
  namespace: 'shop.orders',
  provider: { id: 'p1', name: 'Claude', kind: 'anthropic', model: 'claude-sonnet-5' },
  outcome: 'ok',
  usage: { input: 1200, output: 300 },
  ms: 2400,
  cost: null,
  preview: 'orders over 100 paid by card',
  thread: null,
  step: null,
  chain: null,
  mine: true,
  shared: false,
  sharedBy: null,
  ...over,
})
const USAGE: AiUsage = {
  since: NOW - 30 * 86_400_000,
  totals: { requests: 0, input: 0, output: 0, cost: [] },
  byModel: [],
}
const CONTENT = { prompt: 'orders over 100 paid by card', answer: 'Here it is.' }

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  const session = useSessionStore()
  session.status = { mode: 'team' } as never
  session.me = {
    mode: 'team',
    user: { id: 'u1', username: 'bob', role: 'editor' },
    permissions: ['ai:use'],
  } as never
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function api(opts: {
  available?: boolean
  items?: AiHistoryItem[]
  shared?: AiHistoryItem[]
  open?: AiHistoryItem
}) {
  const asked: URLSearchParams[] = []
  let current = opts.open
  const r = mockApi({
    'GET ai/history': (_b, url) => {
      asked.push(url.searchParams)
      return [
        200,
        {
          items: url.searchParams.get('shared') === '1' ? (opts.shared ?? []) : (opts.items ?? []),
          next: null,
        },
      ]
    },
    'GET ai/usage': () => [200, USAGE],
    'GET ai/history/settings': () => [200, { days: 90, keepContent: true }],
    'GET ai/history/sharing': () => [200, { available: opts.available ?? true }],
    ...(current
      ? {
          [`GET ai/history/${current.id}`]: () => [200, { ...current, content: CONTENT }],
          [`GET ai/history/${current.id}/chain`]: () => [200, { steps: [{ ...current, content: CONTENT }] }],
          [`POST ai/history/${current.id}/share`]: () => {
            current = { ...current!, shared: true }
            return [200, { shared: true }]
          },
          [`DELETE ai/history/${current.id}/share`]: () => {
            current = { ...current!, shared: false }
            return [200, { shared: false }]
          },
        }
      : {}),
  })
  return { ...r, asked }
}
const inside = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null
const page = () => document.querySelector('[data-request-page]')!

describe('sharing an AI request with the team (user review 2026-10-09)', () => {
  it('lets the owner share a request, copy its link and take the share back', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { calls } = api({ open: item() })
    mountApp(AiHistoryView, { props: { requestId: ID } })
    await flushPromises()
    inside(page(), 'Share with the team')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === `ai/history/${ID}/share`)).toBe(true)
    expect(page().querySelector('[data-request-shared]')!.textContent).toContain('Shared with the team')
    inside(page(), 'Copy link')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(new URL(`ai-history/${ID}`, document.baseURI).href)
    expect(useToastStore().toasts.at(-1)!.message).toBe('Link copied.')
    inside(page(), 'Stop sharing')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `ai/history/${ID}/share`)).toBe(true)
    expect(inside(page(), 'Share with the team')).not.toBeNull()
  })

  it('offers no sharing when there is no one to share with', async () => {
    api({ available: false, open: item() })
    mountApp(AiHistoryView, { props: { requestId: ID } })
    await flushPromises()
    expect(inside(page(), 'Share with the team')).toBeNull()
    expect(inside(page(), 'Delete')).not.toBeNull()
  })

  it('shows a teammate’s shared request read-only, saying who shared it', async () => {
    const theirs = item({
      mine: false,
      shared: true,
      sharedBy: 'ada',
      chatId: '00000000-0000-4000-8000-0000000000c9',
    })
    api({ open: theirs })
    mountApp(AiHistoryView, { props: { requestId: ID } })
    await flushPromises()
    expect(page().querySelector('[data-request-shared]')!.textContent).toContain('Shared by ada · read-only')
    expect(page().querySelector('[data-request-prompt]')!.textContent).toContain('orders over 100')
    for (const name of ['Delete', 'Open the chat', 'Share with the team', 'Stop sharing'])
      expect(inside(page(), name)).toBeNull()
  })

  it('reads a teammate’s shared chain by its request, with no removing', async () => {
    const theirs = item({
      mine: false,
      shared: true,
      sharedBy: 'ada',
      action: 'pipeline',
      thread: THREAD,
      step: 1,
      chain: {
        steps: 2,
        at: NOW,
        usage: { input: 1, output: 1 },
        ms: 1,
        cost: [],
        outcome: 'ok',
        latest: ID,
      },
    })
    const { calls } = api({ open: theirs })
    mountApp(AiHistoryView, { props: { requestId: ID } })
    await flushPromises()
    expect(calls.some((c) => c.path === `ai/history/${ID}/chain`)).toBe(true)
    expect(calls.some((c) => c.path.startsWith('ai/history/threads/'))).toBe(false)
    for (const name of ['Delete this step', 'Delete the chain']) expect(inside(page(), name)).toBeNull()
    expect(page().textContent).toContain('Shared by ada')
  })

  it('lists what teammates shared, apart from one’s own, with who shared each', async () => {
    const { asked } = api({
      items: [item({ shared: true })],
      shared: [
        item({ id: '00000000-0000-4000-8000-000000000002', mine: false, shared: true, sharedBy: 'ada' }),
      ],
    })
    mountApp(AiHistoryView)
    await flushPromises()
    // One's own shared request says so.
    expect(document.querySelector('[data-request] [data-shared-badge]')!.textContent).toContain('Shared')
    expect(document.body.textContent).toContain('unless you share one')
    inside(document, 'Shared with me')!.click()
    await flushPromises()
    expect(asked.at(-1)!.get('shared')).toBe('1')
    expect(document.querySelector('[data-request]')!.textContent).toContain('ada')
    // Nothing of a teammate's is deleted from here: no "…" menu with "Delete all".
    expect(document.querySelector('[data-history-list] button[aria-label="Actions"]')).toBeNull()
  })

  it('says when nothing is shared with the user yet', async () => {
    api({ items: [], shared: [] })
    mountApp(AiHistoryView)
    await flushPromises()
    inside(document, 'Shared with me')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Nothing is shared with you yet')
  })

  it('offers no shared list without a teammate', async () => {
    api({ available: false, items: [item()] })
    mountApp(AiHistoryView)
    await flushPromises()
    expect(inside(document, 'Shared with me')).toBeNull()
    expect(document.body.textContent).toContain('Only you can read your requests.')
  })

  it('lets the owner take a share back even with no teammate left (share review I3)', async () => {
    const { calls } = api({ available: false, open: item({ shared: true }) })
    mountApp(AiHistoryView, { props: { requestId: ID } })
    await flushPromises()
    inside(page(), 'Stop sharing')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `ai/history/${ID}/share`)).toBe(true)
  })

  it('says why an older chat turn cannot be shared, instead of offering it', async () => {
    api({ open: item({ action: 'chat', shareable: false }) })
    mountApp(AiHistoryView, { props: { requestId: ID } })
    await flushPromises()
    expect(inside(page(), 'Share with the team')).toBeNull()
    expect(page().querySelector('[data-request-unshareable]')!.textContent).toContain('cannot be shared')
  })

  it('never says a missing request is its owner’s only, now that some are shared', () => {
    expect(i18n.global.t('aiHistory.missing')).not.toContain('owner only')
  })
})
