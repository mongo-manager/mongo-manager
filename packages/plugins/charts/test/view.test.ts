// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskError, type Accent, type PluginClient, type PluginContext } from '../../kit/src/client'
import { langTag, LANGUAGES } from '../../kit/src/i18n'
import { formatNumber, pick, shown } from '../../kit/src/ui'
import { answerOf, apiLog } from '../../kit/test/fakeClient'
import { mount, TEXT, type Text } from '../src/view'

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}
type Stage = Record<string, unknown>
type Params = { pipeline: Stage[]; limit: number }

function fakeClient(place: PluginContext['place'], handlers: Record<string, (params: Params) => unknown>) {
  const calls: Array<{ method: string; params: Params }> = []
  let ready: (() => void) | null = null
  const contexts: Array<(l: string, t: 'light' | 'dark', a: Accent) => void> = []
  let aggregating = false
  let refused = 0
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'charts' },
    ask: async <T>(method: string, params?: unknown) => {
      calls.push({ method, params: params as Params })
      if (method === 'documents.aggregate') {
        // As the app does (PluginFrame.vue): one pipeline of a frame at a time, the next refused.
        if (aggregating) {
          refused++
          throw new AskError('busy', 'Its last pipeline is still running')
        }
        aggregating = true
        try {
          return (await handlers[method]!(params as Params)) as T
        } finally {
          aggregating = false
        }
      }
      if (method === 'context.get')
        return {
          plugin: { id: 'charts', version: '1' },
          contribution: { kind: 'collectionTab', id: 'charts' },
          locale: 'en',
          theme: 'light',
          accent: 'ocean',
          place,
          settings: {},
        } as T
      return (await handlers[method]!(params as Params)) as T
    },
    onReady: (fn) => (ready = fn),
    onContext: (fn) => contexts.push(fn),
    onCells: () => {},
  }
  return { client, calls, greet: () => ready!(), contexts, refused: () => refused }
}

const int = (n: number) => ({ $numberInt: String(n) })
const date = (iso: string) => ({ $date: iso })
const PLACE = { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'orders', documentId: null }
const SAMPLE = [
  {
    _id: { $oid: 'a'.repeat(24) },
    city: 'Izmir',
    total: int(5),
    price: int(3),
    at: date('2026-01-05T10:00:00Z'),
  },
  {
    _id: { $oid: 'b'.repeat(24) },
    city: 'Ankara',
    total: int(2),
    price: int(9),
    at: date('2026-03-01T10:00:00Z'),
  },
]
const GROUPS = {
  groups: [
    { _id: 'Izmir', count: int(5) },
    { _id: '<img src=x onerror=alert(1)>', count: int(3) },
    { _id: null, count: int(2) },
  ],
  total: [{ _id: null, count: int(14) }],
}

/** Answers by the pipeline's shape: the sample, a grouping, periods, buckets or points. */
function answers(
  over: Partial<Record<'groups' | 'time' | 'buckets' | 'points', unknown>> & { truncated?: boolean } = {},
) {
  return (p: Params) => {
    const first = p.pipeline[0]!
    if (first.$sample) return { documents: SAMPLE }
    const has = (k: string) => p.pipeline.some((s) => k in s)
    if (has('$facet')) return { documents: [over.groups ?? GROUPS] }
    if (has('$project')) return { documents: over.points ?? [{ x: int(1), y: int(2) }] }
    const group = p.pipeline.find((s) => s.$group)?.$group as { _id: unknown; min?: unknown } | undefined
    if (group?.min && group._id === null)
      return { documents: [{ _id: null, min: int(0), max: { $numberDouble: '39.5' } }] }
    if (group && JSON.stringify(group._id).includes('$floor'))
      return {
        documents: over.buckets ?? [
          { _id: { $numberDouble: '0.0' }, count: int(4) },
          { _id: { $numberDouble: '7.0' }, count: int(6) },
        ],
      }
    return {
      documents: over.time ?? [
        { _id: date('2026-03-01T00:00:00Z'), count: int(1) },
        { _id: date('2026-01-01T00:00:00Z'), count: int(4) },
      ],
      ...(over.truncated ? { truncated: true } : {}),
    }
  }
}

