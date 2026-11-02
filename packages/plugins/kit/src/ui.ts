/**
 * Plugin tabs redesign (design §1):
 * the app's look inside a plugin frame, built with DOM APIs only. Text is always a text node —
 * never markup — and no attribute may carry script (an `on…` attribute or a `javascript:` URL).
 */
import { langTag, languageOf } from './i18n'
import { accentOf, type Accent } from './look'

export { ACCENTS, accentOf, type Accent } from './look'
export { LANGUAGES, langTag, languageOf, pick, pluralOf, shown, type Language } from './i18n'

/** The theme and accent on the page (`html.dark`, `html[data-accent]`), as the kit's CSS reads them. */
export function applyLook(theme: 'light' | 'dark', accent: Accent | string | undefined): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.accent = accentOf(accent)
}

export type Child = Node | string | number | null | undefined | false
export interface Props {
  class?: string
  id?: string
  text?: string
  title?: string
  hidden?: boolean
  attrs?: Record<string, string>
  data?: Record<string, string>
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>
}

const SCRIPTED = /^on/i
const SCRIPT_URL = /^(javascript|vbscript|data):/i
/**
 * An address as a browser reads its scheme (the WHATWG URL parser): tabs and line breaks dropped
 * wherever they are, controls and spaces before it dropped — "java<TAB>script:" is still a script
 * (security audit 2026-10-16, M6).
 */
function asRead(url: string): string {
  const joined = url.replace(/[\t\n\r]/g, '')
  let start = 0
  while (start < joined.length && joined.charCodeAt(start) <= 0x20) start++
  return joined.slice(start)
}

