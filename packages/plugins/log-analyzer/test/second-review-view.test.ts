// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { AskError } from '../../kit/src/client'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { CSV_MAX_CHARS } from '../src/analyze'
import { mount, TEXT } from '../src/view'

/** Plugins wave 3, the second review of the branch: the log analyzer's page. */
const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 10, min)).toISOString()
const slow = (i: number, key = `status${i}`) =>
  JSON.stringify({
    t: { $date: at(1) },
    s: 'I',
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns: 'shop.orders',
      command: { find: 'orders', filter: { [key]: 1 } },
      planSummary: 'COLLSCAN',
      durationMillis: 100 + i,
    },
  })
const LOG = [slow(1), slow(2), slow(3)].join('\n')

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

async function opened(content: string, download: (p: Record<string, unknown>) => unknown = () => true) {
  const fake = fakeClient(
    { place: null, kind: 'sidebarPanel', id: 'logs' },
    { 'ui.copy': () => true, 'ui.download': download },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  const input = app().querySelector<HTMLInputElement>('#file')!
  input.focus()
  Object.defineProperty(input, 'files', { value: [new File([content], 'mongod.log')], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flush(12)
  return fake
}

describe('saving the slow operations', () => {
  it('saves what fits the app, cut at a whole row, and says how many rows were left out', async () => {
    const log = Array.from({ length: 5000 }, (_, i) => slow(i, `k${i}${'q'.repeat(220)}`)).join('\n')
    const { calls } = await opened(log)
    app().querySelector<HTMLButtonElement>('#csv')!.click()
    await flush()
    const params = calls.find((c) => c.method === 'ui.download')!.params as { text: string }
    expect(params.text.length).toBeLessThanOrEqual(CSV_MAX_CHARS)
    expect(params.text.endsWith('\n')).toBe(true)
    expect(app().querySelector('#csv-note')!.textContent).toMatch(/rows? (was|were) left out/)
    // 5000 lines read and drawn: about 3 seconds alone, more while every plugin's tests run at once.
  }, 30_000)

  it('shows why the app refused it, and nothing when the user said no', async () => {
    let answer: unknown = new AskError('too_many', 'At most 10 a minute')
    await opened(LOG, () => {
      throw answer
    })
    app().querySelector<HTMLButtonElement>('#csv')!.click()
    await flush()
    expect(app().querySelector('#csv-note')!.textContent).toContain('Too many requests in a minute')
    answer = new AskError('declined', 'The user said no')
    app().querySelector<HTMLButtonElement>('#csv')!.click()
    await flush()
    expect(app().querySelector('#csv-note')).toBeNull()
  })
})

describe('the page’s focus and status', () => {
  it('moves the focus to the summary when the file is read, and keeps what it says in the status line', async () => {
    await opened(LOG)
    const heading = app().querySelector<HTMLElement>('#summary-title')!
    expect(document.activeElement).toBe(heading)
    expect(app().querySelector('#status')!.textContent).toBe('Read mongod.log: 3 lines.')
  })

  it('keeps the focus on the sort chosen and on the example asked for', async () => {
    await opened(LOG)
    const count = app().querySelector<HTMLButtonElement>('#sort [data-value="count"]')!
    count.focus()
    count.click()
    await flush()
    expect(document.activeElement).toBe(app().querySelector('#sort [data-value="count"]'))
    const example = app().querySelectorAll<HTMLButtonElement>('[data-focus-key^="example:"]')[1]!
    const key = example.dataset.focusKey
    example.focus()
    example.click()
    await flush()
    const now = document.activeElement as HTMLElement
    expect(now.dataset.focusKey).toBe(key)
    expect(now.textContent).toContain('Hide example')
  })
})

describe('the log analyzer’s words, second review', () => {
  it('says a time is left out when it is more than a day after now, and names the long bars', () => {
    expect(TEXT.en.outOfRange(2, '2')).toContain('more than a day after now')
    expect(TEXT.tr.outOfRange(2, '2')).toContain('bir günden')
    expect(TEXT.en.units[604_800_000]).toBe('week')
    expect(TEXT.en.units[2_419_200_000]).toBeTruthy()
    expect(TEXT.tr.units[604_800_000]).toBe('hafta')
    expect(TEXT.tr.units[2_419_200_000]).toBeTruthy()
  })
})