/** Answers as `answers` does, each only when the test lets it go (`release()`, oldest first). */
function held(over: Parameters<typeof answers>[0] = {}) {
  const waiting: Array<() => void> = []
  const handler = (p: Params) =>
    p.pipeline[0]!.$sample
      ? { documents: SAMPLE }
      : new Promise((r) => waiting.push(() => r(answers(over)(p))))
  return { handler, waiting, release: () => waiting.shift()!() }
}

const app = () => document.getElementById('app')!
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const draw = () => $<HTMLButtonElement>('draw')
const field = () => $<HTMLSelectElement>('field')
const choose = async (select: HTMLSelectElement, value: string) => {
  select.value = value
  select.dispatchEvent(new Event('change'))
  await flush()
}
const type = async (label: string) => {
  ;[...document.querySelectorAll<HTMLButtonElement>('#types button')]
    .find((b) => b.textContent === label)!
    .click()
  await flush()
}
const aggregates = (calls: Array<{ method: string; params: Params }>) =>
  calls.filter((c) => c.method === 'documents.aggregate' && !c.params.pipeline[0]!.$sample)
const facetOf = (p: Params) => p.pipeline.find((s) => s.$facet)!.$facet as { groups: Stage[] }

async function opened(place: PluginContext['place'] = PLACE, handler: (p: Params) => unknown = answers()) {
  const fake = fakeClient(place, { 'documents.aggregate': handler, 'ui.useQuery': () => true })
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}

beforeEach(() => {
  document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
  document.documentElement.removeAttribute('style')
})
afterEach(() => vi.useRealTimers())

