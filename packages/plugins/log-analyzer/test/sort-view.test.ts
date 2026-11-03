// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { mount } from '../src/view'

/** 2026-10-26 (user report): Total time, Count, Slowest and p95 did not change the slow operations' order. */
const line = (o: Record<string, unknown>) =>
  JSON.stringify({ t: { $date: '2026-10-26T10:00:00Z' }, s: 'I', c: 'X', id: 1, msg: 'a', ...o })
const slow = (field: string, ms: number) =>
  line({
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns: 'shop.orders',
      command: { find: 'orders', filter: { [field]: 1 } },
      planSummary: 'IXSCAN { x: 1 }',
      durationMillis: ms,
    },
  })
// often: 4 × 120 ms (total 480, the most); rare: 1 × 400 ms (the slowest, p95 400); mid: 2 × 210 ms.
const LOG = [
  slow('often', 120),
  slow('often', 120),
  slow('often', 120),
  slow('often', 120),
  slow('rare', 400),
  slow('mid', 210),
  slow('mid', 210),
].join('\n')

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

async function opened(content: string, locale = 'en') {
  const fake = fakeClient({ place: null, kind: 'sidebarPanel', id: 'logs', locale }, {})
  mount(app(), fake.client)
  fake.greet()
  await flush()
  const input = app().querySelector<HTMLInputElement>('#file')!
  Object.defineProperty(input, 'files', { value: [new File([content], 'mongod.log')], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flush(12)
}
/** The slow operations' rows, by the field their shape filters on. */
const order = () =>
  [...app().querySelectorAll<HTMLElement>('tr[data-shape]')].map((tr) =>
    ['often', 'rare', 'mid'].find((f) => tr.dataset.shape!.includes(f))!,
  )
/** The headers marked as the one the rows are sorted by. */
const sortedHeads = () =>
  [...app().querySelectorAll<HTMLElement>('thead th[aria-sort]')].map((th) => th.textContent!.trim())
const sortBy = async (value: string) => {
  app().querySelector<HTMLButtonElement>(`#sort [data-value="${value}"]`)!.click()
  await flush()
}

describe('the slow operations’ sort', () => {
  it('orders the rows by the measure chosen', async () => {
    await opened(LOG)
    expect(order()).toEqual(['often', 'mid', 'rare'])
    await sortBy('count')
    expect(order()).toEqual(['often', 'mid', 'rare'])
    await sortBy('max')
    expect(order()).toEqual(['rare', 'mid', 'often'])
    await sortBy('p95')
    expect(order()).toEqual(['rare', 'mid', 'often'])
    await sortBy('total')
    expect(order()).toEqual(['often', 'mid', 'rare'])
  })

  it('marks the column sorted by, highest first, and its cells', async () => {
    await opened(LOG)
    expect(sortedHeads()).toEqual(['Total'])
    await sortBy('p95')
    expect(sortedHeads()).toEqual(['p95'])
    expect(app().querySelector('thead th[aria-sort]')!.getAttribute('aria-sort')).toBe('descending')
    const cells = [...app().querySelectorAll('tr[data-shape] td.la-sorted')].map((td) => td.textContent)
    expect(cells).toEqual(['400 ms', '210 ms', '120 ms'])
  })

  it('sorts by a measure’s column header too: the sort control follows, the focus stays', async () => {
    await opened(LOG)
    const head = app().querySelector<HTMLButtonElement>('thead button[data-sort="max"]')!
    // Named by its label (it names the column's cells too); how it sorts is its tooltip and aria-sort.
    expect(head.getAttribute('aria-label')).toBeNull()
    expect(head.textContent!.trim()).toBe('Max')
    expect(head.title).toBe('Sort by: Max')
    head.focus()
    head.click()
    await flush()
    expect(order()).toEqual(['rare', 'mid', 'often'])
    expect(app().querySelector('#sort [data-value="max"]')!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(app().querySelector('thead button[data-sort="max"]'))
  })

  it('says so in Turkish', async () => {
    await opened(LOG, 'tr')
    expect(app().querySelector<HTMLButtonElement>('thead button[data-sort="count"]')!.title).toBe(
      'Sırala: Sayı',
    )
  })

  it('shows the measure chosen as chosen', async () => {
    await opened(LOG)
    await sortBy('max')
    expect(app().querySelector('#sort [data-value="max"]')!.getAttribute('aria-checked')).toBe('true')
    expect(app().querySelector('#sort [data-value="total"]')!.getAttribute('aria-checked')).toBe('false')
  })
})

describe('the slow operations’ table', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'style.css'), 'utf8')
  it('gives a shape room to read, never a letter a line', () => {
    expect(css).toMatch(/\.la-shape\s*\{[^}]*min-width:\s*16rem/)
  })
  it('keeps a measure and its unit on one line', () => {
    expect(css).toMatch(/\.la-slow td\.mm-num\s*\{[^}]*white-space:\s*nowrap/)
  })
})
