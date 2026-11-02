// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accentOf,
  applyLook,
  button,
  callout,
  chip,
  serialAsk,
  emptyState,
  formatNumber,
  h,
  icon,
  pageHeader,
  table,
  segmented,
  switchControl,
  valueView,
  dataImage,
} from '../src/ui'

beforeEach(() => {
  document.documentElement.className = ''
  delete document.documentElement.dataset.accent
  document.body.replaceChildren()
})

describe('the plugin look (plugin tabs redesign)', () => {
  it('takes only the app’s accents, Emerald otherwise', () => {
    expect(accentOf('ocean')).toBe('ocean')
    expect(accentOf('rose')).toBe('rose')
    expect(accentOf('red; background:url(x)')).toBe('emerald')
    expect(accentOf(undefined)).toBe('emerald')
    expect(accentOf({})).toBe('emerald')
  })

  it('puts the theme and the accent on the page', () => {
    applyLook('dark', 'violet')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.accent).toBe('violet')
    applyLook('light', 'nope' as never)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.dataset.accent).toBe('emerald')
  })
})

describe('building the page without HTML (plugin tabs redesign)', () => {
  it('never reads a text as markup', () => {
    const el = h('div', { class: 'x' }, '<img src=x onerror=alert(1)>', h('b', { text: '<i>bold</i>' }))
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('i')).toBeNull()
    expect(el.textContent).toBe('<img src=x onerror=alert(1)><i>bold</i>')
    expect(el.className).toBe('x')
  })

  it('sets attributes, data, hidden and listeners; skips empty children', () => {
    const click = vi.fn()
    const el = h(
      'button',
      { attrs: { type: 'button', 'aria-label': 'Go' }, data: { row: '3' }, on: { click } },
      null,
      false,
      undefined,
      'Go',
    )
    el.click()
    expect(click).toHaveBeenCalledOnce()
    expect(el.getAttribute('aria-label')).toBe('Go')
    expect(el.dataset.row).toBe('3')
    expect(el.childNodes).toHaveLength(1)
    expect(h('p', { hidden: true }).hidden).toBe(true)
  })

  it('refuses an event handler attribute', () => {
    expect(() => h('div', { attrs: { onclick: 'alert(1)' } })).toThrow()
    expect(() => h('a', { attrs: { href: 'javascript:alert(1)' } })).toThrow()
  })

  // Security audit 2026-10-16 (M6): a browser drops tabs and line breaks anywhere in an address, and
  // controls and spaces before it — "java<TAB>script:" is still a script.
  it('refuses a script address hidden by tabs, line breaks or controls, as a browser reads it', () => {
    for (const href of [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      'jav\ta\nsc\rript:alert(1)',
      '\u0000javascript:alert(1)',
      '\u001f \u0001javascript:alert(1)',
      ' \tJaVaScRiPt:alert(1)',
      'vb\tscript:x',
      'da\nta:text/html,x',
      'javascript\t:alert(1)',
    ])
      expect(() => h('a', { attrs: { href } }), JSON.stringify(href)).toThrow()
    expect(h('a', { attrs: { href: 'https://example.org/java\tscript:x' } }).getAttribute('href')).toBe(
      'https://example.org/java\tscript:x',
    )
    expect(h('a', { attrs: { href: '#javascript' } }).getAttribute('href')).toBe('#javascript')
  })

  it('draws an icon as SVG elements, an unknown one as nothing', () => {
    const svg = icon('search')
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelectorAll('path, circle').length).toBeGreaterThan(0)
    expect(icon('nope' as never).childNodes).toHaveLength(0)
  })

  it('makes buttons of a kind, with an icon and a label', () => {
    const onClick = vi.fn()
    const b = button({ label: 'Run', icon: 'play', variant: 'primary', onClick })
    expect(b.type).toBe('button')
    expect(b.classList.contains('mm-btn-primary')).toBe(true)
    expect(b.textContent).toBe('Run')
    expect(b.querySelector('svg')).not.toBeNull()
    b.click()
    expect(onClick).toHaveBeenCalledOnce()
    const only = button({ label: 'Clear', icon: 'x', iconOnly: true })
    expect(only.getAttribute('aria-label')).toBe('Clear')
    expect(only.title).toBe('Clear')
  })

  it('switches between choices, saying which is on', () => {
    const changed = vi.fn()
    const s = segmented({
      label: 'Mode',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      value: 'a',
      onChange: changed,
    })
    document.body.append(s.el)
    expect(s.el.getAttribute('role')).toBe('radiogroup')
    const [a, b] = [...s.el.querySelectorAll('button')]
    expect(a!.getAttribute('aria-checked')).toBe('true')
    b!.click()
    expect(changed).toHaveBeenCalledWith('b')
    expect(s.value()).toBe('b')
    expect(b!.getAttribute('aria-checked')).toBe('true')
    expect(a!.getAttribute('aria-checked')).toBe('false')
    s.set('a')
    expect(s.value()).toBe('a')
    expect(changed).toHaveBeenCalledTimes(1)
    // Arrow keys move the choice, as in a radio group, round from the last to the first.
    a!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(s.value()).toBe('b')
    expect(changed).toHaveBeenLastCalledWith('b')
    b!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(s.value()).toBe('a')
  })

  it('makes a labelled switch', () => {
    const changed = vi.fn()
    const sw = switchControl({ label: 'Ignore case', checked: true, onChange: changed })
    expect(sw.input.getAttribute('role')).toBe('switch')
    expect(sw.input.checked).toBe(true)
    expect(sw.el.textContent).toContain('Ignore case')
    // As a browser does on a click: the box turns, then "change".
    sw.input.checked = false
    sw.input.dispatchEvent(new Event('change'))
    expect(changed).toHaveBeenCalledWith(false)
  })

  it('shows an empty state, a header and a callout as text', () => {
    const empty = emptyState({ icon: 'search', title: 'Nothing <b>yet</b>', hint: 'Type a value' })
    expect(empty.querySelector('b')).toBeNull()
    expect(empty.textContent).toContain('Nothing <b>yet</b>')
    const head = pageHeader({ icon: 'search', title: 'Search', description: 'Find a value', actions: [] })
    expect(head.querySelector('h1')!.textContent).toBe('Search')
    const c = callout('warning', 'Careful', 'It runs')
    expect(c.getAttribute('role')).toBe('note')
    expect(c.classList.contains('mm-callout-warning')).toBe(true)
  })
})

