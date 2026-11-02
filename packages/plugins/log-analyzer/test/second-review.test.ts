import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { Analyzer, CSV_MAX_CHARS, CSV_MAX_MESSAGE_BYTES, slowCsvFile } from '../src/analyze'
import { parseLine } from '../src/parse'
import { readLines } from '../src/read'

/** Plugins wave 3, the second review of the branch: what the log analyzer still got wrong. */
const DAY = 86_400_000
const line = (t: string, o: Record<string, unknown> = {}) =>
  JSON.stringify({ t: { $date: t }, s: 'I', c: 'X', id: 1, msg: 'a', ...o })
const slowLine = (ns: string, filter: Record<string, unknown>, command: Record<string, unknown> = {}) =>
  JSON.stringify({
    t: { $date: '2026-10-26T10:00:00Z' },
    s: 'I',
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: { type: 'command', ns, command: { find: 'orders', filter, ...command }, durationMillis: 100 },
  })
const read = async (blob: Blob, chunk?: number, opts?: Parameters<typeof readLines>[5]) => {
  const seen: string[] = []
  await readLines(
    blob,
    (l) => void seen.push(l),
    () => undefined,
    new AbortController().signal,
    chunk,
    opts,
  )
  return seen
}

describe('the timeline of a long log', () => {
  it('covers every year of a log over four years, by the week or four', () => {
    const a = new Analyzer({ now: Date.parse('2026-12-31T00:00:00Z') })
    const years = [2012, 2014, 2017, 2020, 2023, 2026]
    for (const y of years) a.add(line(`${y}-06-01T00:00:00Z`))
    const { timeline } = a.result()
    expect(timeline.bucketMs).toBeGreaterThanOrEqual(7 * DAY)
    expect(timeline.buckets.length).toBeLessThanOrEqual(721)
    expect(timeline.buckets.reduce((n, b) => n + b.lines, 0)).toBe(years.length)
    // The last line is in the last bar.
    expect(timeline.buckets.at(-1)!.lines).toBe(1)
    // About five years: by the week, the finest bar that draws it whole.
    const five = new Analyzer({ now: Date.parse('2026-12-31T00:00:00Z') })
    for (const y of [2022, 2024, 2026]) five.add(line(`${y}-06-01T00:00:00Z`))
    expect(five.result().timeline.bucketMs).toBe(7 * DAY)
  })
})

describe('what the analysis keeps, bounded', () => {
  it('keys every group by bounded names: a huge name never grows a key', () => {
    const a = new Analyzer()
    const huge = 'n'.repeat(100_000)
    a.add(slowLine(`${huge}1`, { a: 1 }))
    a.add(slowLine(`${huge}2`, { a: 1 }))
    a.add(
      JSON.stringify({
        t: { $date: '2026-10-26T10:00:00Z' },
        s: 'S'.repeat(50_000),
        c: 'C'.repeat(50_000),
        id: 1,
        msg: 'x',
      }),
    )
    const r = a.result()
    // The two differ only past what is kept: one group.
    expect(r.slow).toHaveLength(1)
    expect(r.slow[0]!.count).toBe(2)
    expect(r.slow[0]!.ns.length).toBeLessThanOrEqual(256)
    expect(Object.keys(r.severities).every((s) => s.length <= 2)).toBe(true)
    expect(Object.keys(r.components).every((c) => c.length <= 64)).toBe(true)
    // A command named by a huge key: its name is cut.
    const op = parseLine(
      JSON.stringify({
        t: { $date: '2026-10-26T10:00:00Z' },
        s: 'I',
        c: 'COMMAND',
        id: 51803,
        msg: 'Slow query',
        attr: { type: 'command', ns: 'a.b', command: { ['f'.repeat(10_000)]: 'orders' }, durationMillis: 1 },
      }),
    )
    expect(op.kind === 'slow' && op.op.length).toBe(64)
  })

  it('counts the rest past each cap, and always the errors and warnings', () => {
    const a = new Analyzer({ severities: 2, components: 2, clients: 1 })
    for (const s of ['A1', 'B1', 'C1', 'E', 'W', 'F']) a.add(line('2026-10-26T10:00:00Z', { s }))
    for (const c of ['X1', 'X2', 'X3', 'X4']) a.add(line('2026-10-26T10:00:00Z', { c }))
    for (const remote of ['10.0.0.1:1', '10.0.0.2:1', '10.0.0.3:1'])
      a.add(line('2026-10-26T10:00:00Z', { id: 22943, msg: 'Connection accepted', attr: { remote } }))
    const r = a.result()
    expect(r.severities.E).toBe(1)
    expect(r.severities.W).toBe(1)
    expect(r.severities.F).toBe(1)
    expect(r.otherSeverities).toBe(1)
    expect(r.otherComponents).toBeGreaterThan(0)
    expect(r.connections.clients).toHaveLength(1)
    expect(r.connections.otherClients).toBe(2)
  })
})

