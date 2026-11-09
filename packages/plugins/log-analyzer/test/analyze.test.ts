// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Analyzer, slowCsv } from '../src/analyze'
import { readLines } from '../src/read'

/** Plugins wave 3 (spec §7): a log's lines counted into slow shapes, messages, connections and time. */
const at = (min: number, s = 0) => new Date(Date.UTC(2026, 9, 26, 10, min, s)).toISOString()
const slow = (
  min: number,
  ms: number,
  filter: Record<string, unknown>,
  plan = 'IXSCAN { a: 1 }',
  ns = 'shop.orders',
) =>
  JSON.stringify({
    t: { $date: at(min) },
    s: 'I',
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns,
      command: { find: 'orders', filter },
      planSummary: plan,
      keysExamined: 1,
      docsExamined: 10,
      nreturned: 1,
      durationMillis: ms,
    },
  })
const event = (min: number, s = 'I', id = 1, msg = 'x', c = 'CONTROL', attr: Record<string, unknown> = {}) =>
  JSON.stringify({ t: { $date: at(min) }, s, c, id, msg, attr })

describe('a log analysed', () => {
  it('groups slow operations by shape — count, total, mean, p95, max, plans — the slowest first', () => {
    const a = new Analyzer()
    for (let i = 1; i <= 20; i++) a.add(slow(i % 5, i * 10, { status: `s${i}` }))
    a.add(slow(3, 5000, { userId: 7 }, 'COLLSCAN'))
    a.add(slow(4, 4000, { userId: 9 }, 'COLLSCAN'))
    const r = a.result()
    expect(r.slow.map((g) => g.shape)).toEqual(['{"filter":{"userId":"?"}}', '{"filter":{"status":"?"}}'])
    expect(r.slow[0]).toMatchObject({
      ns: 'shop.orders',
      op: 'find',
      count: 2,
      totalMs: 9000,
      maxMs: 5000,
      meanMs: 4500,
      collscan: true,
    })
    expect(r.slow[1]).toMatchObject({
      count: 20,
      totalMs: 2100,
      maxMs: 200,
      meanMs: 105,
      p95Ms: 190,
      collscan: false,
    })
    expect(r.slow[1]!.plans).toEqual({ 'IXSCAN { a: 1 }': 20 })
    expect(r.slow[1]!.docsExamined).toBe(200)
    // The first raw line of the group, kept for when the user asks.
    expect(r.slow[0]!.example).toContain('"userId":7')
  })

  it('counts lines, the unreadable, severities, components, the time range and the server', () => {
    const a = new Analyzer()
    a.add(event(1, 'I', 23403, 'Build Info', 'CONTROL', { buildInfo: { version: '8.0.4' } }))
    a.add(event(2, 'I', 4615611, 'MongoDB starting', 'CONTROL', { host: 'db1' }))
    a.add(event(3, 'W', 20001, 'Low disk', 'STORAGE'))
    a.add(event(9, 'W', 20001, 'Low disk', 'STORAGE'))
    a.add(event(5, 'E', 22435, 'WiredTiger error', 'STORAGE'))
    a.add('garbage')
    const r = a.result()
    expect(r).toMatchObject({
      lines: 6,
      unreadable: 1,
      version: '8.0.4',
      host: 'db1',
      first: Date.parse(at(1)),
      last: Date.parse(at(9)),
    })
    expect(r.severities).toEqual({ I: 2, W: 2, E: 1 })
    expect(r.components).toEqual({ CONTROL: 2, STORAGE: 3 })
    expect(r.messages).toEqual([
      {
        severity: 'E',
        component: 'STORAGE',
        id: 22435,
        msg: 'WiredTiger error',
        count: 1,
        first: Date.parse(at(5)),
        last: Date.parse(at(5)),
      },
      {
        severity: 'W',
        component: 'STORAGE',
        id: 20001,
        msg: 'Low disk',
        count: 2,
        first: Date.parse(at(3)),
        last: Date.parse(at(9)),
      },
    ])
  })

  it('counts connections by client with their applications, and the most at once', () => {
    const a = new Analyzer()
    const net = (id: number, msg: string, attr: Record<string, unknown>) =>
      a.add(event(1, 'I', id, msg, 'NETWORK', attr))
    net(22943, 'Connection accepted', { remote: '10.0.0.1:1', connectionCount: 5 })
    net(22943, 'Connection accepted', { remote: '10.0.0.1:2', connectionCount: 9 })
    net(22943, 'Connection accepted', { remote: '10.0.0.2:1', connectionCount: 6 })
    net(51800, 'client metadata', { remote: '10.0.0.1:1', doc: { application: { name: 'billing' } } })
    net(22944, 'Connection ended', { remote: '10.0.0.1:1' })
    expect(a.result().connections).toEqual({
      opened: 3,
      ended: 1,
      peak: 9,
      clients: [
        { client: '10.0.0.1', opened: 2, ended: 1, apps: ['billing'] },
        { client: '10.0.0.2', opened: 1, ended: 0, apps: [] },
      ],
      otherClients: 0,
    })
  })

  it('draws a timeline by the minute, by the hour over a long log', () => {
    const a = new Analyzer()
    a.add(event(0))
    a.add(slow(0, 100, { a: 1 }))
    a.add(event(2))
    const r = a.result()
    expect(r.timeline.bucketMs).toBe(60_000)
    expect(r.timeline.buckets).toEqual([
      { at: Date.parse(at(0)), lines: 2, slow: 1 },
      { at: Date.parse(at(1)), lines: 0, slow: 0 },
      { at: Date.parse(at(2)), lines: 1, slow: 0 },
    ])
    const long = new Analyzer()
    long.add(JSON.stringify({ t: { $date: '2026-10-01T00:00:00Z' }, s: 'I', c: 'X', id: 1, msg: 'a' }))
    long.add(JSON.stringify({ t: { $date: '2026-10-05T00:00:00Z' }, s: 'I', c: 'X', id: 1, msg: 'a' }))
    expect(long.result().timeline.bucketMs).toBe(3_600_000)
  })

  it('keeps at most so many shapes and messages, counting the rest', () => {
    const a = new Analyzer({ shapes: 3, messages: 2 })
    for (let i = 0; i < 6; i++) a.add(slow(1, 10, { [`f${i}`]: 1 }))
    a.add(slow(1, 10, { f5: 2 }))
    for (let i = 0; i < 5; i++) a.add(event(1, 'W', 100 + i, `m${i}`))
    const r = a.result()
    expect(r.slow).toHaveLength(3)
    // Wave 3 review: the slow lines of shapes not listed are counted, and in the summary's total.
    expect(r.otherSlow).toBe(4)
    expect(r.slowLines).toBe(7)
    expect(r.messages).toHaveLength(2)
    expect(r.otherMessages).toBe(3)
  })

  // Wave 3 review: the p95 came from the last 1,000 durations, not a sample of them all.
  it('takes the p95 from a sample of every duration, not the last ones', () => {
    const a = new Analyzer()
    for (let i = 0; i < 2000; i++) a.add(slow(1, 1000, { a: 1 }))
    for (let i = 0; i < 8000; i++) a.add(slow(2, 10, { a: 1 }))
    const g = a.result().slow[0]!
    expect(g.count).toBe(10000)
    expect(g.p95Ms).toBe(1000)
  })

  it('leaves a time before MongoDB or after now out of the range and the timeline, saying how many', () => {
    const now = Date.parse(at(30))
    const a = new Analyzer({ now })
    a.add(event(1))
    a.add(JSON.stringify({ t: { $date: '1970-01-01T00:00:01Z' }, s: 'W', c: 'X', id: 7, msg: 'odd' }))
    a.add(JSON.stringify({ t: { $date: '2099-01-01T00:00:00Z' }, s: 'W', c: 'X', id: 7, msg: 'odd' }))
    a.add(event(3))
    const r = a.result()
    expect(r).toMatchObject({ first: Date.parse(at(1)), last: Date.parse(at(3)), outOfRange: 2, lines: 4 })
    expect(r.timeline.bucketMs).toBe(60_000)
    expect(r.timeline.buckets).toHaveLength(3)
    // The message is counted; its times outside the range are not its first and last.
    expect(r.messages[0]).toMatchObject({ msg: 'odd', count: 2, first: null, last: null })
  })

  it('bounds every count and text it keeps', () => {
    const a = new Analyzer()
    const big = 'x'.repeat(10_000)
    // Forty severities of two characters, each its own.
    for (let i = 0; i < 40; i++) a.add(event(1, `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`))
    for (let i = 0; i < 400; i++) a.add(event(1, 'I', 1, 'x', `C${i}`))
    a.add(event(1, 'I', 23403, 'Build Info', 'CONTROL', { buildInfo: { version: big } }))
    a.add(event(1, 'I', 4615611, 'MongoDB starting', 'CONTROL', { host: big }))
    a.add(slow(1, 10, { a: 1 }, big, big))
    a.add(event(1, 'I', 22943, 'Connection accepted', 'NETWORK', { remote: `${big}:1`, connectionCount: 1 }))
    const r = a.result()
    // Sixteen at most, and MongoDB's own five always (wave 3 second review).
    expect(Object.keys(r.severities).length).toBeLessThanOrEqual(16 + 5)
    expect(Object.keys(r.components).length).toBeLessThanOrEqual(200)
    expect(r.version!.length).toBeLessThanOrEqual(64)
    expect(r.host!.length).toBeLessThanOrEqual(256)
    expect(r.slow[0]!.ns.length).toBeLessThanOrEqual(256)
    expect(Object.keys(r.slow[0]!.plans)[0]!.length).toBeLessThanOrEqual(200)
    expect(r.connections.clients[0]!.client.length).toBeLessThanOrEqual(128)
  })

  it('draws a log of very many minutes by the hour, its lines all counted', () => {
    const a = new Analyzer({ now: Date.parse('2030-01-01T00:00:00Z') })
    const start = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 0; i < 60_000; i++)
      a.add(
        JSON.stringify({
          t: { $date: new Date(start + i * 60_000).toISOString() },
          s: 'I',
          c: 'X',
          id: 1,
          msg: 'a',
        }),
      )
    const { timeline } = a.result()
    expect(timeline.bucketMs).toBeGreaterThanOrEqual(3_600_000)
    expect(timeline.buckets.reduce((n, b) => n + b.lines, 0)).toBe(60_000)
    // Its minutes kept are bounded: past the cap they are counted by the hour.
    const capped = new Analyzer({ now: Date.parse('2030-01-01T00:00:00Z'), slots: 100 })
    for (let i = 0; i < 500; i++)
      capped.add(
        JSON.stringify({
          t: { $date: new Date(start + i * 60_000).toISOString() },
          s: 'I',
          c: 'X',
          id: 1,
          msg: 'a',
        }),
      )
    const coarse = capped.result().timeline
    expect(coarse.bucketMs).toBe(3_600_000)
    expect(coarse.buckets.reduce((n, b) => n + b.lines, 0)).toBe(500)
  })

  it('counts a line over the cap as one not read', () => {
    const a = new Analyzer()
    a.add(event(1))
    a.addTooLong()
    expect(a.result()).toMatchObject({ lines: 2, unreadable: 1 })
  })

  it('groups the legacy log’s messages that differ only by their values', () => {
    const a = new Analyzer()
    a.add('2020-01-01T10:00:00.000+0000 W NETWORK  [conn9] Connection to 10.0.0.1:27017 failed after 3 tries')
    a.add('2020-01-01T10:01:00.000+0000 W NETWORK  [conn7] Connection to 10.0.0.2:27017 failed after 9 tries')
    expect(a.result().messages).toEqual([
      expect.objectContaining({ msg: 'Connection to ? failed after ? tries', count: 2 }),
    ])
  })

  it('writes the slow shapes as CSV, every cell quoted where it must be', () => {
    const a = new Analyzer()
    a.add(slow(1, 100, { 'a"b': 1 }, 'COLLSCAN', 'shop.o,rders'))
    const csv = slowCsv(a.result())
    expect(csv.split('\n')[0]).toBe(
      'namespace,operation,shape,count,total_ms,mean_ms,p95_ms,max_ms,plans,keys_examined,docs_examined,returned',
    )
    // A cell a spreadsheet would run as a formula is written as text.
    const formula = new Analyzer()
    formula.add(slow(1, 100, { a: 1 }, 'COLLSCAN', '=HYPERLINK("x")'))
    expect(slowCsv(formula.result()).split('\n')[1]!.startsWith(`"'=HYPERLINK(""x"")",find,`)).toBe(true)
    expect(csv.split('\n')[1]).toBe(
      '"shop.o,rders",find,"{""filter"":{""a\\""b"":""?""}}",1,100,100,100,100,COLLSCAN,1,10,1',
    )
  })
})

