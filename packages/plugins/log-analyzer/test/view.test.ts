// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { mount, TEXT } from '../src/view'

/** Plugins wave 3 (spec §7): the log analyzer page — a file dropped, read here, its findings shown. */
const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 10, min)).toISOString()
const line = (o: Record<string, unknown>) =>
  JSON.stringify({ t: { $date: at(Number(o.min ?? 0)) }, s: 'I', c: 'COMMAND', ...o })
const LOG = [
  line({ id: 23403, msg: 'Build Info', c: 'CONTROL', attr: { buildInfo: { version: '8.0.4' } } }),
  line({
    min: 1,
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns: 'shop.orders',
      command: { find: 'orders', filter: { email: 'ada@example.com' } },
      planSummary: 'COLLSCAN',
      docsExamined: 900,
      nreturned: 1,
      durationMillis: 700,
    },
  }),
  line({ min: 2, s: 'W', c: 'STORAGE', id: 20001, msg: 'Low disk' }),
  line({
    min: 2,
    c: 'NETWORK',
    id: 22943,
    msg: 'Connection accepted',
    attr: { remote: '10.0.0.1:5', connectionCount: 3 },
  }),
  'not a log line',
].join('\n')

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!

async function dropped(content: string, name = 'mongod.log') {
  const fake = fakeClient(
    { place: null, kind: 'sidebarPanel', id: 'logs' },
    { 'ui.copy': () => true, 'ui.download': () => true },
  )
  mount(app(), fake.client)
  fake.greet()
  await flush()
  const input = app().querySelector<HTMLInputElement>('#file')!
  Object.defineProperty(input, 'files', { value: [new File([content], name)], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flush(12)
  return fake
}

describe('the log analyzer page', () => {
  it('asks for a file, and reads nothing before one is given', async () => {
    const fake = fakeClient({ place: null, kind: 'sidebarPanel' }, {})
    mount(app(), fake.client)
    fake.greet()
    await flush()
    expect(app().querySelector('#drop')!.textContent).toContain('Drop a log file here')
    expect(fake.calls.map((c) => c.method)).toEqual(['context.get'])
  })

  it('shows the summary, the slow shapes without their values, warnings and connections', async () => {
    await dropped(LOG)
    const summary = app().querySelector('#summary')!.textContent!
    expect(summary).toContain('Lines5')
    expect(summary).toContain('Not read as log lines1')
    expect(summary).toContain('8.0.4')
    const row = app().querySelector<HTMLElement>('tr[data-shape]')!
    expect(row.dataset.shape).toBe('{"filter":{"email":"?"}}')
    expect(row.classList.contains('la-collscan')).toBe(true)
    expect(row.textContent).toContain('COLLSCAN · no index')
    // A value is shown only as the user asks for its example line.
    expect(app().textContent).not.toContain('ada@example.com')
    ;[...row.querySelectorAll('button')].find((b) => b.textContent === 'Example')!.click()
    expect(app().querySelector('.la-example')!.textContent).toContain('ada@example.com')
    expect(app().querySelector('#messages')!.textContent).toContain('Low disk')
    expect(app().querySelector('#clients')!.textContent).toContain('10.0.0.1')
    expect(app().textContent).toContain('1 opened, 0 ended, at most 3 at once.')
  })

  it('copies a shape, and saves the slow shapes as CSV, through the app', async () => {
    const fake = await dropped(LOG)
    app().querySelector<HTMLButtonElement>('tr[data-shape] button[aria-label="Copy shape"]')!.click()
    app().querySelector<HTMLButtonElement>('#csv')!.click()
    await flush()
    expect(fake.calls.find((c) => c.method === 'ui.copy')!.params).toEqual({
      text: '{"filter":{"email":"?"}}',
    })
    const csv = fake.calls.find((c) => c.method === 'ui.download')!.params
    expect(csv).toMatchObject({ name: 'slow-operations', type: 'csv' })
    expect(csv.text).not.toContain('ada@example.com')
  })

  it('says when no line reads as a MongoDB log', async () => {
    await dropped('hello\nworld\n', 'notes.txt')
    expect(app().textContent).toContain('No line of this file reads as a MongoDB log.')
    expect(app().querySelector('#drop')).not.toBeNull()
  })
})

/** A file whose pieces are read only when the test lets them (one `step` each). */
function gatedFile(content: string, name: string) {
  const file = new File([content], name)
  const waits: Array<() => void> = []
  const realSlice = file.slice.bind(file)
  file.slice = ((a?: number, b?: number) => {
    const part = realSlice(a, b)
    return { arrayBuffer: () => new Promise((r) => waits.push(() => r(part.arrayBuffer()))) }
  }) as typeof file.slice
  const step = async () => {
    for (let i = 0; i < 50 && !waits.length; i++) await flush(1)
    waits.shift()!()
    await flush(3)
  }
  return { file, step }
}
async function mounted() {
  const fake = fakeClient({ place: null, kind: 'sidebarPanel', id: 'logs' }, { 'ui.download': () => true })
  mount(app(), fake.client)
  fake.greet()
  await flush()
  return fake
}
const choose = (file: File) => {
  const input = app().querySelector<HTMLInputElement>('#file')!
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
}

describe('the log analyzer page, review fixes', () => {
  // Wave 3 review: the page was drawn again five times a second — Stop lost its focus, and a screen
  // reader heard every percent.
  it('keeps Stop and its focus while it reads, telling its progress in steps of ten', async () => {
    await mounted()
    // About 3.2 MB: read in four pieces of 1 MB.
    const { file, step } = gatedFile(LOG + '\n' + 'not a log line\n'.repeat(220_000), 'big.log')
    choose(file)
    const stop = app().querySelector<HTMLButtonElement>('#stop')!
    stop.focus()
    await step() // its first two bytes: gzip or not
    await step()
    const bar = () => app().querySelector('[role="progressbar"]')!
    const pct = Math.floor((1024 * 1024 * 100) / file.size)
    expect(bar().getAttribute('aria-valuenow')).toBe(String(pct))
    expect(app().querySelector('#stop')).toBe(stop)
    expect(document.activeElement).toBe(stop)
    expect(app().querySelector('#status')!.textContent).toBe(`Reading big.log: ${Math.floor(pct / 10) * 10}%`)
    await step()
    expect(document.activeElement).toBe(stop)
    stop.click()
    await step()
    await flush(4)
    expect(app().textContent).toContain('Stopped: what was read so far is shown.')
    // Another file: the note of the last one goes.
    app().querySelector<HTMLButtonElement>('#another')!.click()
    expect(app().textContent).not.toContain('Stopped')
    expect(app().querySelector('#drop')).not.toBeNull()
  })

  it('says a gzipped file that is cut short is broken, and shows what was read', async () => {
    await mounted()
    const gz = new Uint8Array(
      await new Response(
        new Blob([LOG + '\n' + LOG]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    )
    choose(new File([gz.slice(0, gz.length - 12)], 'mongod.log.gz'))
    await flush(20)
    expect(app().textContent).toContain(
      'This gzipped file could not be read to its end: it is cut short, or not gzip. What was read is shown.',
    )
    expect(app().textContent).not.toMatch(/unexpected|incorrect header|zlib/i)
  })

  it('never lets a file dropped beside the drop zone open in the page', async () => {
    await mounted()
    const drop = new Event('drop', { cancelable: true, bubbles: true })
    const over = new Event('dragover', { cancelable: true, bubbles: true })
    document.body.dispatchEvent(over)
    document.body.dispatchEvent(drop)
    expect(over.defaultPrevented).toBe(true)
    expect(drop.defaultPrevented).toBe(true)
  })

  it('names the actions column, describes the timeline in words, and shows the keys read', async () => {
    await dropped(LOG)
    const heads = [...app().querySelectorAll('tr[data-shape]')].map((r) => r.closest('table')!)[0]!
    const last = heads.querySelector('thead th:last-child')!
    expect(last.querySelector('.mm-sr')!.textContent).toBe('Actions')
    expect(heads.querySelector('thead')!.textContent).toContain('Keys / docs read / returned')
    expect(app().querySelector('tr[data-shape]')!.textContent).toContain('0 / 900 / 1')
    const svg = app().querySelector('.la-chart')!
    const described = document.getElementById(svg.getAttribute('aria-describedby')!)!
    expect(described.textContent).toBe(
      'From Oct 26, 2026, 10:00 AM UTC to Oct 26, 2026, 10:02 AM UTC: at most 2 lines a minute (Oct 26, 2026, 10:02 AM UTC); 1 slow operation in all.',
    )
  })

  it('says how many lines have a time outside the log’s range', async () => {
    await dropped(
      LOG + '\n' + JSON.stringify({ t: { $date: '1970-01-01T00:00:00Z' }, s: 'I', c: 'X', id: 1, msg: 'x' }),
    )
    expect(app().textContent).toContain(
      '1 line has a time before 2009 or more than a day after now: it is left out of the range and the timeline.',
    )
  })
})

describe('the log analyzer’s words', () => {
  it('counts one in the singular and formats numbers', () => {
    const en = TEXT.en
    expect(en.otherSlow(1, '1')).toBe(
      '1 more slow operation, of a shape not listed, was counted (5,000 shapes at most).',
    )
    expect(en.otherSlow(1200, '1,200')).toBe(
      '1,200 more slow operations, of shapes not listed, were counted (5,000 shapes at most).',
    )
    expect(en.otherMessages(1, '1')).toBe('1 more message was counted but not listed.')
    expect(en.otherMessages(3, '3')).toBe('3 more messages were counted but not listed.')
    expect(en.outOfRange(2, '2')).toBe(
      '2 lines have a time before 2009 or more than a day after now: they are left out of the range and the timeline.',
    )
    expect(en.connectionsLine(1000, '1,000', 1, '1', 9, '9')).toBe(
      '1,000 opened, 1 ended, at most 9 at once.',
    )
    expect(TEXT.tr.otherMessages(1200, '1.200')).toBe('1.200 ileti daha sayıldı ama listelenmedi.')
  })
})