/** An element; strings among the children are text, never markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.id) el.id = props.id
  if (props.title) el.title = props.title
  if (props.hidden) el.hidden = true
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (SCRIPTED.test(name)) throw new Error(`No ${name} attribute: use "on"`)
    if (/^(href|src|action|formaction|xlink:href)$/i.test(name) && SCRIPT_URL.test(asRead(value)))
      throw new Error(`No script URL in ${name}`)
    el.setAttribute(name, value)
  }
  for (const [key, value] of Object.entries(props.data ?? {})) el.dataset[key] = value
  for (const [type, fn] of Object.entries(props.on ?? {})) if (fn) el.addEventListener(type, fn)
  if (props.text !== undefined) el.textContent = props.text
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'number' ? String(child) : child)
  }
  return el
}

// Icons: shapes of Lucide (ISC licence, https://lucide.dev), as [element, attributes] lists.
type Shape = [string, Record<string, string>]
const p = (d: string): Shape => ['path', { d }]
const ICONS = {
  search: [['circle', { cx: '11', cy: '11', r: '8' }], p('m21 21-4.3-4.3')],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
  copy: [
    ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
    p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'),
  ],
  check: [p('M20 6 9 17l-5-5')],
  chevronDown: [p('m6 9 6 6 6-6')],
  chevronRight: [p('m9 18 6-6-6-6')],
  external: [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')],
  arrowRight: [p('M5 12h14'), p('m12 5 7 7-7 7')],
  arrowDown: [p('M12 5v14'), p('m19 12-7 7-7-7')],
  info: [['circle', { cx: '12', cy: '12', r: '10' }], p('M12 16v-4'), p('M12 8h.01')],
  warning: [
    p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'),
    p('M12 9v4'),
    p('M12 17h.01'),
  ],
  ok: [['circle', { cx: '12', cy: '12', r: '10' }], p('m9 12 2 2 4-4')],
  error: [['circle', { cx: '12', cy: '12', r: '10' }], p('m15 9-6 6'), p('m9 9 6 6')],
  barChart: [p('M3 3v16a2 2 0 0 0 2 2h16'), p('M7 16h8'), p('M7 11h12'), p('M7 6h3')],
  columnChart: [p('M3 3v16a2 2 0 0 0 2 2h16'), p('M18 17V9'), p('M13 17V5'), p('M8 17v-3')],
  lineChart: [p('M3 3v16a2 2 0 0 0 2 2h16'), p('m19 9-5 5-4-4-3 3')],
  pieChart: [
    p('M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z'),
    p('M21.21 15.89A10 10 0 1 1 8 2.83'),
  ],
  scatter: [
    ['circle', { cx: '7.5', cy: '7.5', r: '1' }],
    ['circle', { cx: '18.5', cy: '5.5', r: '1' }],
    ['circle', { cx: '11.5', cy: '11.5', r: '1' }],
    ['circle', { cx: '7.5', cy: '16.5', r: '1' }],
    ['circle', { cx: '17.5', cy: '14.5', r: '1' }],
    p('M3 3v16a2 2 0 0 0 2 2h16'),
  ],
  mapPin: [
    p('M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0'),
    ['circle', { cx: '12', cy: '10', r: '3' }],
  ],
  link: [
    p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'),
    p('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
  ],
  activity: [
    p(
      'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
    ),
  ],
  layers: [
    p(
      'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
    ),
    p('m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65'),
    p('m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'),
  ],
  code: [
    ['polyline', { points: '16 18 22 12 16 6' }],
    ['polyline', { points: '8 6 2 12 8 18' }],
  ],
  table: [
    p('M12 3v18'),
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    p('M3 9h18'),
    p('M3 15h18'),
  ],
  database: [
    ['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }],
    p('M3 5V19A9 3 0 0 0 21 19V5'),
    p('M3 12A9 3 0 0 0 21 12'),
  ],
  filter: [['polygon', { points: '22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3' }]],
  loader: [p('M21 12a9 9 0 1 1-6.219-8.56')],
  compare: [
    ['circle', { cx: '18', cy: '18', r: '3' }],
    ['circle', { cx: '6', cy: '6', r: '3' }],
    p('M13 6h3a2 2 0 0 1 2 2v7'),
    p('M11 18H8a2 2 0 0 1-2-2V9'),
  ],
  plus: [p('M5 12h14'), p('M12 5v14')],
  minus: [p('M5 12h14')],
  alignLeft: [p('M21 5H3'), p('M15 12H3'), p('M17 19H3')],
  upload: [p('M12 3v12'), p('m17 8-5-5-5 5'), p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4')],
  download: [p('M12 15V3'), p('m7 10 5 5 5-5'), p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4')],
  fit: [
    p('M8 3H5a2 2 0 0 0-2 2v3'),
    p('M21 8V5a2 2 0 0 0-2-2h-3'),
    p('M3 16v3a2 2 0 0 0 2 2h3'),
    p('M16 21h3a2 2 0 0 0 2-2v-3'),
  ],
  book: [
    p('M12 7v14'),
    p(
      'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
    ),
  ],
  calendar: [
    p('M8 2v4'),
    p('M16 2v4'),
    ['rect', { width: '18', height: '18', x: '3', y: '4', rx: '2' }],
    p('M3 10h18'),
  ],
  // Plugins wave 3: images, test data, reshaping, logs, files and reading again (Lucide's shapes).
  image: [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }],
    ['circle', { cx: '9', cy: '9', r: '2' }],
    p('m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'),
  ],
  wand: [
    p(
      'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72',
    ),
    p('m14 7 3 3'),
    p('M5 6v4'),
    p('M19 14v4'),
    p('M10 2v2'),
    p('M7 8H3'),
    p('M21 16h-4'),
    p('M11 3H9'),
  ],
  shapes: [
    p('M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z'),
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
    ['circle', { cx: '17.5', cy: '17.5', r: '3.5' }],
  ],
  scroll: [
    p('M15 12h-5'),
    p('M15 8h-5'),
    p('M19 17V5a2 2 0 0 0-2-2H4'),
    p(
      'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3',
    ),
  ],
  file: [
    p('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'),
    p('M14 2v4a2 2 0 0 0 2 2h4'),
    p('M10 9H8'),
    p('M16 13H8'),
    p('M16 17H8'),
  ],
  refresh: [p('M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'), p('M21 3v5h-5')],
  trash: [p('M3 6h18'), p('M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'), p('M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2')],
  // Map 1.2 review: the circle tool's own (it shared the map pin).
  circle: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['circle', { cx: '12', cy: '12', r: '1' }],
  ],
  // Research 2026-10-28: the document size breakdown.
  ruler: [
    p(
      'M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z',
    ),
    p('m14.5 12.5 2-2'),
    p('m11.5 9.5 2-2'),
    p('m8.5 6.5 2-2'),
    p('m17.5 15.5 2-2'),
  ],
  // Research 2026-10-28: the personal data finder.
  fingerprint: [
    p('M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4'),
    p('M14 13.12c0 2.38 0 6.38-1 8.88'),
    p('M17.29 21.02c.12-.6.43-2.3.5-3.02'),
    p('M2 12a10 10 0 0 1 18-6'),
    p('M2 16h.01'),
    p('M21.8 16c.2-2 .131-5.354 0-6'),
    p('M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2'),
    p('M8.65 22c.21-.66.45-1.32.57-2'),
    p('M9 6.8a6 6 0 0 1 9 5.2v2'),
  ],
} satisfies Record<string, Shape[]>
export type IconName = keyof typeof ICONS

const SVG = 'http://www.w3.org/2000/svg'
/** An icon, drawn in the text colour; decorative (the control beside it carries the words). */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [k, v] of Object.entries({
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'mm-icon',
  }))
    svg.setAttribute(k, v)
  for (const [tag, attrs] of (ICONS as Record<string, Shape[]>)[name] ?? []) {
    const shape = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v)
    svg.append(shape)
  }
  return svg
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export interface ButtonOptions {
  label: string
  icon?: IconName
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /** Only the icon shows; the label is the button's name and its tooltip. */
  iconOnly?: boolean
  id?: string
  title?: string
  onClick?: (event: MouseEvent) => void
}
export function button(o: ButtonOptions): HTMLButtonElement {
  const b = h('button', {
    class: `mm-btn mm-btn-${o.variant ?? 'secondary'}${o.size === 'sm' ? ' mm-btn-sm' : ''}${o.iconOnly ? ' mm-btn-icon' : ''}`,
    ...(o.id ? { id: o.id } : {}),
    attrs: { type: 'button', ...(o.iconOnly ? { 'aria-label': o.label } : {}) },
    ...(o.title || o.iconOnly ? { title: o.title ?? o.label } : {}),
  })
  if (o.icon) b.append(icon(o.icon, o.size === 'sm' ? 14 : 16))
  if (!o.iconOnly) b.append(h('span', { text: o.label }))
  if (o.onClick) b.addEventListener('click', (e) => o.onClick!(e))
  return b
}
/** A button's words, its icon kept. */
export function setLabel(b: HTMLButtonElement, label: string): void {
  const span = b.querySelector('span')
  if (span) span.textContent = label
  else b.setAttribute('aria-label', label)
  if (b.classList.contains('mm-btn-icon')) b.title = label
}
/** A button that is busy: disabled, its icon turning. */
export function setBusy(b: HTMLButtonElement, busy: boolean): void {
  b.disabled = busy
  b.classList.toggle('mm-busy', busy)
  b.setAttribute('aria-busy', String(busy))
}

