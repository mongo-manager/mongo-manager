import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { deserializeValue } from '@mongo-manager/shared/browser'
import type { PluginRuntimeView } from '@mongo-manager/shared'
import PluginCellText from '../src/plugins/PluginCellText.vue'
import DocumentTable from '../src/documents/DocumentTable.vue'
import TreeNode from '../src/documents/TreeNode.vue'
import { toRows } from '../src/documents/rows'
import { usePluginsStore } from '../src/plugins/store'
import { cellCache } from '../src/plugins/cells'
import { provideMaskedPatterns } from '../src/masking/useMaskedPaths'
import type { Bridge } from '../src/plugins/bridge'
import { mountApp } from './support/app'

/**
 * User request 2026-10-13: "zaman etiketlerini yanlarına yazma, ObjectId üzerine geldiğimizde
 * tooltip ile göstersin". A renderer that asks for a tooltip is shown over the value it speaks of —
 * the whole value first, then each plugin's line under its name — when the cell or row is hovered
 * or focused, and read with the value; never written beside it. One that does not stays beside.
 */
type Renderer = PluginRuntimeView['contributes']['cellRenderers'][number]
const runtime = (renderers: Renderer[]): PluginRuntimeView =>
  ({
    id: 'time',
    version: '1.1.0',
    name: { en: 'Time hints', tr: 'Zaman ipuçları' },
    entry: 'index.html',
    permissions: ['documents:read'],
    contributes: { collectionTabs: [], documentActions: [], sidebarPanels: [], cellRenderers: renderers },
    settings: {},
  }) as PluginRuntimeView
const answering = (text: (renderer: string) => string): Bridge => ({
  ask: vi.fn(async (_m: string, params: unknown) => {
    const p = params as { renderer: string; values: unknown[] }
    return p.values.map(() => ({ text: text(p.renderer) }))
  }),
  dispose: () => undefined,
  hello: () => undefined,
  notify: () => undefined,
})
function plugin(renderers: Renderer[], text: (renderer: string) => string = () => '7 Oct 2026 13:58') {
  const store = usePluginsStore()
  store.setRuntime([runtime(renderers)])
  const bridge = answering(text)
  store.setRenderer('time', bridge)
  return bridge
}
const TIP: Renderer = { id: 'oid', match: 'objectId', display: 'tooltip' }

