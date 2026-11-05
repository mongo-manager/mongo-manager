// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  describeValue,
  emptyState,
  formatNumber,
  h,
  icon,
  langTag,
  shown,
  pageHeader,
  pick,
  pluralOf,
  type Language,
  segmented,
  serialAsk,
  setLabel,
  skeleton,
  statusLine,
  table,
  valueView,
  type IconName,
} from '../../kit/src/ui'
import { zh, ja, es, pt } from './text'
import { ko, de, fr, ru } from './text-more'
import { bars, columns, donut, line, scatter, type Paint, type Part } from './draw'
import { fieldInfo, fieldsFor, type Doc, type FieldInfo } from './fields'
import { binEdges, fillPeriods, groupMarks, paletteFrom, valueOf } from './model'
import {
  MAX_PERIODS,
  MEASURES,
  UNITS,
  bucketFilter,
  groupPipeline,
  binsPipeline,
  extentPipeline,
  numberOf,
  periodFilter,
  readGroups,
  rowFilter,
  scatterPipeline,
  timePipeline,
  type GroupRow,
  type Measure,
  type Unit,
} from './pipelines'

/**
 * Charts (plugins wave 2; redesigned 2026-10-10, spec plugin-tabs-redesign §2.3): a collection's
 * values as a bar, a line over time, a donut, a histogram or a scatter, within the Documents filter
 * or the whole collection. A chart draws as soon as a choice is made, to the frame's width, in the
 * user's accent; its numbers fold under it as a table whose rows show their documents in Documents.
 */
export type ChartType = 'bar' | 'line' | 'donut' | 'histogram' | 'scatter'
export type Scope = 'filter' | 'whole'
const TYPES: ChartType[] = ['bar', 'line', 'donut', 'histogram', 'scatter']
const TYPE_ICONS: Record<ChartType, IconName> = {
  bar: 'barChart',
  line: 'lineChart',
  donut: 'pieChart',
  histogram: 'columnChart',
  scatter: 'scatter',
}
/** Bars past these fold into "Other"; a donut holds fewer, past that its slices cannot be told apart. */
export const BAR_GROUPS = 12
export const DONUT_GROUPS = 7
const BINS = 12
const SAMPLE = 1000

const TR_OF: Record<Measure, string> = {
  count: 'sayısı',
  sum: 'toplamı',
  avg: 'ortalaması',
  min: 'en küçük değeri',
  max: 'en büyük değeri',
}
const TR_BY_UNIT: Record<Unit, string> = {
  hour: 'Saatlere',
  day: 'Günlere',
  week: 'Haftalara',
  month: 'Aylara',
  year: 'Yıllara',
}