describe('the slow operations as a CSV file', () => {
  it('fits the app’s limits, cut at a whole row, saying how many rows were left out', () => {
    const a = new Analyzer()
    // Shapes of quotes: each counts twice in the message's JSON.
    for (let i = 0; i < 5000; i++) a.add(slowLine('shop.orders', { [`k${i}${'q'.repeat(220)}`]: 1 }))
    const { text, left } = slowCsvFile(a.result(), 'slow-operations')
    expect(left).toBeGreaterThan(0)
    expect(text.length).toBeLessThanOrEqual(CSV_MAX_CHARS)
    const message = JSON.stringify({ name: 'slow-operations', type: 'csv', text })
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(CSV_MAX_MESSAGE_BYTES)
    // Whole rows only: the header and every row kept end with a line break.
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').length - 2).toBe(5000 - left)
    // Rows of plain text: the characters bind before the message's bytes.
    const plain = new Analyzer()
    for (let i = 0; i < 5000; i++)
      plain.add(
        JSON.stringify({
          t: { $date: '2026-10-26T10:00:00Z' },
          s: 'I',
          c: 'COMMAND',
          id: 51803,
          msg: 'Slow query',
          attr: {
            type: 'command',
            ns: `db.${'n'.repeat(240)}${i}`,
            command: { find: 'x', filter: { a: 1 } },
            planSummary: `IXSCAN ${'p'.repeat(190)}`,
            durationMillis: 1,
          },
        }),
      )
    const cut = slowCsvFile(plain.result(), 'slow-operations')
    expect(cut.left).toBeGreaterThan(0)
    expect(cut.text.length).toBeLessThanOrEqual(CSV_MAX_CHARS)
    // A small one is whole.
    const small = new Analyzer()
    small.add(slowLine('shop.orders', { a: 1 }))
    expect(slowCsvFile(small.result(), 'x').left).toBe(0)
  })
})

describe('the legacy text log’s shapes', () => {
  it('keeps no value in a list of true and false, nor in lists inside lists', () => {
    const legacy = (body: string) =>
      parseLine(
        `2017-03-01T10:00:00.000+0000 I COMMAND  [conn1] command shop.orders command: find { find: "orders", filter: ${body} } planSummary: COLLSCAN keysExamined:0 docsExamined:9 nreturned:1 9ms`,
      )
    const flags = legacy('{ a: { $in: [ true, false ] } }')
    expect(flags.kind === 'slow' && flags.shape).not.toMatch(/true|false/)
    const nested = legacy('{ b: { $in: [ [ 1, 2 ], [ [ 3 ], 4 ] ] } }')
    expect(nested.kind === 'slow' && nested.shape).not.toMatch(/\d/)
    expect(nested.kind === 'slow' && nested.shape).not.toContain('[')
  })
})

describe('reading the file', () => {
  it('caps a Windows line at its text, never its carriage return', async () => {
    let long = 0
    const opts = { maxLine: 5, onTooLong: () => void long++ }
    expect(await read(new Blob(['abcde\r\nx\r\n']), undefined, opts)).toEqual(['abcde', 'x'])
    // The piece ends between the carriage return and the line feed.
    expect(await read(new Blob(['abcde\r\nx']), 6, opts)).toEqual(['abcde', 'x'])
    expect(long).toBe(0)
    expect(await read(new Blob(['abcdef\r\nx']), 6, opts)).toEqual(['x'])
    expect(long).toBe(1)
  })

  it('reads every part of a gzipped file made of several joined', async () => {
    const parts = [
      gzipSync(Buffer.from('one\ntwo\n')),
      gzipSync(
        Buffer.from(Array.from({ length: 3000 }, (_, i) => `line ${i} ${Math.sin(i)}`).join('\n') + '\n'),
      ),
      gzipSync(Buffer.from('last\n')),
    ]
    const joined = new Blob(parts.map((p) => new Uint8Array(p)))
    const seen = await read(joined)
    expect(seen.slice(0, 2)).toEqual(['one', 'two'])
    expect(seen.at(-1)).toBe('last')
    expect(seen).toHaveLength(2 + 3000 + 1)
  })

  it('finds the next part by the length the last one held, never by bytes that only look like a start', async () => {
    // A part stored as it is (no compression) holds bytes that read as gzip's header: 1f 8b 08.
    const looksLikeStart = Buffer.from([
      ...Buffer.from('a'.repeat(20)),
      0x1f,
      0x8b,
      0x08,
      0x62,
      0x0a,
      0x6f,
      0x6b,
      0x0a,
    ])
    const parts = [gzipSync(looksLikeStart, { level: 0 }), gzipSync(Buffer.from('last\n'))]
    const seen = await read(new Blob(parts.map((p) => new Uint8Array(p))))
    expect(seen).toHaveLength(3)
    expect(seen.slice(1)).toEqual(['ok', 'last'])
  })

  it('says a joined gzipped file whose later part is cut short is broken, keeping what was read', async () => {
    const first = gzipSync(Buffer.from('one\ntwo\n'))
    const second = gzipSync(Buffer.from(Array.from({ length: 500 }, (_, i) => `x${i}`).join('\n')))
    const cut = new Blob([new Uint8Array(first), new Uint8Array(second.subarray(0, second.length - 20))])
    const seen: string[] = []
    await expect(
      readLines(
        cut,
        (l) => void seen.push(l),
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/bad_gzip/)
    expect(seen.slice(0, 2)).toEqual(['one', 'two'])
  })
})