describe('a log file read', () => {
  const lines = [
    '{"t":{"$date":"2026-10-26T10:00:00Z"},"s":"I","c":"X","id":1,"msg":"a"}',
    'line two',
    'ünïcödé three',
  ]

  it('reads lines in a stream, across chunk boundaries, saying how far it got', async () => {
    const blob = new Blob([lines.join('\n') + '\n'])
    const seen: string[] = []
    const progress: number[] = []
    await readLines(
      blob,
      (l) => void seen.push(l),
      (done) => void progress.push(done),
      new AbortController().signal,
      7,
    )
    expect(seen).toEqual(lines)
    expect(progress.at(-1)).toBe(blob.size)
  })

  it('reads a gzipped log, and stops when asked', async () => {
    const gz = await new Response(
      new Blob([lines.join('\n')]).stream().pipeThrough(new CompressionStream('gzip')),
    ).blob()
    const seen: string[] = []
    await readLines(
      gz,
      (l) => void seen.push(l),
      () => undefined,
      new AbortController().signal,
    )
    expect(seen).toEqual(lines)
    const stop = new AbortController()
    const some: string[] = []
    await expect(
      readLines(
        new Blob([lines.join('\n')]),
        (l) => {
          some.push(l)
          stop.abort()
        },
        () => undefined,
        stop.signal,
        4,
      ),
    ).rejects.toThrow(/stopped/)
    expect(some).toHaveLength(1)
    // Within one piece too: the lines after the stop are not read.
    const once = new AbortController()
    const first: string[] = []
    await expect(
      readLines(
        new Blob([lines.join('\n')]),
        (l) => {
          first.push(l)
          once.abort()
        },
        () => undefined,
        once.signal,
      ),
    ).rejects.toThrow(/stopped/)
    expect(first).toHaveLength(1)
  })

  const gzip = (text: string) =>
    new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
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

  // Wave 3 review: what the reader was never tested with.
  it('reads Windows line ends, and a character split between two pieces', async () => {
    expect(await read(new Blob(['a\r\nb\r\n\r\nc\r\n']), 3)).toEqual(['a', 'b', '', 'c'])
    // "ü" is two bytes: a one-byte piece splits it.
    expect(await read(new Blob(['xü\nçy']), 1)).toEqual(['xü', 'çy'])
  })

  it('skips a line longer than the cap to its end, counting it once', async () => {
    let long = 0
    const seen = await read(new Blob(['short\n' + 'x'.repeat(50) + '\nafter\n' + 'y'.repeat(40)]), 7, {
      maxLine: 20,
      onTooLong: () => void long++,
    })
    expect(seen).toEqual(['short', 'after'])
    expect(long).toBe(2)
    // In one piece too.
    let once = 0
    expect(
      await read(new Blob(['a\n' + 'z'.repeat(30) + '\nb']), undefined, {
        maxLine: 20,
        onTooLong: () => void once++,
      }),
    ).toEqual(['a', 'b'])
    expect(once).toBe(1)
    // A line with no end is let go as soon as it is over the cap, never held to the file's end.
    const events: string[] = []
    await readLines(
      new Blob(['a\n' + 'y'.repeat(100)]),
      (l) => void events.push(`line ${l}`),
      () => void events.push('progress'),
      new AbortController().signal,
      7,
      { maxLine: 20, onTooLong: () => void events.push('too long') },
    )
    expect(events.indexOf('too long')).toBeLessThan(6)
    expect(events.filter((e) => e === 'too long')).toHaveLength(1)
  })

  it('refuses a file over the size cap, and a gzipped one that grows over it', async () => {
    await expect(read(new Blob(['0123456789\n']), undefined, { maxBytes: 5 })).rejects.toThrow(/too_large/)
    const seen: string[] = []
    const bomb = await gzip('a\n'.repeat(5000))
    expect(bomb.size).toBeLessThan(1000)
    await expect(
      readLines(
        bomb,
        (l) => void seen.push(l),
        () => undefined,
        new AbortController().signal,
        undefined,
        {
          maxBytes: 1000,
        },
      ),
    ).rejects.toThrow(/too_large/)
    expect(seen.length).toBeLessThanOrEqual(500)
  })

  it('cancels the gzipped file’s stream when stopped, and says a broken one is broken', async () => {
    // Varied enough to inflate in many blocks, as a real log does: a Stop comes mid-file.
    const gz = await gzip(
      Array.from(
        { length: 20000 },
        (_, i) => `line ${i} ${Math.sin(i).toString(36)}${Math.cos(i * 7).toString(36)}`,
      ).join('\n'),
    )
    let cancelled = false
    // The file's bytes handed out a little at a time, as a large file's are.
    const bytes = new Uint8Array(await gz.arrayBuffer())
    let given = 0
    const watched = {
      size: gz.size,
      slice: (a?: number, b?: number) => gz.slice(a, b),
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (given >= bytes.length) return controller.close()
            controller.enqueue(bytes.slice(given, given + 4096))
            given += 4096
          },
          cancel() {
            cancelled = true
          },
        }),
    } as unknown as Blob
    const stop = new AbortController()
    await expect(
      readLines(
        watched,
        () => stop.abort(),
        () => undefined,
        stop.signal,
      ),
    ).rejects.toThrow(/stopped/)
    await new Promise((r) => setTimeout(r, 20))
    expect(cancelled).toBe(true)
    expect(given).toBeLessThan(bytes.length)
    // Cut short: said in words, the lines before it kept.
    const whole = new Uint8Array(await gz.arrayBuffer())
    const cut = new Blob([whole.slice(0, Math.floor(whole.length / 2))])
    const seen: string[] = []
    await expect(
      readLines(
        cut,
        (l) => void seen.push(l),
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/bad_gzip/)
  })
})