const BASE = {
  en: {
    title: 'Charts',
    description: (coll: string) =>
      `Chart the values of ${coll}: by a field, over time, or how a number is spread.`,
    types: { bar: 'Bar', line: 'Over time', donut: 'Donut', histogram: 'Histogram', scatter: 'Scatter' },
    chartType: 'Chart type',
    field: 'Field',
    dateField: 'Date field',
    numberField: 'Number field',
    x: 'X axis',
    y: 'Y axis',
    unit: 'Period',
    units: { hour: 'Hour', day: 'Day', week: 'Week', month: 'Month', year: 'Year' } satisfies Record<
      Unit,
      string
    >,
    measure: 'Measure',
    measures: { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' } satisfies Record<
      Measure,
      string
    >,
    of: 'Of',
    draw: 'Draw',
    scopeLabel: 'Documents to chart',
    scopes: { filter: 'Documents filter', whole: 'Whole collection' } satisfies Record<Scope, string>,
    readingFields: 'Reading the fields…',
    drawing: 'Reading the documents…',
    emptyTitle: 'Pick what to chart',
    emptyHint: 'Choose a chart type and a field: the chart draws as you choose, and again with every change.',
    noFieldsTitle: 'Nothing to chart this way',
    noFields: {
      bar: 'A sample of this collection holds no text, number, true/false or ObjectId field to group by.',
      donut: 'A sample of this collection holds no text, number, true/false or ObjectId field to group by.',
      line: 'A sample of this collection holds no date field.',
      histogram: 'A sample of this collection holds no number field.',
      scatter: 'A sample of this collection holds no number field.',
    } satisfies Record<ChartType, string>,
    nothingTitle: 'Nothing to chart',
    nothingHint: (field: string, scope: Scope) =>
      scope === 'filter'
        ? `No document the Documents filter keeps has a value for ${field}.`
        : `No document of this collection has a value for ${field}.`,
    chartWhole: 'Chart the whole collection',
    noPlace: 'Open a collection to chart it.',
    failed: 'The chart could not be drawn: ',
    other: 'Other',
    missing: '(missing)',
    data: 'Data',
    show: 'Show',
    showHint: 'Show these documents in Documents',
    period: 'Period',
    range: 'Range',
    axis: 'Axis',
    pointsHead: 'Points',
    // A count of documents: the number (for its plural) and the number as the reader formats it.
    documents: (n: number, shownN: string) =>
      `${shownN} ${pluralOf(n, 'en') === 'one' ? 'document' : 'documents'}`,
    // The word alone, with no number: what a donut's centre caption reads under its total.
    documentsLabel: 'documents',
    values: (n: number, other: boolean) =>
      `${n} ${pluralOf(n, 'en') === 'one' ? 'value' : 'values'}${other ? ' and Other' : ''}`,
    periods: (n: number) => `${n} ${pluralOf(n, 'en') === 'one' ? 'period' : 'periods'}`,
    latest: 'the latest; older ones are left out',
    ranges: (n: number) => `${n} ${pluralOf(n, 'en') === 'one' ? 'range' : 'ranges'}`,
    points: (n: number, shownN: string) =>
      `${shownN} ${pluralOf(n, 'en') === 'one' ? 'point' : 'points'}, from a sample of at most 1,000 documents`,
    within: { filter: 'within the Documents filter', whole: 'whole collection' } satisfies Record<
      Scope,
      string
    >,
    byField: (measure: Measure, of: string | undefined, field: string) =>
      measure === 'count' ? `Documents by ${field}` : `${BASE.en.measures[measure]} of ${of} by ${field}`,
    overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
      `${measure === 'count' ? 'Documents' : `${BASE.en.measures[measure]} of ${of}`} per ${BASE.en.units[unit].toLowerCase()} (${field})`,
    spread: (field: string) => `How ${field} is spread`,
    share: (pct: string) => `Share: ${pct}`,
  },
  tr: {
    title: 'Grafikler',
    description: (coll: string) =>
      `${coll} koleksiyonunun değerlerini grafiğe dökün: bir alana göre, zamana göre ya da bir sayının nasıl dağıldığını.`,
    types: { bar: 'Çubuk', line: 'Zamana göre', donut: 'Halka', histogram: 'Histogram', scatter: 'Saçılım' },
    chartType: 'Grafik türü',
    field: 'Alan',
    dateField: 'Tarih alanı',
    numberField: 'Sayısal alan',
    x: 'X ekseni',
    y: 'Y ekseni',
    unit: 'Dönem',
    units: { hour: 'Saat', day: 'Gün', week: 'Hafta', month: 'Ay', year: 'Yıl' } satisfies Record<
      Unit,
      string
    >,
    measure: 'Ölçü',
    measures: {
      count: 'Adet',
      sum: 'Toplam',
      avg: 'Ortalama',
      min: 'En küçük',
      max: 'En büyük',
    } satisfies Record<Measure, string>,
    of: 'Değer alanı',
    draw: 'Çiz',
    scopeLabel: 'Hangi belgeler',
    scopes: { filter: 'Belgeler filtresi', whole: 'Tüm koleksiyon' } satisfies Record<Scope, string>,
    readingFields: 'Alanlar okunuyor…',
    drawing: 'Belgeler okunuyor…',
    emptyTitle: 'Neyi çizeceğinizi seçin',
    emptyHint:
      'Bir grafik türü ve bir alan seçin: grafik seçer seçmez çizilir, her değişiklikte de yenilenir.',
    noFieldsTitle: 'Bu türde çizilecek bir şey yok',
    noFields: {
      bar: 'Bu koleksiyondan alınan örnekte gruplanacak metin, sayı, doğru/yanlış ya da ObjectId alanı yok.',
      donut:
        'Bu koleksiyondan alınan örnekte gruplanacak metin, sayı, doğru/yanlış ya da ObjectId alanı yok.',
      line: 'Bu koleksiyondan alınan örnekte tarih alanı yok.',
      histogram: 'Bu koleksiyondan alınan örnekte sayısal alan yok.',
      scatter: 'Bu koleksiyondan alınan örnekte sayısal alan yok.',
    } satisfies Record<ChartType, string>,
    nothingTitle: 'Çizilecek bir şey yok',
    nothingHint: (field: string, scope: Scope) =>
      scope === 'filter'
        ? `Belgeler filtresinin bıraktığı hiçbir belgede ${field} için bir değer yok.`
        : `Bu koleksiyonun hiçbir belgesinde ${field} için bir değer yok.`,
    chartWhole: 'Tüm koleksiyonu çiz',
    noPlace: 'Grafik için bir koleksiyon açın.',
    failed: 'Grafik çizilemedi: ',
    other: 'Diğer',
    missing: '(eksik)',
    data: 'Veri',
    show: 'Göster',
    showHint: 'Bu belgeleri Belgeler sekmesinde göster',
    period: 'Dönem',
    range: 'Aralık',
    axis: 'Eksen',
    pointsHead: 'Nokta',
    documents: (_n: number, shownN: string) => `${shownN} belge`,
    documentsLabel: 'belge',
    values: (n: number, other: boolean) => `${n} değer${other ? ' ve Diğer' : ''}`,
    periods: (n: number) => `${n} dönem`,
    latest: 'en yenileri; daha eskileri dışarıda kaldı',
    ranges: (n: number) => `${n} aralık`,
    points: (_n: number, shownN: string) => `${shownN} nokta, en fazla 1.000 belgelik bir örnekten`,
    within: { filter: 'Belgeler filtresi içinde', whole: 'tüm koleksiyon' } satisfies Record<Scope, string>,
    // "price toplamı", "aylara göre": Turkish puts the measure after its field, and the period first.
    byField: (measure: Measure, of: string | undefined, field: string) =>
      `${field} alanına göre ${measure === 'count' ? 'belge sayısı' : `${of} ${TR_OF[measure]}`}`,
    overTime: (measure: Measure, of: string | undefined, unit: Unit, field: string) =>
      `${TR_BY_UNIT[unit]} göre ${measure === 'count' ? 'belge sayısı' : `${of} ${TR_OF[measure]}`} (${field})`,
    spread: (field: string) => `${field} dağılımı`,
    share: (pct: string) => `Pay: ${pct}`,
  },
}
export type Text = (typeof BASE)['en']
export const TEXT = { ...BASE, zh, ja, es, pt, ko, de, fr, ru } satisfies Record<Language, Text>

type Result =
  | {
      kind: 'groups'
      type: 'bar' | 'donut'
      field: string
      measure: Measure
      of?: string
      rows: GroupRow[]
      other: number | null
      rest: { count: number; sum: number | null } | null
      base: Doc
      scope: Scope
    }
  | {
      kind: 'time'
      field: string
      unit: Unit
      measure: Measure
      of?: string
      points: Array<{ ms: number; row: GroupRow }>
      capped: boolean
      base: Doc
      scope: Scope
    }
  | {
      kind: 'histogram'
      field: string
      buckets: Array<{ min: number; max: number; count: number }>
      base: Doc
      scope: Scope
    }
  | { kind: 'scatter'; x: string; y: string; points: Array<[number, number]>; scope: Scope }

/** Milliseconds of a canonical or relaxed Extended JSON date. */
function dateMs(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null
  const d = (v as { $date?: unknown }).$date
  if (typeof d === 'string') {
    const ms = Date.parse(d)
    return Number.isFinite(ms) ? ms : null
  }
  if (d && typeof d === 'object' && typeof (d as { $numberLong?: unknown }).$numberLong === 'string')
    return Number((d as { $numberLong: string }).$numberLong)
  return null
}

const double = (n: number) => ({ $numberDouble: Number.isInteger(n) ? n.toFixed(1) : String(n) })
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s/]+\))$/i

