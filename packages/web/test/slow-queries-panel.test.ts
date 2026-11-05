// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn(async () => true) }))
vi.mock('../src/library/openItem', () => ({ openLibraryItem: openMock }))
import SlowQueriesPanel from '../src/monitor/SlowQueriesPanel.vue'

/** Phase 3b spec §3.2: slow operations from the profiler and the server log. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

const entry = {
  source: 'profile',
  ts: '2026-09-30T10:00:00.000Z',
  ns: 'crm.users',
  op: 'query',
  durationMs: 250,
  planSummary: 'COLLSCAN',
  docsExamined: 5000,
  nreturned: 1,
  command: '{"find":"users","filter":{"email":"***"},"note":"<img src=x onerror=alert(1)>"}',
}

describe('SlowQueriesPanel (phase 3b §3.2)', () => {
  it('lists entries with their source, flags a missing index, and opens Explain', async () => {
    mockApi({
      'GET connections/c1/server/slow-queries': () => [
        200,
        {
          entries: [{ ...entry, origin: { kind: 'find', db: 'crm', coll: 'users', filter: {} } }],
          refused: {},
        },
      ],
    })
    const { wrapper } = mountApp(SlowQueriesPanel, { props: { connectionId: 'c1', restricted: false } })
    await flushPromises()
    expect(wrapper.text()).toContain('crm.users')
    expect(wrapper.text()).toContain('250 ms')
    expect(wrapper.find('[data-slow-index-warning]').exists()).toBe(true)
    await wrapper.find('[data-slow-entry]').trigger('click')
    // The command is text, never HTML.
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x')
    await wrapper.find('[data-slow-explain]').trigger('click')
    expect(openMock).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ kind: 'find', db: 'crm', coll: 'users' }),
      expect.objectContaining({ explain: true }),
    )
  })

  // Index advice gaps (2026-10-27, wave 4 #6): the same queries counted together by their shape.
  it('groups the slow queries by shape, the costliest first, and opens a group in place', async () => {
    const shape = 'find {"filter":{"email":"?"}}'
    mockApi({
      'GET connections/c1/server/slow-queries': () => [
        200,
        {
          entries: [
            { ...entry, shape, durationMs: 100 },
            { ...entry, shape, durationMs: 300, ts: '2026-09-30T11:00:00.000Z' },
            { ...entry, shape: 'find {"filter":{"age":"?"}}', durationMs: 150 },
          ],
          refused: {},
        },
      ],
    })
    const { wrapper } = mountApp(SlowQueriesPanel, { props: { connectionId: 'c1', restricted: false } })
    await flushPromises()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((b) => b.textContent?.trim() === 'By shape')!
      .click()
    await flushPromises()
    const groups = wrapper.findAll('[data-slow-group]')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.text()).toContain('2×')
    expect(groups[0]!.text()).toContain('400 ms')
    expect(groups[0]!.text()).toContain('{"email":"?"}')
    await groups[0]!.trigger('click')
    expect(wrapper.find('[data-slow-group-detail]').text()).toContain('p95')
    expect(wrapper.find('[data-slow-group-detail]').text()).toContain('300 ms')
    // Final review Minor 16: documents examined per returned, and the button names its detail.
    expect(wrapper.find('[data-slow-group-detail]').text()).toContain('5,000 documents examined per returned')
    const detailId = wrapper.find('[data-slow-group-detail]').attributes('id')
    expect(detailId).toBeTruthy()
    expect(groups[0]!.attributes('aria-controls')).toBe(detailId)
  })

  it('sends the filter, offers no Explain to a restricted user, and shows a refused source', async () => {
    const asked: URLSearchParams[] = []
    mockApi({
      'GET connections/c1/server/slow-queries': (_body, url) => {
        asked.push(url.searchParams)
        return [200, { entries: [entry], refused: { log: 'not_permitted' } }]
      },
    })
    const { wrapper } = mountApp(SlowQueriesPanel, { props: { connectionId: 'c1', restricted: true } })
    await flushPromises()
    await wrapper.find('[data-slow-entry]').trigger('click')
    expect(wrapper.find('[data-slow-explain]').exists()).toBe(false)
    expect(wrapper.find('[data-slow-refused="log"]').text()).toContain('clusterMonitor')
    await wrapper.find('[data-slow-db]').setValue('crm')
    await wrapper.find('[data-slow-form]').trigger('submit')
    await flushPromises()
    expect(Object.fromEntries(asked.at(-1)!)).toMatchObject({ db: 'crm', source: 'both' })
  })
})