export interface Segmented<T extends string> {
  el: HTMLElement
  value(): T
  /** Chooses without telling `onChange`. */
  set(value: T): void
  /** New words for the choices (a language change). */
  relabel(labels: Partial<Record<T, string>>): void
}
/** One of a few choices, as a row of buttons (a radio group to assistive technology). */
export function segmented<T extends string>(o: {
  label: string
  options: Array<{ value: T; label: string; icon?: IconName; iconOnly?: boolean }>
  value: T
  onChange?: (value: T) => void
  id?: string
}): Segmented<T> {
  let current = o.value
  const el = h('div', {
    class: 'mm-seg',
    ...(o.id ? { id: o.id } : {}),
    attrs: { role: 'radiogroup', 'aria-label': o.label },
  })
  const buttons = o.options.map((opt) => {
    const b = h('button', {
      class: 'mm-seg-item',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false' },
      data: { value: opt.value },
      ...(opt.iconOnly ? { title: opt.label } : {}),
    })
    if (opt.icon) b.append(icon(opt.icon, 15))
    b.append(h('span', { class: opt.iconOnly ? 'mm-sr' : '', text: opt.label }))
    b.addEventListener('click', () => choose(opt.value, true))
    return b
  })
  const paint = () =>
    buttons.forEach((b, i) => {
      const on = o.options[i]!.value === current
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
    })
  const choose = (value: T, tell: boolean) => {
    if (value === current) return
    current = value
    paint()
    if (tell) o.onChange?.(value)
  }
  el.addEventListener('keydown', (e) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    e.preventDefault()
    const i = o.options.findIndex((opt) => opt.value === current)
    const next = (i + step + o.options.length) % o.options.length
    choose(o.options[next]!.value, true)
    buttons[next]!.focus()
  })
  el.append(...buttons)
  paint()
  return {
    el,
    value: () => current,
    set: (value) => choose(value, false),
    relabel: (labels) =>
      buttons.forEach((b, i) => {
        const label = labels[o.options[i]!.value]
        if (label === undefined) return
        b.querySelector('span')!.textContent = label
        if (b.title) b.title = label
      }),
  }
}