export function mount(root: HTMLElement, client: PluginClient): void {
  let text: Text = TEXT.en
  let locale = 'en'
  let ctx: PluginContext | null = null
  let info: FieldInfo[] = []
  let ready = false
  let type: ChartType = 'bar'
  let scope: Scope = 'filter'
  let last: Result | null = null
  let running = 0
  let busy = false
  let drawnWidth = 0

  const intl = () => langTag(shown(TEXT, locale))
  const num = (n: number) => formatNumber(n, shown(TEXT, locale))
  const compact = (n: number) =>
    new Intl.NumberFormat(intl(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  const pct = (share: number) =>
    new Intl.NumberFormat(intl(), { style: 'percent', maximumFractionDigits: 1 }).format(share)
  const currentFilter = (): Doc => ctx?.place?.filter ?? {}
  const hasFilter = () => Object.keys(currentFilter()).length > 0
  const base = (): Doc => (scope === 'filter' ? currentFilter() : {})

  // ---- the page
  const drawButton = button({ label: text.draw, icon: 'play', variant: 'primary', id: 'draw' })
  const header = pageHeader({ icon: 'barChart', title: text.title, description: '' })
  const types = segmented<ChartType>({
    label: text.chartType,
    id: 'types',
    options: TYPES.map((t) => ({ value: t, label: text.types[t], icon: TYPE_ICONS[t] })),
    value: 'bar',
    onChange: (next) => {
      type = next
      changed()
    },
  })
  const control = (id: string) => {
    const select = h('select', { id, class: 'mm-select' })
    const caption = h('span', { class: 'mm-label' })
    const el = h('label', { class: 'ch-control' }, caption, select)
    select.addEventListener('change', () => changed())
    return { el, select, caption }
  }
  // A tooltip names each type where a narrow frame shows only its icon (relabel keeps it current).
  types.el.querySelectorAll('button').forEach((b, i) => (b.title = text.types[TYPES[i]!]))
  const fieldControl = control('field')
  const unitControl = control('unit')
  const measureControl = control('measure')
  const ofControl = control('of')
  const yControl = control('y')
  const scopeControl = segmented<Scope>({
    label: text.scopeLabel,
    id: 'scope',
    options: [
      { value: 'filter', label: text.scopes.filter, icon: 'filter' },
      { value: 'whole', label: text.scopes.whole, icon: 'database' },
    ],
    value: 'filter',
    onChange: (next) => {
      scope = next
      changed()
    },
  })
  const filterChip = h('span', { id: 'filter', class: 'mm-chip mm-mono ch-filter' })
  const scopeRow = h('div', { class: 'ch-scope' }, scopeControl.el, filterChip)
  const status = statusLine('status')
  const chart = h('div', { id: 'chart', class: 'ch-chart' })
  const tip = h('div', { id: 'tip', class: 'ch-tip', hidden: true, attrs: { role: 'tooltip' } })
  const stage = h('div', { class: 'ch-stage' }, chart, tip)
  const summary = h('div', { id: 'summary', class: 'mm-table-wrap' })
  const dataTitle = h('span')
  const dataCount = badge('')
  const data = h(
    'details',
    { id: 'data', class: 'mm-details', hidden: true },
    h('summary', {}, icon('chevronRight', 14), dataTitle, dataCount),
    h('div', { class: 'mm-details-body' }, summary),
  )
  root.replaceChildren(
    h(
      'div',
      { class: 'mm-page' },
      header,
      h(
        'div',
        { class: 'mm-toolbar' },
        h('div', { class: 'mm-toolbar-row' }, types.el, h('span', { class: 'mm-spacer' }), drawButton),
        h(
          'div',
          { class: 'mm-toolbar-row' },
          fieldControl.el,
          unitControl.el,
          measureControl.el,
          ofControl.el,
          yControl.el,
          h('span', { class: 'mm-spacer' }),
          scopeRow,
        ),
      ),
      h('hr', { class: 'mm-divider' }),
      h('div', { class: 'mm-body' }, h('div', { class: 'mm-summary' }, status), stage, data),
    ),
  )

  // ---- the controls

  function options(select: HTMLSelectElement, values: readonly string[], label: (v: string) => string): void {
    const keep = select.value
    select.replaceChildren(...values.map((v) => h('option', { attrs: { value: v }, text: label(v) })))
    if (values.includes(keep)) select.value = keep
  }

  const numeric = () => fieldsFor(info, ['number'])
  /** What a type charts: grouped values (never a date or the unique _id), dates, or numbers. */
  function fieldsOf(t: ChartType): string[] {
    if (t === 'line') return fieldsFor(info, ['date'])
    if (t === 'bar' || t === 'donut')
      return fieldsFor(info, ['string', 'number', 'bool', 'objectId']).filter((f) => f !== '_id')
    return numeric()
  }
  const canDraw = () => !!ctx?.place && ready && fieldsOf(type).length > 0 && !!fieldControl.select.value

  /** The controls the chosen type needs, filled from the sample. */
  function arrange(): void {
    const fields = fieldsOf(type)
    options(fieldControl.select, fields, (v) => v)
    fieldControl.caption.textContent =
      type === 'line'
        ? text.dateField
        : type === 'scatter'
          ? text.x
          : type === 'histogram'
            ? text.numberField
            : text.field
    unitControl.el.hidden = type !== 'line'
    unitControl.caption.textContent = text.unit
    // Month first: a filled select already holds its first option (it once always said Hour).
    const firstUnits = !unitControl.select.options.length
    options(unitControl.select, UNITS, (u) => text.units[u as Unit])
    if (firstUnits) unitControl.select.value = 'month'
    const measured = type === 'bar' || type === 'line' || type === 'donut'
    measureControl.el.hidden = !measured
    measureControl.caption.textContent = text.measure
    const nums = numeric()
    // A donut shows parts of a whole: a count or a sum. Without a number field, only a count.
    options(
      measureControl.select,
      !nums.length ? ['count'] : type === 'donut' ? ['count', 'sum'] : MEASURES,
      (m) => text.measures[m as Measure],
    )
    ofControl.el.hidden = !measured || measureControl.select.value === 'count' || !nums.length
    ofControl.caption.textContent = text.of
    options(ofControl.select, nums, (v) => v)
    yControl.el.hidden = type !== 'scatter'
    yControl.caption.textContent = text.y
    options(yControl.select, nums, (v) => v)
    // A field against itself says nothing: Y takes another where there is one.
    if (type === 'scatter' && yControl.select.value === fieldControl.select.value && nums.length > 1)
      yControl.select.value = nums.find((n) => n !== fieldControl.select.value)!
    for (const c of [fieldControl, unitControl, measureControl, ofControl, yControl])
      c.select.disabled = !ready
    drawButton.disabled = busy || !canDraw()
  }

  function applyText(): void {
    header.setText(text.title, text.description(ctx?.place?.coll ?? ''))
    types.relabel(text.types)
    types.el.setAttribute('aria-label', text.chartType)
    scopeControl.relabel(text.scopes)
    scopeControl.el.setAttribute('aria-label', text.scopeLabel)
    setLabel(drawButton, text.draw)
    dataTitle.textContent = text.data
    scopeRow.hidden = !hasFilter()
    const filter = JSON.stringify(currentFilter())
    filterChip.textContent = filter.slice(0, 160)
    filterChip.title = filter.slice(0, 2000)
    arrange()
  }

  /** The chart's place before anything is drawn. */
  function idle(): void {
    status.textContent = ''
    hideTip()
    clearTable()
    if (!ctx?.place) return void chart.replaceChildren(emptyState({ icon: 'database', title: text.noPlace }))
    if (!ready)
      return void chart.replaceChildren(
        emptyState({ icon: 'barChart', title: text.emptyTitle, hint: text.readingFields }),
      )
    if (!fieldsOf(type).length)
      return void chart.replaceChildren(
        emptyState({
          icon: TYPE_ICONS[type],
          tone: 'warning',
          title: text.noFieldsTitle,
          hint: text.noFields[type],
        }),
      )
    chart.replaceChildren(
      emptyState({ icon: TYPE_ICONS[type], title: text.emptyTitle, hint: text.emptyHint }),
    )
  }

  /** Every choice draws (once the fields are read); one that leaves nothing to draw says so. */
  function changed(): void {
    arrange()
    if (canDraw()) void draw()
    else {
      running++
      last = null
      setBusyState(false)
      idle()
    }
  }

  // ---- the tooltip: a mark's words, as text

  const tips = new WeakMap<Element, string[]>()
  let hovered: Element | null = null
  function hideTip(): void {
    tip.hidden = true
    hovered?.classList.remove('ch-on')
    hovered = null
  }
  function placeTip(e: Event): void {
    const pointer = e as Partial<MouseEvent>
    const box = stage.getBoundingClientRect()
    let x = (pointer.clientX ?? 0) - box.left + 14
    const y = (pointer.clientY ?? 0) - box.top + 14
    if (x + tip.offsetWidth > box.width) x = Math.max(0, x - tip.offsetWidth - 28)
    tip.style.left = `${Math.round(x)}px`
    tip.style.top = `${Math.round(y)}px`
  }
  chart.addEventListener('pointerover', (e) => {
    let el = e.target as Element | null
    while (el && el !== chart && !tips.has(el)) el = el.parentElement
    const lines = el ? tips.get(el) : undefined
    if (!el || !lines) return hideTip()
    if (hovered !== el) {
      hovered?.classList.remove('ch-on')
      el.classList.add('ch-on')
      hovered = el
    }
    tip.replaceChildren(
      h('strong', { text: lines[0] ?? '' }),
      ...lines.slice(1).map((l) => h('span', { text: l })),
    )
    tip.hidden = false
    placeTip(e)
  })
  chart.addEventListener('pointermove', (e) => {
    if (!tip.hidden) placeTip(e)
  })
  chart.addEventListener('pointerleave', hideTip)

  // ---- drawing a result

  const width = () => Math.max(300, Math.round(chart.clientWidth) || 720)
  function paint(): Paint {
    const css = getComputedStyle(document.documentElement)
    const accent = css.getPropertyValue('--ds-accent').trim()
    const neutral = css.getPropertyValue('--ds-fg-subtle').trim()
    const dark = document.documentElement.classList.contains('dark')
    drawnWidth = width()
    return {
      width: drawnWidth,
      palette: paletteFrom(accent, dark),
      neutral: COLOUR.test(neutral) ? neutral : dark ? '#8a919c' : '#9ca3af',
      tip: (el, lines) => tips.set(el, lines),
      num,
      compact,
      pct,
    }
  }

  /** A group's key as words: "(missing)" for null or missing, numbers in the user's language. */
  function keyText(key: unknown): string {
    if (key === null || key === undefined) return text.missing
    const n = numberOf(key)
    if (n !== null) return num(n)
    return describeValue(key).text
  }
  const keyCell = (key: unknown) =>
    key === null || key === undefined
      ? h('span', { class: 'mm-value mm-v-null', text: text.missing })
      : valueView(key, 60)

  const dateFormat = (unit: Unit) =>
    new Intl.DateTimeFormat(
      intl(),
      unit === 'hour'
        ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }
        : unit === 'year'
          ? { year: 'numeric', timeZone: 'UTC' }
          : unit === 'month'
            ? { year: 'numeric', month: 'short', timeZone: 'UTC' }
            : { dateStyle: 'medium', timeZone: 'UTC' },
    )

  function clearTable(): void {
    summary.replaceChildren()
    data.hidden = true
  }
  type Cell = string | Node | { num: number | null }
  function fillTable(
    head: Array<{ label: string; numeric?: boolean }>,
    rows: Array<{ cells: Cell[]; filter?: Doc }>,
  ): void {
    const t = table([...head, { label: '' }])
    for (const r of rows) {
      const cells = r.cells.map((c) =>
        typeof c === 'object' && c !== null && 'num' in c
          ? { node: c.num === null ? '—' : num(c.num), numeric: true }
          : c,
      )
      const filter = r.filter
      const action = filter
        ? button({
            label: text.show,
            icon: 'filter',
            variant: 'ghost',
            size: 'sm',
            title: text.showHint,
            onClick: () => {
              void client
                .ask('ui.useQuery', { filter })
                .catch((e: unknown) => (status.textContent = `${text.failed}${askMessage(e, locale)}`))
            },
          })
        : null
      t.row(...cells, { node: action ? h('div', { class: 'mm-row-actions' }, action) : null })
    }
    summary.replaceChildren(t.el)
    dataCount.textContent = String(rows.length)
    data.hidden = !rows.length
  }

  function summaryLine(title: string, ...facts: string[]): void {
    status.replaceChildren(h('strong', { text: title }), ...facts.filter(Boolean).map((f) => ` · ${f}`))
  }
  const scopeFact = (r: { scope: Scope }) => (hasFilter() ? text.within[r.scope] : '')

  function nothing(field: string, r: { scope: Scope }): void {
    clearTable()
    status.textContent = ''
    const offer =
      r.scope === 'filter' && hasFilter()
        ? button({
            label: text.chartWhole,
            icon: 'database',
            size: 'sm',
            onClick: () => {
              scopeControl.set('whole')
              scope = 'whole'
              changed()
            },
          })
        : null
    chart.replaceChildren(
      callout('info', text.nothingTitle, text.nothingHint(field, r.scope), ...(offer ? [offer] : [])),
    )
  }

  /** Draws the last result again: a new width, language, theme or accent. */
  function render(): void {
    hideTip()
    const r = last
    if (!r) return idle()
    const p = paint()
    if (r.kind === 'groups') {
      if (!r.rows.length) return nothing(r.field, r)
      const keyName = (key: unknown, other?: boolean) => (other ? text.other : keyText(key))
      const marks = groupMarks(r.rows, r.measure, r.other)
      const sum = marks.reduce((n, m) => n + Math.max(0, m.value), 0)
      const valueName = r.measure === 'count' ? text.measures.count : `${text.measures[r.measure]} (${r.of})`
      const parts: Part[] = marks.map((m) => ({
        label: keyName(m.key, m.other),
        value: m.value,
        ...(m.other ? { other: true } : {}),
        tip: [
          keyName(m.key, m.other),
          `${valueName}: ${num(m.value)}`,
          ...(r.type === 'donut' || r.measure === 'count' || r.measure === 'sum'
            ? sum
              ? [text.share(pct(Math.max(0, m.value) / sum))]
              : []
            : []),
        ],
      }))
      const title = text.byField(r.measure, r.of, r.field)
      const total = r.rows.reduce((n, g) => n + g.count, 0) + (r.rest?.count ?? 0)
      if (r.type === 'bar') bars(chart, parts, p, title)
      else
        donut(chart, parts, p, title, compact(sum), r.measure === 'count' ? text.documentsLabel : valueName)
      summaryLine(
        title,
        text.documents(total, num(total)),
        text.values(
          r.rows.length,
          marks.some((m) => m.other),
        ),
        scopeFact(r),
      )
      const extra = r.of
        ? [text.measures.sum, text.measures.avg, text.measures.min, text.measures.max].map((label) => ({
            label,
            numeric: true,
          }))
        : []
      fillTable(
        [{ label: r.field }, { label: text.measures.count, numeric: true }, ...extra],
        [
          ...r.rows.map((g) => ({
            cells: [
              keyCell(g.key),
              { num: g.count },
              ...(r.of ? [{ num: g.sum }, { num: g.avg }, { num: g.min }, { num: g.max }] : []),
            ],
            filter: rowFilter(r.field, g.key, r.base),
          })),
          ...(r.rest
            ? [
                {
                  cells: [
                    h('span', { class: 'ch-other', text: text.other }),
                    { num: r.rest.count },
                    ...(r.of ? [{ num: r.rest.sum }, { num: null }, { num: null }, { num: null }] : []),
                  ],
                },
              ]
            : []),
        ],
      )
    } else if (r.kind === 'time') {
      if (!r.points.length) return nothing(r.field, r)
      const fmt = dateFormat(r.unit)
      const valueName = r.measure === 'count' ? text.measures.count : `${text.measures[r.measure]} (${r.of})`
      const filled = fillPeriods(
        r.points.map((q) => ({ ms: q.ms, value: valueOf(q.row, r.measure) })),
        r.unit,
        r.measure,
      )
      const title = text.overTime(r.measure, r.of, r.unit, r.field)
      line(
        chart,
        filled.map((q) => ({ ...q, tip: [fmt.format(q.ms), `${valueName}: ${num(q.value)}`] })),
        p,
        title,
        (ms) => fmt.format(ms),
      )
      summaryLine(
        title,
        `${text.periods(r.points.length)}${r.capped ? `: ${text.latest}` : ''}`,
        text.documents(
          r.points.reduce((n, q) => n + q.row.count, 0),
          num(r.points.reduce((n, q) => n + q.row.count, 0)),
        ),
        scopeFact(r),
      )
      const extra = r.of
        ? [text.measures.sum, text.measures.avg, text.measures.min, text.measures.max].map((label) => ({
            label,
            numeric: true,
          }))
        : []
      fillTable(
        [{ label: text.period }, { label: text.measures.count, numeric: true }, ...extra],
        r.points.map((q) => ({
          cells: [
            fmt.format(q.ms),
            { num: q.row.count },
            ...(r.of ? [{ num: q.row.sum }, { num: q.row.avg }, { num: q.row.min }, { num: q.row.max }] : []),
          ],
          filter: periodFilter(r.field, q.ms, r.unit, r.base),
        })),
      )
    } else if (r.kind === 'histogram') {
      if (!r.buckets.length) return nothing(r.field, r)
      const range = (b: { min: number; max: number }) => `${num(b.min)} – ${num(b.max)}`
      const title = text.spread(r.field)
      columns(
        chart,
        r.buckets.map((b) => ({
          label: range(b),
          value: b.count,
          tip: [range(b), `${text.measures.count}: ${num(b.count)}`],
        })),
        [...r.buckets.map((b) => compact(b.min)), compact(r.buckets.at(-1)!.max)],
        p,
        title,
      )
      summaryLine(
        title,
        text.documents(
          r.buckets.reduce((n, b) => n + b.count, 0),
          num(r.buckets.reduce((n, b) => n + b.count, 0)),
        ),
        text.ranges(r.buckets.length),
        scopeFact(r),
      )
      fillTable(
        [{ label: text.range }, { label: text.measures.count, numeric: true }],
        r.buckets.map((b, i) => ({
          cells: [range(b), { num: b.count }],
          ...(b.count
            ? {
                filter: bucketFilter(
                  r.field,
                  double(b.min),
                  double(b.max),
                  i === r.buckets.length - 1,
                  r.base,
                ),
              }
            : {}),
        })),
      )
    } else {
      if (!r.points.length) return nothing(r.x, r)
      const title = `${r.x} × ${r.y}`
      scatter(
        chart,
        r.points.map(([x, y]) => ({ x, y, tip: [`${r.x}: ${num(x)}`, `${r.y}: ${num(y)}`] })),
        p,
        title,
        { x: r.x, y: r.y },
      )
      summaryLine(title, text.points(r.points.length, num(r.points.length)), scopeFact(r))
      const stats = (i: 0 | 1) => {
        const values = r.points.map((q) => q[i])
        return [
          { num: values.reduce((a, b) => Math.min(a, b), Infinity) },
          { num: values.reduce((a, b) => a + b, 0) / values.length },
          { num: values.reduce((a, b) => Math.max(a, b), -Infinity) },
        ]
      }
      fillTable(
        [
          { label: text.axis },
          { label: text.pointsHead, numeric: true },
          { label: text.measures.min, numeric: true },
          { label: text.measures.avg, numeric: true },
          { label: text.measures.max, numeric: true },
        ],
        [
          { cells: [`X — ${r.x}`, { num: r.points.length }, ...stats(0)] },
          { cells: [`Y — ${r.y}`, { num: r.points.length }, ...stats(1)] },
        ],
      )
    }
  }

  // ---- reading

  type Answer = { documents: Doc[]; truncated?: boolean }
  /** Asked for a chart no longer wanted: dropped before it reaches the app. */
  const superseded = new Error('superseded')
  // The app runs one pipeline of a frame at a time and refuses the next ("busy"): each waits for
  // the one before, and one for a chart passed over (a type stepped through) is not sent at all.
  const ask = serialAsk(
    (params: { pipeline: Doc[]; limit: number }, wanted: () => boolean): Promise<Answer> =>
      wanted() ? client.ask<Answer>('documents.aggregate', params) : Promise.reject(superseded),
  )
  /** The pipeline's answer while the draw `run` is the latest. */
  const aggregate = (run: number, pipeline: Doc[], limit: number) =>
    ask({ pipeline, limit }, () => run === running)

  function setBusyState(on: boolean): void {
    busy = on
    drawButton.setAttribute('aria-busy', String(on))
    drawButton.disabled = on || !canDraw()
  }

  /** Reads what the controls ask for and draws it; a later choice wins over an earlier answer. */
  async function read(run: number): Promise<Result> {
    // What was asked, read before any answer: the controls may have moved on by then.
    const field = fieldControl.select.value
    const filter = base()
    const at = scope
    const asked = type
    if (asked === 'bar' || asked === 'donut') {
      const measure = measureControl.select.value as Measure
      const of = measure === 'count' ? undefined : ofControl.select.value || undefined
      const top = asked === 'bar' ? BAR_GROUPS : DONUT_GROUPS
      const { documents: docs } = await aggregate(
        run,
        groupPipeline({ field, measure, ...(of ? { of } : {}), filter, top }),
        1,
      )
      return {
        kind: 'groups',
        type: asked,
        field,
        measure,
        ...(of ? { of } : {}),
        ...readGroups(docs, measure),
        base: filter,
        scope: at,
      }
    }
    if (asked === 'line') {
      const unit = unitControl.select.value as Unit
      const measure = measureControl.select.value as Measure
      const of = measure === 'count' ? undefined : ofControl.select.value || undefined
      // The pipeline keeps one period more than this reads: the app says when it had more to give.
      const answer = await aggregate(
        run,
        timePipeline({ field, unit, measure, ...(of ? { of } : {}), filter }),
        MAX_PERIODS,
      )
      const docs = answer.documents.slice(0, MAX_PERIODS)
      const points = readGroups([{ groups: docs, total: [] }], measure)
        .rows.reverse()
        .map((row) => ({ ms: dateMs(row.key), row }))
        .filter((q): q is { ms: number; row: GroupRow } => q.ms !== null)
      return {
        kind: 'time',
        field,
        unit,
        measure,
        ...(of ? { of } : {}),
        points,
        capped: !!answer.truncated || answer.documents.length > MAX_PERIODS,
        base: filter,
        scope: at,
      }
    }
    if (asked === 'histogram') {
      // The range first, then bins of one width over it.
      const [extent] = (await aggregate(run, extentPipeline({ field, filter }), 1)).documents
      const [min, max] = [numberOf(extent?.min), numberOf(extent?.max)]
      if (min === null || max === null)
        return { kind: 'histogram', field, buckets: [], base: filter, scope: at }
      const edges = binEdges(min, max, BINS)
      const bins = edges.length - 1
      const { documents: docs } = await aggregate(
        run,
        binsPipeline({ field, filter, start: edges[0]!, step: edges[1]! - edges[0]!, bins }),
        bins,
      )
      const counts = new Map(docs.map((d) => [numberOf(d._id), numberOf(d.count) ?? 0]))
      const buckets = edges
        .slice(0, -1)
        .map((edge, i) => ({ min: edge, max: edges[i + 1]!, count: counts.get(i) ?? 0 }))
      return { kind: 'histogram', field, buckets, base: filter, scope: at }
    }
    const y = yControl.select.value
    const { documents: docs } = await aggregate(
      run,
      scatterPipeline({ x: field, y, filter, size: SAMPLE }),
      SAMPLE,
    )
    const points = docs
      .map((d) => [numberOf(d.x), numberOf(d.y)] as const)
      .filter((q): q is readonly [number, number] => q[0] !== null && q[1] !== null)
      .map(([a, b]) => [a, b] as [number, number])
    return { kind: 'scatter', x: field, y, points, scope: at }
  }

  async function draw(): Promise<void> {
    if (!canDraw()) return
    const run = ++running
    setBusyState(true)
    hideTip()
    status.textContent = text.drawing
    chart.replaceChildren(h('div', { class: 'ch-loading' }, skeleton(6)))
    try {
      const result = await read(run)
      if (run !== running) return
      last = result
      render()
    } catch (e) {
      if (run !== running) return
      last = null
      clearTable()
      status.textContent = ''
      chart.replaceChildren(
        emptyState({ icon: 'error', tone: 'danger', title: `${text.failed}${askMessage(e, locale)}` }),
      )
    } finally {
      if (run === running) setBusyState(false)
    }
  }

  drawButton.addEventListener('click', () => void draw())

  // A narrower or wider frame draws again, once it settles.
  let resizing: ReturnType<typeof setTimeout> | undefined
  const resized = () => {
    clearTimeout(resizing)
    resizing = setTimeout(() => {
      if (last && !busy && width() !== drawnWidth) render()
    }, 150)
  }
  window.addEventListener('resize', resized)
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resized).observe(chart)

  const setLanguage = (next: string) => {
    locale = next
    text = pick(TEXT, locale)
    document.documentElement.lang = langTag(shown(TEXT, locale))
  }
  client.onContext((next, theme, accent) => {
    setLanguage(next)
    applyLook(theme, accent)
    applyText()
    if (busy) status.textContent = text.drawing
    else render()
  })
  client.onReady(async () => {
    ctx = await client.ask<PluginContext>('context.get')
    setLanguage(ctx.locale)
    applyLook(ctx.theme, ctx.accent)
    applyText()
    idle()
    if (!ctx.place) return
    try {
      const sample = await ask(
        { pipeline: [{ $sample: { size: { $numberInt: '200' } } }], limit: 200 },
        () => true,
      )
      info = fieldInfo(sample.documents)
    } catch {
      info = []
    }
    ready = true
    arrange()
    if (!last && !busy) idle()
  })
  applyText()
  idle()
}
