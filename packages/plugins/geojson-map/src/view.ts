import '../../kit/src/ui.css'
import './style.css'
import { askMessage, type PluginClient, type PluginContext } from '../../kit/src/client'
import {
  applyLook,
  badge,
  button,
  callout,
  chip,
  emptyState,
  formatNumber,
  h,
  langTag,
  icon,
  pageHeader,
  setLabel,
  statusLine,
  table,
  valueView,
} from '../../kit/src/ui'
import { cellText, featuresOf, fieldOf, type Feature } from './geo'
import { createMap, type Drawn, type DrawKind, type MapView, type Pick } from './map'
import { polygonProblem, withinBounds, withinCircle, withinPolygon, type Doc as AreaDoc } from './area'
import { readDocuments } from './read'
import { textFor, wordsLanguage, type Text } from './text'

/**
 * The map plugin (phase 4b §4; redesigned 2026-10-10, spec plugin-tabs-redesign §2.5): the shapes
 * and places of the documents of the current query — or of one document ("Show on map") — on a
 * map. Places close together are one circle with their count; a click zooms in, or shows the
 * document in a small card with Open. No tiles unless an administrator set a tile server: a light
 * graticule instead, and a note saying so. A cell renderer ("lat, lng") shares the page.
 */

type Doc = Record<string, unknown>
const SHAPE_ROWS = 200
const POP_FIELDS = 4
const POP_LIST = 8

/** The _id as a line shows it. */
function idText(id: unknown): string {
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  if (id && typeof id === 'object') {
    const o = id as Record<string, unknown>
    for (const k of ['$oid', '$numberInt', '$numberLong', '$numberDouble', '$uuid'])
      if (typeof o[k] === 'string') return o[k] as string
  }
  return JSON.stringify(id) ?? ''
}

/** Only an http(s) template is a tile server (the app checks it too; a frame trusts nothing). */
function tileServer(settings: PluginContext['settings']): { url: string; credit: string } | null {
  const url = typeof settings.tileUrl === 'string' ? settings.tileUrl.trim() : ''
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null
  const given = typeof settings.tileAttribution === 'string' ? settings.tileAttribution.trim() : ''
  try {
    return { url, credit: given || new URL(url.replace('{s}', 'a')).host }
  } catch {
    return null
  }
}