/** An on/off choice with its words beside it. */
export function switchControl(o: {
  label: string
  checked: boolean
  id?: string
  onChange?: (checked: boolean) => void
}): { el: HTMLLabelElement; input: HTMLInputElement; text: HTMLSpanElement } {
  const input = h('input', {
    ...(o.id ? { id: o.id } : {}),
    attrs: { type: 'checkbox', role: 'switch' },
  })
  input.checked = o.checked
  input.addEventListener('change', () => o.onChange?.(input.checked))
  const text = h('span', { text: o.label })
  const el = h(
    'label',
    { class: 'mm-switch' },
    input,
    h('span', { class: 'mm-switch-track', attrs: { 'aria-hidden': 'true' } }),
    text,
  )
  return { el, input, text }
}

/** A chip: a short value, optionally with a count and a click. */
export function chip(o: {
  label: string
  count?: number | string
  icon?: IconName
  pressed?: boolean
  mono?: boolean
  title?: string
  onClick?: () => void
}): HTMLElement {
  const content: Child[] = [
    o.icon ? icon(o.icon, 13) : null,
    h('span', { class: o.mono ? 'mm-mono' : '', text: o.label }),
    o.count !== undefined ? h('span', { class: 'mm-chip-count', text: String(o.count) }) : null,
  ]
  if (!o.onClick) return h('span', { class: 'mm-chip', ...(o.title ? { title: o.title } : {}) }, ...content)
  const b = h(
    'button',
    {
      class: 'mm-chip mm-chip-button',
      // A toggle only where it says whether it is on (review 2026-10-10): else a plain action.
      attrs: { type: 'button', ...(o.pressed !== undefined ? { 'aria-pressed': String(o.pressed) } : {}) },
      ...(o.title ? { title: o.title } : {}),
    },
    ...content,
  )
  b.addEventListener('click', o.onClick)
  return b
}

export type Tone = 'neutral' | 'accent' | 'info' | 'warning' | 'danger' | 'success'
export function badge(text: string, tone: Tone = 'neutral'): HTMLElement {
  return h('span', { class: `mm-badge mm-badge-${tone}`, text })
}

/** The page's title row: what the tab is, what it does, and its actions. */
export function pageHeader(o: {
  icon: IconName
  title: string
  description: string
  actions?: HTMLElement[]
}): HTMLElement & { setText(title: string, description: string): void } {
  const title = h('h1', { class: 'mm-head-title', text: o.title })
  const description = h('p', { class: 'mm-head-desc', text: o.description })
  const el = h(
    'header',
    { class: 'mm-head' },
    h('span', { class: 'mm-head-icon' }, icon(o.icon, 18)),
    h('div', { class: 'mm-head-text' }, title, description),
    h('div', { class: 'mm-head-actions' }, ...(o.actions ?? [])),
  ) as HTMLElement & { setText(title: string, description: string): void }
  el.setText = (t, d) => {
    title.textContent = t
    description.textContent = d
  }
  return el
}

