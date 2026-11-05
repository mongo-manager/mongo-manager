// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/**
 * Design 2026-10-25 (B6): the audit log says which entries the assistant made, and shows one turn's
 * entries — its tool calls, the person's answer and the routes' own rows — together.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const RUN = '11111111-1111-4111-8111-111111111111'
const entry = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  at: Date.UTC(2026, 9, 26, 10, 0, id % 60),
  userId: 'u1',
  username: 'ada',
  ip: '127.0.0.1',
  action: 'collections.create',
  connectionId: 'c1',
  namespace: 'shop',
  outcome: 'success',
  details: { status: 201 },
  ...extra,
})

describe('the assistant’s entries in the audit log (B6)', () => {
  it('marks them, and shows one turn’s entries on asking', async () => {
    const urls: URL[] = []
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [
        200,
        {
          mode: 'team',
          user: { id: 'u1', username: 'ada', role: 'admin' },
          permissions: [...PERMISSIONS],
          csrfToken: 'c',
          readOnly: false,
          twoFactor: {},
        },
      ],
      'GET connections': () => [200, []],
      'GET users': () => [200, []],
      'GET audit': (_b, url) => {
        urls.push(url)
        return [
          200,
          [
            entry(3, { details: { status: 201, agent: { run: RUN, chat: 'ch1', call: '1.1' } } }),
            entry(2, {
              action: 'ai.agent.tool',
              details: { run: RUN, chat: 'ch1', tool: 'create_collection' },
            }),
            entry(1, { action: 'documents.update', details: { status: 200 } }),
            // The person's own answer: of the turn, not the assistant's doing (review of B6, M2).
            entry(0, {
              action: 'ai.agent.decision',
              details: { run: RUN, call: '1.1', decision: 'confirm' },
            }),
          ],
        ]
      },
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    const tabs = useTabsStore()
    tabs.bindUser('u1')
    tabs.open({ kind: 'audit', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelectorAll('main tbody tr[data-entry]').length).toBe(4))
    const rows = [...document.querySelectorAll<HTMLElement>('main tbody tr[data-entry]')]
    // A route's row the assistant's call made, and the assistant's own row, are marked; the rest not.
    expect(rows.map((r) => !!r.querySelector('[data-audit-assistant]'))).toEqual([true, true, false, false])
    // Its meaning is shown on pointing too (a tooltip), not only read out.
    expect(rows[0]!.querySelector('[data-audit-assistant]')!.textContent).toContain('Made by the assistant')
    rows[3]!.querySelector<HTMLButtonElement>('button[aria-label="Show details"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Show this turn')
    rows[3]!.querySelector<HTMLButtonElement>('button[aria-label="Show details"]')!.click()
    await flushPromises()
    rows[0]!.querySelector<HTMLButtonElement>('button[aria-label="Show details"]')!.click()
    await flushPromises()
    button('Show this turn').click()
    await flushPromises()
    expect(Object.fromEntries(urls.at(-1)!.searchParams)).toEqual({ limit: '50', run: RUN })
    expect(document.querySelector('[data-audit-turn]')!.textContent).toContain('One assistant turn')
    button('Clear filters').click()
    await flushPromises()
    expect(Object.fromEntries(urls.at(-1)!.searchParams)).toEqual({ limit: '50' })
    expect(document.querySelector('[data-audit-turn]')).toBeNull()
  })
})