export function mount(root: HTMLElement, client: PluginClient): void {
  // A cell renderer answers values; it draws nothing.
  if (client.contribution.kind === 'cellRenderer') {
    client.onCells((_renderer, values) => values.map(cellText))
    return
  }
  const oneDocument = client.contribution.kind === 'documentAction'
  let text: Text = textFor('en')
  let locale = 'en'
  let ctx: PluginContext | null = null
  type Row = { feature: Feature; doc: Doc; field: string }
  let rows: Row[] = []
  let shown: Row[] = []
  let readCount = 0
  let more = false
  let field: string | null = null
  let state: 'waiting' | 'loading' | 'ready' | 'none' | 'failed' | 'noPlace' = 'waiting'
  let failure = ''
  let pick: Pick | null = null
  let popError = ''
  let map: MapView | null = null

  // ---- the page
  const fieldSelect = h('select', { id: 'field', class: 'mm-select gm-field' })
  const fitButton = button({ label: text.fit, icon: 'fit', iconOnly: true, id: 'fit', variant: 'ghost' })
  const zoomOut = button({
    label: text.zoomOut,
    icon: 'minus',
    iconOnly: true,
    id: 'zoom-out',
    variant: 'ghost',
  })
  const zoomIn = button({ label: text.zoomIn, icon: 'plus', iconOnly: true, id: 'zoom-in', variant: 'ghost' })
  const zoomGroup = h('div', { class: 'gm-zoom' }, zoomOut, zoomIn)
  // Map 1.2 (research 2026-10-28): an area drawn — or the one in view — filters the documents.
  const drawArea = button({
    label: text.drawArea,
    icon: 'shapes',
    iconOnly: true,
    id: 'draw-area',
    variant: 'ghost',
  })
  const drawCircle = button({
    label: text.drawCircle,
    icon: 'circle',
    iconOnly: true,
    id: 'draw-circle',
    variant: 'ghost',
  })
  const inView = button({
    label: text.inView,
    icon: 'filter',
    iconOnly: true,
    id: 'in-view',
    variant: 'ghost',
  })
  const drawGroup = h('div', { class: 'gm-zoom gm-draw' }, drawArea, drawCircle, inView)
  const header = pageHeader({
    icon: 'mapPin',
    title: text.title,
    description: '',
    actions: [fieldSelect, ...(oneDocument ? [] : [drawGroup]), fitButton, zoomGroup],
  })
  const status = statusLine('status')
  const fieldSlot = h('span', { class: 'gm-field-slot' })
  const hint = h('span', { class: 'mm-subtle gm-hint' })
  const mapEl = h('div', { id: 'map' })
  const overlay = h('div', { class: 'gm-overlay' })
  const floating = h('div', { class: 'gm-float' })
  const popSlot = h('div', { class: 'gm-pop-slot' })
  // What drawing asks, said once when it starts (its Cancel outside the words read out).
  const drawText = h('p', { id: 'drawing-text', class: 'gm-drawing-text' })
  // Read out when a drawing starts: always in the page, so its words are heard (review 2026-10-29).
  const drawLive = h('p', { id: 'drawing-live', class: 'mm-sr', attrs: { role: 'status' } })
  const drawCancel = button({
    label: text.cancel,
    size: 'sm',
    id: 'draw-cancel',
    onClick: () => map?.stopDrawing(),
  })
  const drawBar = h('div', { id: 'drawing', class: 'gm-drawbar mm-card', hidden: true }, drawText, drawCancel)
  // What a filter came to, over the map: the map's size stays (review 2026-10-28).
  const drawDone = h('div', { id: 'draw-done', attrs: { role: 'status' } })
  const drawFailed = h('div', { id: 'draw-failed', attrs: { role: 'alert' } })
  const drawNote = h('div', { id: 'draw-note', class: 'gm-draw-note' }, drawDone, drawFailed)
  /** Why the drawing tools are off, as words on the page. */
  const drawWhy = h('p', { id: 'draw-why', class: 'mm-subtle gm-draw-why', hidden: true })
  const stage = h(
    'div',
    { class: 'gm-stage' },
    mapEl,
    overlay,
    floating,
    popSlot,
    drawBar,
    drawNote,
    drawLive,
  )
  const shapesSlot = h('div', { class: 'gm-shapes-slot' })
  const body = h(
    'div',
    { class: 'mm-body gm-body' },
    h('div', { class: 'mm-summary' }, status, fieldSlot, drawWhy, h('span', { class: 'mm-spacer' }), hint),
    stage,
    shapesSlot,
  )
  root.replaceChildren(h('div', { class: 'mm-page gm-page' }, header, h('hr', { class: 'mm-divider' }), body))

  const open = (doc: Doc) => {
    popError = ''
    void client.ask('ui.openDocument', { id: doc._id }).catch((e: unknown) => {
      popError = askMessage(e, locale)
      renderPop()
    })
  }
  const nameOf = (r: Row) => r.feature.properties.label ?? idText(r.feature.properties._id)

  // ---- the summary and the controls
  /**
   * What a drawn area filters: the field, the paths its shapes are read at (a Feature's geometry, a
   * FeatureCollection's features: one field may have several, joined by $or, review I5), and whether
   * some of its shapes no filter can name; or why none (`null`: not now — loading, no shapes).
   */
  type Target =
    | { field: string; paths: string[]; partial: boolean }
    | { why: null | 'field' }
    | { why: 'cannot'; field: string }
  let target: Target = { why: null }
  function findTarget(): void {
    if (!map || state !== 'ready') return void (target = { why: null })
    const fields = fieldsOf()
    const chosen = field ?? (fields.length === 1 ? fields[0]!.field : null)
    if (!chosen) return void (target = { why: 'field' })
    const queries = rows.filter((r) => r.field === chosen).map((r) => r.feature.properties.query)
    const paths = [...new Set(queries.filter((q): q is string => q !== null))]
    target = paths.length
      ? { field: chosen, paths, partial: queries.includes(null) }
      : { why: 'cannot', field: chosen }
  }
  let drawing: DrawKind | null = null
  let note: { kind: 'done' | 'failed'; text: string } | null = null
  /** The tools' state: cheap, on every move of the map (review I6). */
  function renderDrawButtons(): void {
    const off = 'why' in target
    const why =
      'why' in target && target.why === 'field'
        ? text.drawFieldFirst
        : 'why' in target && target.why === 'cannot'
          ? text.drawCannot(target.field)
          : 'partial' in target && target.partial
            ? text.leftOut(target.field)
            : ''
    for (const b of [drawArea, drawCircle, inView]) {
      b.disabled = off
      // Each tool names it: why it is off, or what it leaves out.
      if (why) b.setAttribute('aria-describedby', 'draw-why')
      else b.removeAttribute('aria-describedby')
    }
    drawArea.setAttribute('aria-pressed', String(drawing === 'polygon'))
    drawCircle.setAttribute('aria-pressed', String(drawing === 'circle'))
    if (drawWhy.textContent !== why) drawWhy.textContent = why
    drawWhy.hidden = !why
  }
  /** What drawing asks: when it starts or ends, or the words change. */
  function renderDrawBar(): void {
    drawBar.hidden = drawing === null
    setLabel(drawCancel, text.cancel)
    const asks = drawing === 'polygon' ? text.drawingArea : drawing ? text.drawingCircle : ''
    const keys = drawing === 'polygon' ? text.drawingAreaKeys : drawing ? text.drawingCircleKeys : ''
    drawText.replaceChildren(
      ...(drawing ? [h('span', { text: asks }), h('span', { class: 'mm-subtle', text: keys })] : []),
    )
    const said = drawing ? `${asks} ${keys}` : ''
    if (drawLive.textContent !== said) drawLive.textContent = said
  }
  function renderNote(): void {
    const shown = (kind: 'done' | 'failed') =>
      note?.kind === kind
        ? [
            callout(
              kind === 'done' ? 'success' : 'danger',
              note.text,
              undefined,
              button({
                label: text.dismiss,
                icon: 'x',
                iconOnly: true,
                size: 'sm',
                variant: 'ghost',
                onClick: () => {
                  note = null
                  renderNote()
                },
              }),
            ),
          ]
        : []
    drawDone.replaceChildren(...shown('done'))
    drawFailed.replaceChildren(...shown('failed'))
  }
  /** The area on each of the target's paths: one, or any of them. */
  function areaFilter(t: { paths: string[] }, make: (path: string) => AreaDoc | null): AreaDoc | null {
    const parts = t.paths.map(make)
    if (parts.some((x) => x === null)) return null
    return parts.length === 1 ? parts[0]! : { $or: parts }
  }
  /** A clause an earlier drawing put in the filter: the area there, on these paths. */
  function isAreaClause(c: unknown, paths: readonly string[]): boolean {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false
    const o = c as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length !== 1) return false
    if (keys[0] === '$or')
      return Array.isArray(o.$or) && o.$or.length > 0 && o.$or.every((x) => isAreaClause(x, paths))
    const v = o[keys[0]!]
    return (
      paths.includes(keys[0]!) &&
      !!v &&
      typeof v === 'object' &&
      Object.keys(v).length === 1 &&
      Object.hasOwn(v, '$geoWithin')
    )
  }
  /**
   * The area beside the Documents filter in use: its clauses kept, an area an earlier drawing put
   * there replaced, not narrowed again (review 2026-10-28).
   */
  function withCurrent(area: AreaDoc, paths: readonly string[]): AreaDoc {
    const current = (ctx?.place?.filter ?? {}) as AreaDoc
    // Each of its keys is a clause of its own ({ a, b } is { $and: [{ a }, { b }] }), $and's flat.
    const clauses = Object.entries(current).flatMap(([k, v]) =>
      k === '$and' && Array.isArray(v) ? (v as unknown[]) : [{ [k]: v }],
    )
    const kept = clauses.filter((c) => !isAreaClause(c, paths))
    kept.push(area)
    return kept.length === 1 ? (kept[0] as AreaDoc) : { $and: kept }
  }
  /** The area's filter, put in the Documents query. */
  function filterBy(area: AreaDoc | null, t: { field: string; paths: string[]; partial: boolean }): void {
    if (!area) return
    void client.ask('ui.useQuery', { filter: withCurrent(area, t.paths) }).then(
      () => {
        note = { kind: 'done', text: text.filtered(t.field) }
        renderNote()
      },
      (e: unknown) => {
        note = { kind: 'failed', text: `${text.filterFailed}${askMessage(e, locale)}` }
        renderNote()
      },
    )
  }
  function startDrawing(kind: DrawKind, from: HTMLButtonElement): void {
    if (!map || 'why' in target) return
    // A second click on the tool in use puts it down.
    if (drawing === kind) return map.stopDrawing()
    // An earlier drawing ends before this one starts: its end never ends this one (review I2).
    map.stopDrawing()
    // The target as it is now: a field chosen meanwhile stops the drawing (review I3).
    const t = target
    closePop()
    note = null
    renderNote()
    drawing = kind
    renderDrawButtons()
    renderDrawBar()
    mapEl.focus({ preventScroll: true })
    map.draw(kind, (area: Drawn | null) => {
      drawing = null
      renderDrawButtons()
      renderDrawBar()
      // Focus left on Cancel, gone with the bar, goes back to the tool (review 2026-10-28).
      if (drawBar.contains(document.activeElement) || document.activeElement === document.body)
        from.focus({ preventScroll: true })
      if (!area) return
      if (area.kind === 'circle')
        return filterBy(
          areaFilter(t, (path) => withinCircle(path, area.center, area.radius)),
          t,
        )
      const problem = polygonProblem(area.ring)
      if (problem) {
        note = { kind: 'failed', text: text.noArea[problem] }
        return renderNote()
      }
      filterBy(
        areaFilter(t, (path) => withinPolygon(path, area.ring)),
        t,
      )
    })
  }
  drawArea.addEventListener('click', () => startDrawing('polygon', drawArea))
  drawCircle.addEventListener('click', () => startDrawing('circle', drawCircle))
  inView.addEventListener('click', () => {
    if (!map || 'why' in target) return
    // The area in view instead of the one being drawn.
    map.stopDrawing()
    const t = target
    const bounds = map.viewBounds()
    filterBy(
      areaFilter(t, (path) => withinBounds(path, bounds)),
      t,
    )
  })

  function renderControls(): void {
    const has = !!map && shown.length > 0
    renderDrawButtons()
    fitButton.disabled = !has
    const z = map?.zoom() ?? 0
    const limits = map?.limits() ?? { min: 0, max: 0 }
    zoomIn.disabled = !map || z >= limits.max
    zoomOut.disabled = !map || z <= limits.min
  }

  function fieldsOf(): Array<{ field: string; count: number }> {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.field, (counts.get(r.field) ?? 0) + 1)
    return [...counts].map(([f, count]) => ({ field: f, count }))
  }

  function renderSummary(): void {
    const fields = fieldsOf()
    fieldSelect.hidden = fields.length < 2
    if (fields.length >= 2) {
      fieldSelect.replaceChildren(
        h('option', { attrs: { value: '' }, text: text.allFields }),
        ...fields.map((f) => h('option', { attrs: { value: f.field }, text: `${f.field} · ${f.count}` })),
      )
      fieldSelect.value = field ?? ''
      fieldSelect.setAttribute('aria-label', text.fieldLabel)
      fieldSelect.title = text.fieldTitle
    }
    if (fields.length === 1) {
      const c = chip({ label: fields[0]!.field, icon: 'mapPin', mono: true, title: text.fieldTitle })
      c.id = 'field-chip'
      fieldSlot.replaceChildren(c)
    } else fieldSlot.replaceChildren()
    hint.textContent = ''
    if (state === 'loading') status.textContent = text.loading
    else if (state === 'ready') {
      const docs = new Set(shown.map((r) => JSON.stringify(r.feature.properties._id))).size
      status.replaceChildren(
        h('strong', { text: text.shapes(docs, shown.length, wordsLanguage(locale)) }),
        ...(more ? [document.createTextNode(` · ${text.more(readCount)}`)] : []),
      )
      hint.textContent = shown.length > 1 ? text.hint : ''
    } else if (state === 'noPlace' || state === 'waiting') status.textContent = ''
    else status.textContent = state === 'failed' ? text.failed : ''
  }

  // ---- what lies over the map: loading, nothing found, a failure; the no-tiles note
  let noTiles: HTMLElement | null = null
  let noTilesDismissed = false
  function renderOverlay(): void {
    overlay.replaceChildren()
    overlay.hidden = state === 'ready' || state === 'waiting'
    if (state === 'loading')
      overlay.append(
        h(
          'div',
          { class: 'gm-loading mm-busy', attrs: { role: 'presentation' } },
          icon('loader', 15),
          text.loading,
        ),
      )
    else if (state === 'none')
      overlay.append(emptyState({ icon: 'mapPin', title: text.noneTitle, hint: text.noneHint(readCount) }))
    else if (state === 'failed')
      overlay.append(
        emptyState({
          icon: 'error',
          tone: 'danger',
          title: text.failed,
          ...(failure ? { hint: failure } : {}),
        }),
      )
    if (noTiles) {
      const dismiss = button({
        label: text.dismiss,
        icon: 'x',
        iconOnly: true,
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          noTilesDismissed = true
          noTiles!.hidden = true
        },
      })
      const next = callout('info', text.noTilesTitle, text.noTilesText, dismiss)
      next.id = 'no-tiles'
      next.classList.add('gm-note')
      next.hidden = noTilesDismissed
      noTiles.replaceWith(next)
      noTiles = next
    }
  }

  // ---- the card of a place
  /** Where focus was when the card opened (the map, or a row of the table): it goes back there. */
  let returnTo: HTMLElement | null = null
  let focusCard = false
  const focusIn = () => popSlot.contains(document.activeElement)
  function closePop(): void {
    const had = focusIn()
    pick = null
    popError = ''
    popSlot.replaceChildren()
    map?.select(null)
    if (had) (returnTo?.isConnected ? returnTo : mapEl).focus({ preventScroll: true })
    returnTo = null
    focusCard = false
  }
  function renderPop(): void {
    if (!pick || !map) return void popSlot.replaceChildren()
    // Drawn again (a new language, a failed Open): focus stays in it.
    const had = focusIn()
    const close = button({
      label: text.close,
      icon: 'x',
      iconOnly: true,
      variant: 'ghost',
      size: 'sm',
      onClick: closePop,
    })
    let card: HTMLElement
    let first: HTMLElement
    if (pick.kind === 'one') {
      const r = shown[pick.item]
      if (!r) return closePop()
      const props = r.feature.properties
      const root0 = fieldOf(props.field).split('.')[0]
      const fields = Object.entries(r.doc)
        .filter(
          ([k, v]) =>
            k !== '_id' && k !== root0 && !(typeof v === 'string' && v.trim().slice(0, 60) === props.label),
        )
        .slice(0, POP_FIELDS)
      card = h(
        'div',
        { class: 'gm-pop mm-card', attrs: { role: 'dialog', 'aria-label': nameOf(r) } },
        h(
          'div',
          { class: 'gm-pop-head' },
          h(
            'div',
            { class: 'gm-pop-titles' },
            h('p', { class: 'gm-pop-title', text: props.label ?? text.document }),
            h('span', { class: 'gm-pop-id' }, valueView(props._id, 48)),
          ),
          close,
        ),
        fields.length
          ? h(
              'dl',
              { class: 'gm-pop-fields' },
              ...fields.map(([k, v]) =>
                h(
                  'div',
                  { class: 'gm-pop-row' },
                  h('dt', { class: 'mm-key', text: k }),
                  h('dd', {}, valueView(v, 40)),
                ),
              ),
            )
          : null,
        popError ? h('p', { class: 'gm-pop-error', attrs: { role: 'alert' }, text: popError }) : null,
        h(
          'div',
          { class: 'gm-pop-foot' },
          h('span', {
            class: 'mm-subtle',
            text: text.inField(r.feature.geometry.type, fieldOf(props.field)),
          }),
          (first = button({
            label: text.open,
            icon: 'external',
            variant: 'primary',
            size: 'sm',
            title: text.openTitle,
            onClick: () => open(r.doc),
          })),
        ),
      )
    } else {
      const items = pick.items
      first = close
      card = h(
        'div',
        { class: 'gm-pop mm-card', attrs: { role: 'dialog', 'aria-label': text.here(items.length) } },
        h(
          'div',
          { class: 'gm-pop-head' },
          h('p', { class: 'gm-pop-title', text: text.here(items.length) }),
          close,
        ),
        h(
          'ul',
          { class: 'gm-pop-list' },
          ...items.slice(0, POP_LIST).map((i) => {
            const r = shown[i]!
            return h(
              'li',
              {},
              h('button', {
                class: 'gm-link',
                attrs: { type: 'button' },
                text: nameOf(r),
                title: text.locate,
                on: { click: () => choose({ kind: 'one', item: i, at: pick!.at }) },
              }),
              button({
                label: text.open,
                icon: 'external',
                variant: 'ghost',
                size: 'sm',
                title: text.openTitle,
                onClick: () => open(r.doc),
              }),
            )
          }),
        ),
        items.length > POP_LIST
          ? h('p', { class: 'mm-subtle', text: text.moreRows(items.length - POP_LIST) })
          : null,
        popError ? h('p', { class: 'gm-pop-error', attrs: { role: 'alert' }, text: popError }) : null,
      )
    }
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePop()
    })
    popSlot.replaceChildren(card)
    place()
    if (had || focusCard) first.focus({ preventScroll: true })
    focusCard = false
  }
  /** The card above its place (below near the top), inside the map, following it as the map moves. */
  function place(): void {
    const card = popSlot.firstElementChild as HTMLElement | null
    if (!card || !pick || !map) return
    const p = map.toScreen(pick.at)
    const width = mapEl.clientWidth || 800
    const height = mapEl.clientHeight || 480
    const w = card.offsetWidth || 280
    const hgt = card.offsetHeight || 160
    card.classList.toggle('gm-pop-away', p.x < 0 || p.y < 0 || p.x > width || p.y > height)
    const above = p.y - hgt - 18 >= 8
    card.style.left = `${Math.max(8, Math.min(width - w - 8, p.x - w / 2))}px`
    card.style.top = `${above ? p.y - hgt - 18 : Math.min(height - hgt - 8, p.y + 18)}px`
    card.classList.toggle('gm-pop-below', !above)
  }
  function choose(next: Pick | null): void {
    if (!next) return closePop()
    const active = document.activeElement
    if (!focusIn()) returnTo = active instanceof HTMLElement && root.contains(active) ? active : null
    focusCard = true
    pick = next
    popError = ''
    map?.select(next.kind === 'one' ? next.item : null)
    renderPop()
  }

  // ---- the shapes as a table: for the keyboard and for screen readers too
  function renderShapes(): void {
    if (state !== 'ready' || !shown.length) return void shapesSlot.replaceChildren()
    const wasOpen = (shapesSlot.querySelector('#shapes') as HTMLDetailsElement | null)?.open ?? false
    const t = table([
      { label: text.columns.document },
      { label: text.columns.field },
      { label: text.columns.type },
      { label: '', width: '1%' },
    ])
    shown.slice(0, SHAPE_ROWS).forEach((r, i) =>
      t.row(
        h('button', {
          class: 'gm-link',
          attrs: { type: 'button' },
          text: nameOf(r),
          title: text.locate,
          on: { click: () => map?.show(i) },
        }),
        h('span', { class: 'mm-key', text: fieldOf(r.feature.properties.field) }),
        badge(r.feature.geometry.type),
        h(
          'div',
          { class: 'mm-row-actions' },
          button({
            label: text.open,
            icon: 'external',
            variant: 'ghost',
            size: 'sm',
            title: text.openTitle,
            onClick: () => open(r.doc),
          }),
        ),
      ),
    )
    const details = h(
      'details',
      { id: 'shapes', class: 'mm-details gm-shapes' },
      h(
        'summary',
        {},
        icon('chevronRight', 14),
        h('span', { text: text.list }),
        badge(formatNumber(shown.length, wordsLanguage(locale))),
      ),
      h(
        'div',
        { class: 'mm-details-body' },
        h('div', { class: 'mm-table-wrap gm-table' }, t.el),
        shown.length > SHAPE_ROWS
          ? h('p', { class: 'mm-subtle gm-first', text: text.firstRows(SHAPE_ROWS, shown.length) })
          : null,
      ),
    )
    details.open = wasOpen
    shapesSlot.replaceChildren(details)
  }

  // ---- the field picker
  function applyField(): void {
    // Another field, or the documents read: what was being drawn was for the one before.
    map?.stopDrawing()
    shown = field ? rows.filter((r) => r.field === field) : rows
    findTarget()
    closePop()
    map?.setItems(shown.map((r) => r.feature))
    map?.fit()
    renderSummary()
    renderShapes()
    renderControls()
  }
  fieldSelect.addEventListener('change', () => {
    field = fieldSelect.value || null
    applyField()
  })
  fitButton.addEventListener('click', () => map?.fit())
  zoomIn.addEventListener('click', () => map?.zoomBy(1))
  zoomOut.addEventListener('click', () => map?.zoomBy(-1))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pick) closePop()
    // Escape ends a drawing wherever the focus is (the map's own keys stop it there first).
    if (e.key === 'Escape' && drawing) map?.stopDrawing()
  })

  function applyText(): void {
    const coll = ctx?.place?.coll ?? ''
    header.setText(text.title, ctx?.place ? (oneDocument ? text.one(coll) : text.description(coll)) : '')
    setLabel(fitButton, text.fit)
    setLabel(zoomIn, text.zoomIn)
    setLabel(zoomOut, text.zoomOut)
    setLabel(drawArea, text.drawArea)
    setLabel(drawCircle, text.drawCircle)
    setLabel(inView, text.inView)
    renderDrawButtons()
    renderDrawBar()
    renderNote()
    mapEl.setAttribute('aria-label', text.mapLabel)
    renderSummary()
    renderOverlay()
    renderShapes()
    renderPop()
    map?.refresh()
  }

  function startMap(c: PluginContext): void {
    const tiles = tileServer(c.settings)
    if (!tiles) {
      noTiles = h('div')
      floating.append(noTiles)
    }
    map = createMap(mapEl, {
      tiles,
      text: () => ({
        cluster: text.cluster,
        point: (i) => text.point(shown[i] ? nameOf(shown[i]) : ''),
        compass: text.compass,
        locale,
      }),
      onPick: choose,
      inset: () => (noTiles && !noTiles.hidden ? noTiles.offsetHeight + 12 : 0),
      onView: () => {
        renderControls()
        place()
      },
    })
  }

  client.onContext((next, theme, accent) => {
    locale = next
    text = textFor(locale)
    document.documentElement.lang = langTag(wordsLanguage(locale))
    applyLook(theme, accent)
    applyText()
  })
  client.onReady(async () => {
    try {
      ctx = await client.ask<PluginContext>('context.get')
    } catch (e) {
      state = 'failed'
      failure = askMessage(e, locale)
      return applyText()
    }
    locale = ctx.locale
    text = textFor(locale)
    document.documentElement.lang = langTag(wordsLanguage(locale))
    applyLook(ctx.theme, ctx.accent)
    if (!ctx.place) {
      state = 'noPlace'
      stage.replaceWith(emptyState({ icon: 'database', title: text.noPlace }))
      applyText()
      renderControls()
      return
    }
    startMap(ctx)
    state = 'loading'
    applyText()
    try {
      let documents: Doc[]
      if (oneDocument) {
        const one = await client.ask<Doc | null>('documents.get', { id: ctx.place.documentId })
        documents = one ? [one] : []
      } else ({ documents, more } = await readDocuments(client.ask.bind(client), ctx.place.filter ?? {}))
      readCount = documents.length
      rows = documents.flatMap((doc) =>
        featuresOf(doc).map((feature) => ({ feature, doc, field: fieldOf(feature.properties.field) })),
      )
      state = rows.length ? 'ready' : 'none'
    } catch (e) {
      state = 'failed'
      failure = askMessage(e, locale)
    }
    applyField()
    applyText()
  })
  applyText()
  renderControls()
}