describe('values in their type’s colour (plugin tabs redesign)', () => {
  it.each([
    ['Ankara', 'string', 'Ankara'],
    [{ $numberInt: '5' }, 'number', '5'],
    [{ $numberDouble: '3.5' }, 'number', '3.5'],
    [{ $numberLong: '9007199254740993' }, 'number', '9007199254740993'],
    [true, 'boolean', 'true'],
    [null, 'null', 'null'],
    [{ $oid: '65a1b2c3d4e5f60718293a4b' }, 'oid', '65a1b2c3d4e5f60718293a4b'],
    [{ $date: { $numberLong: '1767225600000' } }, 'date', '2026-01-01 00:00:00'],
    [{ $date: '2026-01-05T10:00:00Z' }, 'date', '2026-01-05 10:00:00'],
    [{ a: 1, b: 2 }, 'object', '{ 2 fields }'],
    [[1, 2, 3], 'array', '[ 3 ]'],
  ])('%j', (value, kind, text) => {
    const el = valueView(value)
    expect(el.dataset.kind).toBe(kind)
    expect(el.textContent).toBe(text)
  })

  it('cuts a long text', () => {
    expect(valueView('x'.repeat(200), 10).textContent).toBe('xxxxxxxxx…')
  })

  it('writes numbers in the user’s language', () => {
    expect(formatNumber(12345.5, 'en')).toBe('12,345.5')
    expect(formatNumber(12345.5, 'tr')).toBe('12.345,5')
  })
})