/** What a place shows before anything is there: an icon, a title, a hint and an action. */
export function emptyState(o: {
  icon: IconName
  title: string
  hint?: string
  action?: HTMLElement
  tone?: Tone
}): HTMLElement {
  return h(
    'div',
    { class: `mm-empty mm-empty-${o.tone ?? 'neutral'}` },
    h('span', { class: 'mm-empty-icon' }, icon(o.icon, 22)),
    h('p', { class: 'mm-empty-title', text: o.title }),
    o.hint ? h('p', { class: 'mm-empty-hint', text: o.hint }) : null,
    o.action ?? null,
  )
}

/** Grey rows where results will be, while they are read. */
export function skeleton(rows = 5): HTMLElement {
  const el = h('div', { class: 'mm-skeleton', attrs: { 'aria-hidden': 'true' } })
  for (let i = 0; i < rows; i++) el.append(h('div', { class: 'mm-skeleton-row' }))
  return el
}

const CALLOUT_ICON: Record<'info' | 'warning' | 'danger' | 'success', IconName> = {
  info: 'info',
  warning: 'warning',
  danger: 'error',
  success: 'ok',
}
/** A note with a tone: an icon, a title and a text. */
export function callout(
  tone: 'info' | 'warning' | 'danger' | 'success',
  title: string,
  text?: string,
  ...extra: HTMLElement[]
): HTMLElement {
  return h(
    'div',
    { class: `mm-callout mm-callout-${tone}`, attrs: { role: 'note' } },
    h('span', { class: 'mm-callout-icon' }, icon(CALLOUT_ICON[tone], 16)),
    h(
      'div',
      { class: 'mm-callout-body' },
      h('p', { class: 'mm-callout-title', text: title }),
      text ? h('p', { class: 'mm-callout-text', text }) : null,
      ...extra,
    ),
  )
}