beforeEach(() => {
  setActivePinia(createPinia())
  cellCache.clear()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const oid = '6ac625df13a09509ca0da1af'
const value = deserializeValue({ $oid: oid })
/** A cell as the table draws one: the value inside a focusable cell that shows its tooltip. */
const Cell = defineComponent(
  () => () =>
    h('table', [
      h('tbody', [
        h('tr', [
          h('td', { tabindex: 0 }, [
            h(PluginCellText, { value, path: ['_id'], host: 'td', showValue: true }, () =>
              h('span', { 'data-value': '' }, '6ac625df…'),
            ),
          ]),
        ]),
      ]),
    ]),
)
const tooltip = () => document.querySelector('[role="tooltip"]')
const settle = async () => {
  await flushPromises()
  await flushPromises()
}

describe('a renderer shown as a tooltip', () => {
  it('shows the whole value, then the plugin’s line under its name, when the cell is hovered', async () => {
    plugin([TIP])
    mountApp(Cell)
    await settle()
    expect(document.querySelector('[data-plugin-cell]')).toBeNull()
    expect(document.querySelector('[data-plugin-tip] .sr-only')!.textContent).toContain(
      'Time hints: 7 Oct 2026 13:58',
    )
    vi.useFakeTimers()
    const td = document.querySelector('td')!
    td.dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(400)
    await flushPromises()
    const lines = [...tooltip()!.querySelectorAll('.block')].map((l) => l.textContent)
    expect(lines).toEqual([`ObjectId("${oid}")`, 'Time hints: 7 Oct 2026 13:58'])
    td.dispatchEvent(new MouseEvent('mouseleave'))
    await flushPromises()
    expect(tooltip()).toBeNull()
  })

  it('shows it when the cell takes the keyboard’s focus, and Escape puts it away', async () => {
    plugin([TIP])
    mountApp(Cell)
    await settle()
    vi.useFakeTimers()
    document.querySelector('td')!.focus()
    vi.advanceTimersByTime(150)
    await flushPromises()
    expect(tooltip()!.textContent).toContain('7 Oct 2026 13:58')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(tooltip()).toBeNull()
  })

  it('never sends a hidden personal value to a renderer, nor shows a tooltip for it', async () => {
    const bridge = plugin([{ id: 's', match: 'string', display: 'tooltip' }])
    const Host = defineComponent({
      setup() {
        provideMaskedPatterns(ref([['email']]))
        return () => [
          h(PluginCellText, { value: '***', path: ['email'], showValue: true }, () => h('span', '***')),
          h(PluginCellText, { value: 'plain', path: ['name'], showValue: true }, () => h('span', 'plain')),
        ]
      },
    })
    mountApp(Host)
    await settle()
    const asked = (bridge.ask as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[1] as { values: unknown[] }).values,
    )
    expect(asked).toEqual([['plain']])
    expect(document.querySelectorAll('[data-plugin-tip] .sr-only')).toHaveLength(1)
  })

  it('keeps one wrapper as the answer comes: the value is drawn once', async () => {
    plugin([TIP])
    mountApp(Cell)
    await flushPromises()
    const drawn = document.querySelector('[data-value]')
    await settle()
    expect(document.querySelector('[data-plugin-tip] .sr-only')).not.toBeNull()
    expect(document.querySelector('[data-value]')).toBe(drawn)
  })

  it('leaves a renderer shown beside the value where it was, and gives one of each place its say', async () => {
    plugin([TIP, { id: 'year', match: 'objectId', display: 'inline' }], (r) =>
      r === 'oid' ? 'made 13:58' : '≈ 2026',
    )
    mountApp(Cell)
    await settle()
    expect(document.querySelector('[data-plugin-cell]')!.textContent).toBe('≈ 2026')
    expect(document.querySelector('[data-plugin-tip] .sr-only')!.textContent).toContain('made 13:58')
  })
})

describe('tooltips in the documents table and tree', () => {
  const rows = () =>
    toRows(
      [
        {
          document: {
            _id: { $oid: oid },
            n: { $numberInt: '1' },
            geo: { type: 'Point', coordinates: [1, 2] },
          },
          hash: 'e'.repeat(64),
        },
      ],
      0,
    )

  it('keeps a cell’s title where no tooltip speaks, and gives it up where one does', async () => {
    plugin([TIP])
    mountApp(DocumentTable, {
      props: { rows: rows(), columns: ['_id', 'n'], canWrite: false, rowHeight: 36 },
    })
    await settle()
    const valueOf = (field: string) => document.querySelector(`td[data-field="${field}"] [data-cell-value]`)!
    expect(valueOf('_id').hasAttribute('title')).toBe(false)
    expect(valueOf('n').getAttribute('title')).toBe('1')
  })

  it('shows a tooltip over a nested value too', async () => {
    plugin([{ id: 'where', match: 'geojson', display: 'tooltip' }], () => 'Amsterdam')
    mountApp(DocumentTable, {
      props: { rows: rows(), columns: ['_id', 'geo'], canWrite: false, rowHeight: 36 },
    })
    await settle()
    expect(document.querySelector('td[data-field="geo"] [data-plugin-tip] .sr-only')!.textContent).toContain(
      'Amsterdam',
    )
    expect(document.querySelector('[data-plugin-cell]')).toBeNull()
  })

  it('shows it over a tree row when the row is hovered', async () => {
    plugin([TIP])
    mountApp(TreeNode, { props: { name: '_id', value, depth: 0, path: ['_id'] } })
    await settle()
    vi.useFakeTimers()
    document.querySelector('[data-tree-row]')!.dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(400)
    await flushPromises()
    expect(tooltip()!.textContent).toContain(`ObjectId("${oid}")`)
    expect(tooltip()!.textContent).toContain('7 Oct 2026 13:58')
  })
})