describe('the review of 2026-10-10 (kit)', () => {
  it('shows a date beyond what a date can say as its number, never throwing', () => {
    const max = { $date: { $numberLong: '9223372036854775807' } }
    expect(valueView(max).textContent).toBe('9223372036854775807')
    expect(valueView(max).dataset.kind).toBe('date')
    expect(valueView({ $date: { $numberLong: '-8640000000000001' } }).textContent).toBe('-8640000000000001')
  })

  it('says how many fields an object has in the page’s language', () => {
    document.documentElement.lang = 'tr'
    expect(valueView({ a: 1, b: 2 }).textContent).toBe('{ 2 alan }')
    document.documentElement.lang = 'en'
    expect(valueView({ a: 1 }).textContent).toBe('{ 1 field }')
  })

  it('makes a chip a toggle only when it says whether it is on', () => {
    const action = chip({ label: 'city', onClick: () => {} })
    expect(action.hasAttribute('aria-pressed')).toBe(false)
    const toggle = chip({ label: 'city', pressed: false, onClick: () => {} })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('asks one at a time: a request waits for the one before, failed or not', async () => {
    const order: string[] = []
    let open = 0
    const release: Array<() => void> = []
    const ask = serialAsk(async (method: string) => {
      open++
      if (open > 1) throw new Error('busy')
      order.push(`start ${method}`)
      await new Promise<void>((r) => release.push(r))
      order.push(`end ${method}`)
      open--
      if (method === 'b') throw new Error('failed')
      return method
    })
    const a = ask('a')
    const b = ask('b')
    const c = ask('c')
    await Promise.resolve()
    release.shift()!()
    await expect(a).resolves.toBe('a')
    await new Promise((r) => setTimeout(r, 0))
    release.shift()!()
    await expect(b).rejects.toThrow('failed')
    await new Promise((r) => setTimeout(r, 0))
    release.shift()!()
    await expect(c).resolves.toBe('c')
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })
})

describe('a table column that says where it comes from (user request 2026-10-10)', () => {
  it('shows an info mark with the note as its tooltip and its name', () => {
    const grid = table([{ label: 'c.email', note: 'customers.email' }, { label: 'orderNo' }])
    const [withNote, plain] = [...grid.el.querySelectorAll('th')]
    expect(withNote!.textContent).toContain('c.email')
    const mark = withNote!.querySelector('[data-note]')!
    // The kit's own tooltip (CSS, from data-note) on hover and on focus — not the browser's title.
    expect(mark.getAttribute('data-note')).toBe('customers.email')
    expect(mark.hasAttribute('title')).toBe(false)
    expect(mark.getAttribute('tabindex')).toBe('0')
    expect(mark.getAttribute('aria-label')).toBe('customers.email')
    expect(mark.getAttribute('role')).toBe('img')
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(plain!.querySelector('[data-note]')).toBeNull()
  })

  it('keeps a note as text', () => {
    const grid = table([{ label: 'x', note: '<img src=x onerror=alert(1)>' }])
    expect(grid.el.querySelector('img')).toBeNull()
  })
})

// Plugins wave 3: an image drawn from its own bytes — an image type only, base64 only.
describe('an image from its own bytes', () => {
  it('takes an image type and base64, and nothing else', () => {
    const img = dataImage('image/png', 'iVBORw0KGgo=', 'A photo')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(img.alt).toBe('A photo')
    expect(() => dataImage('text/html', 'PHNjcmlwdD4=', 'x')).toThrow(/text\/html/)
    expect(() => dataImage('image/svg+xml;charset=utf-8', 'PHN2Zz4=', 'x')).toThrow()
    expect(() => dataImage('image/png', 'a,b<script>', 'x')).toThrow(/base64/)
    // Wave 3 review: an AVIF picture is drawn too.
    expect(dataImage('image/avif', 'AAAA', 'x').getAttribute('src')).toBe('data:image/avif;base64,AAAA')
  })
})
