import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import en from '../src/i18n/locales/en.json'
import tr from '../src/i18n/locales/tr.json'
import { i18n } from '../src/i18n'
import ReplicaSetPanel from '../src/monitor/ReplicaSetPanel.vue'
import OperationsTable from '../src/monitor/OperationsTable.vue'
import SlowQueriesPanel from '../src/monitor/SlowQueriesPanel.vue'
import PerformanceView from '../src/monitor/PerformanceView.vue'
import BackupsCard from '../src/backup/BackupsCard.vue'
import WidgetError from '../src/workspace/overview/widgets/WidgetError.vue'
import { useTabSectionsStore } from '../src/stores/tabSections'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

/** Review of the Monitoring redesign (minors): words, loading states and the new Retry buttons. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  sessionStorage.clear()
})
afterEach(() => {
  document.body.innerHTML = ''
})

type Tree = { [key: string]: string | Tree }
const flat = (tree: Tree, prefix = ''): Array<[string, string]> =>
  Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : flat(v, `${prefix}${k}.`),
  )

describe('the words', () => {
  it('reads naturally in the index suggestions and the cache figure', () => {
    expect(en.indexAdvice.why).toBe('Seen in slow queries')
    expect(tr.indexAdvice.why).toBe('Yavaş sorgularda')
    expect(tr.performance.figures.cacheOf).toBe('{used} / {max}')
  })

  // One Turkish word for a menu of a thing's actions: "işlemler", as most tables already said.
  it('names every row-actions menu in Turkish with one word', () => {
    const menus = flat(tr as Tree).filter(([k]) => /(?:^|\.)(?:actions|actionsFor|more|treeMenu)$/.test(k))
    const odd = menus.filter(([, v]) => /eylem/i.test(v)).map(([k]) => k)
    expect(odd).toEqual([])
  })
})

// A tab's other choices (Performance's span) live as long as the tab, and leave with it.
describe('a tab’s kept choices', () => {
  it('stay while the tab is open and leave with it', () => {
    const store = useTabSectionsStore()
    store.set('connection:c1', 'performance')
    store.setValue('connection:c1', 'range', '7d')
    store.prune(new Set(['connection:c1']))
    expect(store.getValue('connection:c1', 'range', 'live')).toBe('7d')
    store.prune(new Set())
    expect(store.getValue('connection:c1', 'range', 'live')).toBe('live')
    expect(store.get('connection:c1', 'overview')).toBe('overview')
  })
})

describe('loading states', () => {
  const SRC = join(import.meta.dirname, '..', 'src')
  it.each([
    'ai/history/ChainDetails.vue',
    'ai/history/HistoryDetails.vue',
    'ai/history/RequestPage.vue',
    'transfer/SqlExportPanel.vue',
  ])('%s loads with the kit’s placeholders, not a spinner and a word', (f) => {
    const source = readFileSync(join(SRC, f), 'utf8')
    // A spinner beside a running export's status stays: it says work is under way, not that content loads.
    expect(source.slice(source.indexOf('<template>'))).not.toMatch(
      /<DsSpinner\b[^>]*\/>\s*\{\{\s*(?:w\.)?t\('(?:aiHistory|tree)\.loading'\)/,
    )
  })
})

describe('the Retry buttons ask again', () => {
  const count = (calls: Array<{ method: string; path: string }>, path: string) =>
    calls.filter((c) => c.method === 'GET' && c.path === path).length
  const FAIL = () => [502, { code: 'MONGO_ERROR', message: 'Could not read it' }] as [number, unknown]

  it('in the replica set card', async () => {
    const { calls } = mockApi({ 'GET connections/c1/server/replica': FAIL })
    mountApp(ReplicaSetPanel, { props: { connectionId: 'c1' } })
    await flushPromises()
    const before = count(calls, 'connections/c1/server/replica')
    button('Retry').click()
    await flushPromises()
    expect(count(calls, 'connections/c1/server/replica')).toBe(before + 1)
  })

  it('in the operations card', async () => {
    const { calls } = mockApi({ 'GET connections/c1/server/operations': FAIL })
    mountApp(OperationsTable, { props: { connectionId: 'c1', canOperate: false } })
    await flushPromises()
    const before = count(calls, 'connections/c1/server/operations')
    button('Retry').click()
    await flushPromises()
    expect(count(calls, 'connections/c1/server/operations')).toBe(before + 1)
  })

  it('in the slow queries card', async () => {
    const { calls } = mockApi({ 'GET connections/c1/server/slow-queries': FAIL })
    mountApp(SlowQueriesPanel, { props: { connectionId: 'c1', restricted: false } })
    await flushPromises()
    const before = count(calls, 'connections/c1/server/slow-queries')
    button('Retry').click()
    await flushPromises()
    expect(count(calls, 'connections/c1/server/slow-queries')).toBe(before + 1)
  })

  it('in the hottest collections card', async () => {
    const { calls } = mockApi({
      'GET connections/c1/server/top': FAIL,
      'GET connections/c1/server/status': () => [200, null],
      'GET connections/c1/server/operations': () => [200, { operations: [] }],
    })
    mountApp(defineComponent(() => () => h(PerformanceView, { connectionId: 'c1', canOperate: false })))
    await flushPromises()
    const before = count(calls, 'connections/c1/server/top')
    const card = [...document.querySelectorAll('section')].find((s) =>
      s.querySelector('h3')?.textContent?.includes('Hottest collections'),
    )!
    ;[...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Retry')!.click()
    await flushPromises()
    expect(count(calls, 'connections/c1/server/top')).toBe(before + 1)
  })

  it('in the backups card', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [{ id: 'c1', name: 'Prod', access: 'editor', permissions: [] }]],
      'GET backups': FAIL,
      'GET backups/usage': () => [200, { used: 0, quota: 1, ttlHours: 24 }],
    })
    mountApp(BackupsCard, { props: { connectionId: 'c1' } })
    await flushPromises()
    const before = count(calls, 'backups')
    button('Retry').click()
    await flushPromises()
    expect(count(calls, 'backups')).toBe(before + 1)
  })

  it('in a widget', async () => {
    let asked = 0
    mountApp(WidgetError, { props: { text: 'Could not read it', retry: () => asked++ } })
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Could not read it')
    button('Retry').click()
    expect(asked).toBe(1)
  })
})