describe('charts, redesigned (plugin tabs redesign §2.3)', () => {
  it('says what the tab is and invites a choice before anything is drawn', async () => {
    const { calls } = await opened()
    expect(document.querySelector('h1')!.textContent).toBe('Charts')
    expect(document.querySelector('.mm-head-desc')!.textContent).toContain('orders')
    expect(app().querySelector('.mm-empty')!.textContent).toContain('Pick what to chart')
    expect(field().classList.contains('mm-select')).toBe(true)
    expect(draw().disabled).toBe(false)
    expect(aggregates(calls)).toHaveLength(0)
  })

  it('offers to group by values, never by a date or the unique _id', async () => {
    await opened()
    const options = [...field().options].map((o) => o.value)
    expect(options).toContain('city')
    expect(options).not.toContain('at')
    expect(options).not.toContain('_id')
  })

  it('draws when a field is chosen: the top 12 values, "Other", and missing ones said to be', async () => {
    const { calls } = await opened()
    await choose(field(), 'city')
    const [call] = aggregates(calls)
    expect(facetOf(call!.params).groups.at(-1)).toEqual({ $limit: int(12) })
    const bars = document.querySelectorAll('#chart svg rect.ch-bar')
    expect(bars).toHaveLength(4)
    const labels = [...document.querySelectorAll('#chart svg text')].map((t) => t.textContent)
    expect(labels).toContain('(missing)')
    expect(labels).toContain('Other')
    const rows = [...document.querySelectorAll('#summary tbody tr')]
    expect(rows.map((r) => r.firstElementChild!.textContent)).toEqual([
      'Izmir',
      '<img src=x onerror=alert(1)>',
      '(missing)',
      'Other',
    ])
    expect(document.querySelector('img')).toBeNull()
    expect($<HTMLDetailsElement>('data').open).toBe(false)
    expect($('status').textContent).toContain('14 documents')
  })

  it('redraws by itself once drawn: the type, the measure, the field', async () => {
    const { calls } = await opened()
    draw().click()
    await flush()
    expect(aggregates(calls)).toHaveLength(1)
    await type('Donut')
    expect(aggregates(calls)).toHaveLength(2)
    expect(facetOf(aggregates(calls)[1]!.params).groups.at(-1)).toEqual({ $limit: int(7) })
    expect(document.querySelectorAll('#chart svg path.ch-seg').length).toBeGreaterThan(0)
    await type('Histogram')
    // The range first, then bins of one width over it: 0–5, 5–10… 35–40.
    const [range, bins] = aggregates(calls).slice(-2)
    expect(JSON.stringify(range!.params.pipeline)).toContain('$min')
    expect(JSON.stringify(bins!.params.pipeline)).toContain('$floor')
    expect(document.querySelectorAll('#chart svg rect.ch-bar')).toHaveLength(8)
    const rows = [...document.querySelectorAll('#summary tbody tr')]
    expect(rows.map((r) => r.firstElementChild!.textContent)).toEqual([
      '0 – 5',
      '5 – 10',
      '10 – 15',
      '15 – 20',
      '20 – 25',
      '25 – 30',
      '30 – 35',
      '35 – 40',
    ])
    expect(rows.map((r) => r.children[1]!.textContent)).toEqual(['4', '0', '0', '0', '0', '0', '0', '6'])
    // An empty bin has no documents to show.
    expect(rows.map((r) => !!r.querySelector('button'))).toEqual([true, ...Array(6).fill(false), true])
    await choose($<HTMLSelectElement>('field'), 'price')
    expect(JSON.stringify(aggregates(calls).at(-1)!.params.pipeline)).toContain('$price')
  })

  it('offers only a count where no field holds numbers to sum', async () => {
    await opened(PLACE, (p) =>
      p.pipeline[0]!.$sample
        ? { documents: [{ city: 'Izmir' }, { city: 'Bursa' }] }
        : { documents: [GROUPS] },
    )
    expect([...$<HTMLSelectElement>('measure').options].map((o) => o.value)).toEqual(['count'])
  })

  it('switches the controls with the chart type', async () => {
    await opened()
    expect($('measure').closest('label')!.hidden).toBe(false)
    expect($('unit').closest('label')!.hidden).toBe(true)
    await type('Over time')
    expect($('unit').closest('label')!.hidden).toBe(false)
    expect([...field().options].map((o) => o.value)).toEqual(['at'])
    await type('Scatter')
    expect($('y').closest('label')!.hidden).toBe(false)
    // Two different fields: a field against itself says nothing.
    expect($<HTMLSelectElement>('y').value).not.toBe(field().value)
    expect($('measure').closest('label')!.hidden).toBe(true)
    expect(document.querySelector('#types [aria-checked="true"]')!.textContent).toBe('Scatter')
  })

  it('shows a mark’s value in a tooltip, as text only', async () => {
    await opened()
    await choose(field(), 'city')
    const tip = $('tip')
    expect(tip.hidden).toBe(true)
    const mark = document.querySelectorAll('#chart svg .ch-mark')[1]!
    mark.querySelector('rect')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
    expect(tip.hidden).toBe(false)
    expect(tip.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(tip.textContent).toContain('3')
    expect(tip.querySelector('img')).toBeNull()
    $('chart').dispatchEvent(new Event('pointerleave'))
    expect(tip.hidden).toBe(true)
  })

  it('draws a period without documents as zero, and lists only those with some', async () => {
    await opened()
    await type('Over time')
    expect(document.querySelectorAll('#chart svg .ch-mark')).toHaveLength(3)
    expect(document.querySelectorAll('#summary tbody tr')).toHaveLength(2)
  })

  it('says when the field holds nothing, and offers the whole collection from the filter', async () => {
    const empty = { groups: [], total: [] }
    const { calls } = await opened({ ...PLACE, filter: { status: 'new' } }, answers({ groups: empty }))
    await choose(field(), 'city')
    expect(app().querySelector('.mm-callout')!.textContent).toContain('Nothing to chart')
    expect(JSON.stringify(aggregates(calls)[0]!.params.pipeline[0])).toContain('"status":"new"')
    ;[...document.querySelectorAll<HTMLButtonElement>('.mm-callout button')][0]!.click()
    await flush()
    expect(JSON.stringify(aggregates(calls).at(-1)!.params.pipeline)).not.toContain('"status":"new"')
    expect(document.querySelector('#scope [aria-checked="true"]')!.textContent).toBe('Whole collection')
  })

  it('shows a skeleton while reading, and a failure as one', async () => {
    let fail!: (e: Error) => void
    await opened(PLACE, (p) =>
      p.pipeline[0]!.$sample ? { documents: SAMPLE } : new Promise((_, reject) => (fail = reject)),
    )
    draw().click()
    await flush()
    expect(app().querySelector('.mm-skeleton')).not.toBeNull()
    expect(draw().disabled).toBe(true)
    fail(new Error('boom'))
    await flush()
    expect(app().querySelector('.mm-empty-danger')!.textContent).toContain('boom')
    expect(draw().disabled).toBe(false)
  })

  it('asks for one chart at a time, as the app allows, and keeps only the latest (review 2026-10-10)', async () => {
    const gate = held()
    const { calls, refused } = await opened(PLACE, gate.handler)
    await choose(field(), 'city')
    await type('Scatter')
    // The scatter waits for the bar: the app would refuse it while the bar runs.
    expect(gate.waiting).toHaveLength(1)
    gate.release()
    await flush()
    // The bar's answer came after the scatter was chosen: it is not drawn, the scatter still awaited.
    expect(document.querySelector('#chart svg')).toBeNull()
    expect(app().querySelector('#chart .mm-skeleton')).not.toBeNull()
    expect(gate.waiting).toHaveLength(1)
    gate.release()
    await flush()
    expect(document.querySelectorAll('#chart svg .ch-point')).toHaveLength(1)
    expect(app().querySelector('.mm-empty-danger')).toBeNull()
    expect(refused()).toBe(0)
    expect(aggregates(calls)).toHaveLength(2)
  })

  it('steps through the chart types by keyboard without a pipeline refused (review 2026-10-10)', async () => {
    const gate = held()
    const { calls, refused } = await opened(PLACE, gate.handler)
    await choose(field(), 'city')
    const types = $('types')
    types.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    types.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flush()
    expect(document.querySelector('#types [aria-checked="true"]')!.textContent).toBe('Donut')
    while (gate.waiting.length) {
      gate.release()
      await flush()
    }
    expect(refused()).toBe(0)
    expect(app().querySelector('.mm-empty-danger')).toBeNull()
    expect(document.querySelectorAll('#chart svg path.ch-seg').length).toBeGreaterThan(0)
    // The line passed over was never asked for: only the bar (already running) and the donut.
    expect(aggregates(calls)).toHaveLength(2)
    expect(facetOf(aggregates(calls)[1]!.params).groups.at(-1)).toEqual({ $limit: int(7) })
  })

  it('reads a histogram’s range and bins one after the other, a superseded one left unread', async () => {
    const gate = held()
    const { calls, refused } = await opened(PLACE, gate.handler)
    await type('Histogram')
    await choose(field(), 'price')
    // The first histogram's range answers after the field changed: its bins are never asked for.
    gate.release()
    await flush()
    gate.release()
    await flush()
    gate.release()
    await flush()
    expect(gate.waiting).toHaveLength(0)
    expect(refused()).toBe(0)
    const pipelines = aggregates(calls).map((c) => JSON.stringify(c.params.pipeline))
    expect(pipelines).toHaveLength(3)
    expect(pipelines[1]).toContain('$price')
    expect(pipelines[2]).toContain('$floor')
    expect(pipelines[2]).toContain('$price')
    expect(document.querySelectorAll('#chart svg rect.ch-bar').length).toBeGreaterThan(0)
  })

  it('says older periods were left out only when the server had more (review 2026-10-10)', async () => {
    const months = Array.from({ length: 1000 }, (_, i) => ({
      _id: date(new Date(Date.UTC(2026, -i, 1)).toISOString()),
      count: int(1),
    }))
    const { calls } = await opened(PLACE, answers({ time: months }))
    await type('Over time')
    // Exactly 1,000 periods: all of them, nothing left out.
    expect($('status').textContent).toContain('1000 periods')
    expect($('status').textContent).not.toContain('older ones')
    expect(aggregates(calls).at(-1)!.params.limit).toBe(1000)
    document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'app' }))
    await opened(PLACE, answers({ truncated: true }))
    await type('Over time')
    expect($('status').textContent).toContain('2 periods: the latest; older ones are left out')
  })

  it('puts a row’s documents in Documents', async () => {
    const { calls } = await opened()
    await choose(field(), 'city')
    const show = document.querySelector('#summary tbody tr')!.querySelector('button')!
    expect(show.textContent).toBe('Show')
    show.click()
    await flush()
    expect(calls.find((c) => c.method === 'ui.useQuery')!.params).toEqual({
      filter: { city: { $eq: 'Izmir' } },
    })
  })

  it('paints in the user’s accent, and the parts of a donut in colours taken from it', async () => {
    document.documentElement.style.setProperty('--ds-accent', '#2563eb')
    await opened()
    await choose(field(), 'city')
    expect(document.querySelector('#chart rect.ch-bar')!.getAttribute('fill')).toBe('#2563eb')
    await type('Donut')
    const fills = [...document.querySelectorAll('#chart path.ch-seg')].map((s) => s.getAttribute('fill'))
    expect(fills[0]).toBe('#2563eb')
    expect(new Set(fills).size).toBe(fills.length)
  })

  it('redraws to the frame’s width', async () => {
    await opened()
    await choose(field(), 'city')
    vi.useFakeTimers()
    Object.defineProperty($('chart'), 'clientWidth', { configurable: true, value: 900 })
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(300)
    expect(document.querySelector('#chart svg')!.getAttribute('viewBox')).toBe(
      `0 0 900 ${document.querySelector('#chart svg')!.getAttribute('height')}`,
    )
  })

  it('follows the app’s language, theme and accent, the chart re-labelled', async () => {
    const { contexts } = await opened()
    await choose(field(), 'city')
    contexts[0]!('tr', 'dark', 'rose')
    expect(document.documentElement.dataset.accent).toBe('rose')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.querySelector('h1')!.textContent).toBe('Grafikler')
    expect(draw().textContent).toBe('Çiz')
    const labels = [...document.querySelectorAll('#chart svg text')].map((t) => t.textContent)
    expect(labels).toContain('Diğer')
    expect(labels).toContain('(eksik)')
  })

  it('titles its charts in natural Turkish (review 2026-10-10)', async () => {
    const { contexts } = await opened()
    contexts[0]!('tr', 'light', 'ocean')
    expect([...document.querySelectorAll('#types button')].map((b) => b.textContent)).toContain('Saçılım')
    expect(app().querySelector('.mm-empty-title')!.textContent).toBe('Neyi çizeceğinizi seçin')
    await choose(field(), 'city')
    expect($('status').querySelector('strong')!.textContent).toBe('city alanına göre belge sayısı')
    await choose($<HTMLSelectElement>('measure'), 'sum')
    expect($('of').closest('label')!.textContent).toContain('Değer alanı')
    expect($('status').querySelector('strong')!.textContent).toBe('city alanına göre price toplamı')
    await type('Zamana göre')
    expect($('status').querySelector('strong')!.textContent).toBe('Aylara göre price toplamı (at)')
    await choose($<HTMLSelectElement>('measure'), 'count')
    expect($('status').querySelector('strong')!.textContent).toBe('Aylara göre belge sayısı (at)')
  })

  it.each([
    ['zh', '图表', '绘制', '其他'],
    ['ja', 'グラフ', '描画', 'その他'],
    ['es', 'Gráficos', 'Graficar', 'Otros'],
    ['pt', 'Gráficos', 'Gerar', 'Outros'],
    ['ko', '차트', '그리기', '기타'],
    ['de', 'Diagramme', 'Zeichnen', 'Sonstige'],
    ['fr', 'Graphiques', 'Tracer', 'Autres'],
    ['ru', 'Диаграммы', 'Построить', 'Прочее'],
  ])('shows its title and labels in %s', async (lang, title, drawLabel, other) => {
    const { contexts } = await opened()
    await choose(field(), 'city')
    contexts[0]!(lang, 'light', 'ocean')
    expect(document.querySelector('h1')!.textContent).toBe(title)
    expect(draw().textContent).toBe(drawLabel)
    expect(document.documentElement.lang).toBe(langTag(lang))
    expect([...document.querySelectorAll('#chart svg text')].map((t) => t.textContent)).toContain(other)
  })

  it('falls back to English for an unknown locale', async () => {
    const { contexts } = await opened()
    contexts[0]!('xx', 'light', 'ocean')
    expect(document.querySelector('h1')!.textContent).toBe('Charts')
    expect(draw().textContent).toBe('Draw')
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to English words and numbers for a language the table lacks', () => {
    // A table that really lacks de, fr and the rest: the page must speak English, numbers included.
    const partial = { en: TEXT.en, tr: TEXT.tr }
    for (const lang of ['de', 'fr', 'ru', 'ko', 'xx']) {
      expect(pick<Text>(partial, lang), lang).toBe(TEXT.en)
      expect(shown(partial, lang), lang).toBe('en')
      expect(formatNumber(12345.5, shown(partial, lang)), lang).toBe('12,345.5')
    }
    expect(pick<Text>(partial, 'tr')).toBe(TEXT.tr)
    expect(shown(partial, 'tr')).toBe('tr')
  })

  it('marks the page English when its words are English', async () => {
    const { contexts } = await opened()
    contexts[0]!('xx', 'light', 'ocean')
    expect(document.documentElement.lang).toBe('en')
  })

  it('has the same words in every language as in English', () => {
    const shape = (v: unknown): unknown =>
      typeof v === 'function'
        ? 'fn'
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
          : typeof v
    for (const [lang, block] of Object.entries(TEXT)) expect(shape(block), lang).toEqual(shape(TEXT.en))
    for (const lang of LANGUAGES) expect(TEXT[lang], lang).toBeDefined()
  })

  it('has the same keys inside every table and function result shape', () => {
    const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.keys(v).sort() : [])
    for (const lang of LANGUAGES) {
      for (const k of Object.keys(TEXT.en) as Array<keyof typeof TEXT.en>) {
        expect(keys(TEXT[lang][k]), lang + '.' + k).toEqual(keys(TEXT.en[k]))
      }
    }
  })

  it.each([
    ['ko', 1, '도큐먼트 1개'],
    ['de', 1, '1 Dokument'],
    ['de', 2, '2 Dokumente'],
    ['fr', 1, '1 document'],
    ['fr', 0, '0 document'],
    ['fr', 2, '2 documents'],
    ['es', 1, '1 documento'],
    ['es', 2, '2 documentos'],
    ['pt', 1, '1 documento'],
    ['pt', 0, '0 documento'],
    ['ru', 0, '0 документов'],
    ['ru', 1, '1 документ'],
    ['ru', 2, '2 документа'],
    ['ru', 5, '5 документов'],
    ['ru', 11, '11 документов'],
    ['ru', 21, '21 документ'],
    ['ru', 22, '22 документа'],
    ['ru', 24, '24 документа'],
    ['ru', 112, '112 документов'],
  ] as const)('counts documents right in %s for %i', (lang, n, expected) => {
    expect(TEXT[lang].documents(n, String(n))).toBe(expected)
  })

  it.each([
    ['de', 1, '1 Wert'],
    ['de', 2, '2 Werte'],
    ['fr', 0, '0 valeur'],
    ['fr', 1, '1 valeur'],
    ['fr', 2, '2 valeurs'],
    ['ru', 3, '3 значения'],
    ['ru', 12, '12 значений'],
    ['ru', 21, '21 значение'],
    ['ru', 22, '22 значения'],
  ] as const)('counts values right in %s for %i', (lang, n, expected) => {
    expect(TEXT[lang].values(n, false)).toBe(expected)
  })

  it.each([
    ['es', 1, '1 punto'],
    ['es', 5, '5 puntos'],
    ['pt', 1, '1 ponto'],
    ['pt', 5, '5 pontos'],
    ['de', 1, '1 Punkt'],
    ['fr', 0, '0 point'],
    ['fr', 2, '2 points'],
    ['ru', 1, '1 точка'],
    ['ru', 3, '3 точки'],
    ['ru', 11, '11 точек'],
    ['ru', 21, '21 точка'],
  ] as const)('counts points right in %s for %i', (lang, n, expected) => {
    expect(TEXT[lang].points(n, String(n))).toMatch(new RegExp(`^${expected}(,|$)`))
  })

  // A donut's centre reads "<total>" over a word for what is counted: a word, never a counter with
  // its number cut out ("도큐먼트 개", "个文档", always-genitive "документов").
  it.each([
    ['en', 'documents'],
    ['tr', 'belge'],
    ['zh', '文档'],
    ['ja', 'ドキュメント'],
    ['es', 'documentos'],
    ['pt', 'documentos'],
    ['ko', '도큐먼트'],
    ['de', 'Dokumente'],
    ['fr', 'documents'],
    ['ru', 'документы'],
  ] as const)('captions a donut of counts with a plain word in %s', async (lang, word) => {
    const { contexts } = await opened()
    await choose(field(), 'city')
    await type('Donut')
    contexts[0]!(lang, 'light', 'ocean')
    const sub = document.querySelector('#chart text.ch-sub')!.textContent!
    expect(sub).toBe(word)
    expect(TEXT[lang].documentsLabel).toBe(word)
    expect(sub).not.toMatch(/[0-9개个件]/)
  })

  it('puts a narrow no-break space before the colon, semicolon and the like in French', () => {
    const fr = TEXT.fr
    const NARROW = ' '
    const strings = [
      fr.description('c'),
      fr.emptyHint,
      fr.failed,
      fr.latest,
      fr.share('5 %'),
      fr.points(2, '2'),
    ]
    for (const s of strings) {
      expect(s, s).not.toMatch(/ [:;!?]/)
    }
    expect(fr.description('c')).toContain(`graphique${NARROW}:`)
    expect(fr.emptyHint).toContain(`champ${NARROW}:`)
    expect(fr.share('5 %')).toBe(`Part${NARROW}: 5 %`)
  })

  it('titles a chart in natural German, French and Russian', () => {
    expect(TEXT.de.byField('sum', 'price', 'city')).toBe('Summe von price nach city')
    expect(TEXT.fr.overTime('count', undefined, 'month', 'at')).toBe('Documents par mois (at)')
    expect(TEXT.ru.overTime('avg', 'price', 'week', 'at')).toBe('Среднее price по неделям (at)')
    expect(TEXT.ko.overTime('count', undefined, 'day', 'at')).toBe('일별 도큐먼트 수 (at)')
  })

  it('says to open a collection where there is none', async () => {
    await opened(null)
    expect(app().textContent).toContain('Open a collection to chart it.')
    expect(draw().disabled).toBe(true)
  })
})