/** A number in the user's language. */
export function formatNumber(n: number, locale: string, digits = 2): string {
  const language = languageOf(locale)
  return new Intl.NumberFormat(
    language === 'en' ? 'en-US' : language === 'tr' ? 'tr-TR' : langTag(language),
    {
      maximumFractionDigits: digits,
    },
  ).format(n)
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
/** A date as the app's grid shows one: UTC, to the second. */
function dateText(v: unknown): string | null {
  let ms: number | null = null
  if (typeof v === 'string') ms = Date.parse(v)
  else if (isPlain(v) && typeof v.$numberLong === 'string') ms = Number(v.$numberLong)
  if (ms === null || !Number.isFinite(ms)) return null
  // Review 2026-10-10: a "max date" sentinel is beyond what a JavaScript date holds — its number.
  if (Math.abs(ms) > MAX_DATE_MS) return isPlain(v) ? (v.$numberLong as string) : null
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}
/** The furthest a JavaScript date reaches from 1970, in milliseconds. */
const MAX_DATE_MS = 8.64e15

/** "n field(s)" in the page's language (its <html lang>, which every plugin keeps). */
function fieldsText(n: number): string {
  const lang = document.documentElement.lang.toLowerCase()
  const one = n === 1
  if (lang.startsWith('tr')) return `${n} alan`
  if (lang.startsWith('zh')) return `${n} 个字段`
  if (lang.startsWith('ja')) return `${n} 個のフィールド`
  if (lang.startsWith('ko')) return `필드 ${n}개`
  if (lang.startsWith('es') || lang.startsWith('pt')) return `${n} ${one ? 'campo' : 'campos'}`
  if (lang.startsWith('de')) return `${n} ${one ? 'Feld' : 'Felder'}`
  if (lang.startsWith('fr')) return `${n} ${n <= 1 ? 'champ' : 'champs'}`
  if (lang.startsWith('ru')) {
    const d = n % 10
    const h = n % 100
    return `${n} ${d === 1 && h !== 11 ? 'поле' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'поля' : 'полей'}`
  }
  return `${n} ${one ? 'field' : 'fields'}`
}

export type ValueKind =
  'string' | 'number' | 'boolean' | 'null' | 'oid' | 'date' | 'object' | 'array' | 'other'
/** A value of canonical Extended JSON: its kind, and its text as a cell shows it. */
export function describeValue(v: unknown): { kind: ValueKind; text: string } {
  if (v === null || v === undefined) return { kind: 'null', text: 'null' }
  if (typeof v === 'string') return { kind: 'string', text: v }
  if (typeof v === 'number') return { kind: 'number', text: String(v) }
  if (typeof v === 'boolean') return { kind: 'boolean', text: String(v) }
  if (Array.isArray(v)) return { kind: 'array', text: `[ ${v.length} ]` }
  if (isPlain(v)) {
    for (const k of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'])
      if (typeof v[k] === 'string') return { kind: 'number', text: v[k] as string }
    if (typeof v.$oid === 'string') return { kind: 'oid', text: v.$oid }
    if ('$date' in v) {
      const text = dateText(v.$date)
      if (text) return { kind: 'date', text }
    }
    const keys = Object.keys(v)
    if (keys.length && keys.every((k) => k.startsWith('$'))) return { kind: 'other', text: JSON.stringify(v) }
    return { kind: 'object', text: `{ ${fieldsText(keys.length)} }` }
  }
  return { kind: 'other', text: String(v) }
}
/** A value in its type's colour, cut at `max` characters. */
export function valueView(v: unknown, max = 80): HTMLElement {
  const { kind, text } = describeValue(v)
  const cut = text.length > max ? `${text.slice(0, max - 1)}…` : text
  return h(
    'span',
    {
      class: `mm-value mm-v-${kind}`,
      data: { kind },
      ...(cut !== text ? { title: text.slice(0, 2000) } : {}),
    },
    cut,
  )
}

/** A table: a header row and a body to fill; numbers right-aligned where `numeric`. */
export function table(
  columns: Array<{
    label: string
    numeric?: boolean
    width?: string
    /** Where the column comes from (a joined collection's field): an info mark, its tooltip. */
    note?: string
  }>,
): {
  el: HTMLTableElement
  body: HTMLTableSectionElement
  row(...cells: Array<Child | { node: Child; numeric?: boolean; class?: string }>): HTMLTableRowElement
} {
  const body = h('tbody')
  const el = h(
    'table',
    { class: 'mm-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...columns.map((c) =>
          h(
            'th',
            {
              class: c.numeric ? 'mm-num' : '',
              attrs: { scope: 'col', ...(c.width ? { 'data-width': c.width } : {}) },
            },
            c.label,
            c.note
              ? h(
                  'span',
                  {
                    class: 'mm-note',
                    attrs: { role: 'img', 'aria-label': c.note, tabindex: '0' },
                    data: { note: c.note },
                  },
                  icon('info', 13),
                )
              : null,
          ),
        ),
      ),
    ),
    body,
  )
  return {
    el,
    body,
    row(...cells) {
      const tr = h('tr')
      cells.forEach((cell, i) => {
        const spec = cell && typeof cell === 'object' && 'node' in cell ? cell : { node: cell as Child }
        const numeric = spec.numeric ?? columns[i]?.numeric
        tr.append(h('td', { class: [numeric ? 'mm-num' : '', spec.class ?? ''].join(' ').trim() }, spec.node))
      })
      body.append(tr)
      return tr
    },
  }
}

/** Plugins wave 3: the image types a data: address may carry — never a page or a script. */
export const DATA_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
]
/**
 * An image drawn from its own bytes (a data: address, which `h()` refuses as a source): only an
 * image type of the list, only base64. An SVG in an <img> runs no script.
 */
export function dataImage(mime: string, base64: string, alt: string): HTMLImageElement {
  if (!DATA_IMAGE_TYPES.includes(mime)) throw new Error(`No data: image of type ${mime}`)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Not base64')
  const img = h('img', { attrs: { alt, loading: 'lazy', decoding: 'async' } })
  img.src = `data:${mime};base64,${base64}`
  return img
}

/** A short line that says how the page is doing, read out when it changes. */
export function statusLine(id = 'status'): HTMLElement {
  return h('p', { id, class: 'mm-status', attrs: { role: 'status', 'aria-live': 'polite' } })
}

/**
 * Review 2026-10-10: the app runs one pipeline of a frame at a time and refuses the next ("busy").
 * Requests made through this wait for the one before, answered or failed.
 */
export function serialAsk<A extends unknown[], T>(
  ask: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return (...args) => {
    const run = chain.then(() => ask(...args))
    chain = run.catch(() => undefined)
    return run
  }
}