// User report 2026-11-07 (API logs of ~60 KB a document): 200 of them are over the 1 MB one answer
// may be. The field sample failed unseen, and every chart type said there was nothing to chart.
describe('charts on documents too large for one answer (user report 2026-11-07)', () => {
  const LOGS = Array.from({ length: 300 }, (_, i) => apiLog(i))
  const asApp = (docs: readonly unknown[]) => (p: Params) =>
    p.pipeline[0]!.$sample
      ? answerOf(docs, p as unknown as Record<string, unknown>, 'aggregate')
      : answers()(p)

  it('reads its fields from the documents that fit in one answer, and draws', async () => {
    const { calls } = await opened(PLACE, asApp(LOGS))
    const sample = calls.find((c) => c.params?.pipeline?.[0]?.$sample)!.params as unknown as { fit?: boolean }
    expect(sample.fit).toBe(true)
    expect(app().textContent).not.toContain('holds no text')
    expect([...field().options].map((o) => o.value)).toContain('path')
    expect(draw().disabled).toBe(false)
  })

  it('says why its fields could not be read, never "nothing to chart", and reads them again', async () => {
    let docs: readonly unknown[] = [{ _id: 1, city: 'x'.repeat(1_100_000) }]
    await opened(PLACE, (p) => asApp(docs)(p))
    expect(app().textContent).toContain('The fields could not be read from a sample:')
    expect(app().textContent).toContain('This is too large to send')
    expect(app().textContent).not.toContain('holds no text')
    expect(draw().disabled).toBe(true)
    await type('Over time')
    expect(app().textContent).toContain('The fields could not be read from a sample:')
    docs = SAMPLE
    ;[...app().querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click()
    await flush()
    expect(app().textContent).not.toContain('could not be read')
    expect([...field().options].map((o) => o.value)).toContain('at')
  })
})
