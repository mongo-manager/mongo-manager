// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { readLines } from '../src/read'
import { foldLists, legacyShape as legacyShapeOf } from '../src/parse'
import { ChromiumLikeDecompressionStream, ReadsOnDecompressionStream } from './chromiumGzip'

/**
 * Plugins wave 3, the third review of the branch: a gzipped file of joined parts read as a browser
 * reads it (Chromium inflates one part, calls the rest junk and drops the end of what it inflated),
 * never from the output of a stream that failed; and the legacy shape's folding bounded.
 */
const read = async (blob: Blob, chunk?: number) => {
  const seen: string[] = []
  await readLines(
    blob,
    (l) => void seen.push(l),
    () => undefined,
    new AbortController().signal,
    chunk,
  )
  return seen
}
const many = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} ${i} ${Math.sin(i)}`).join('\n') + '\n'
const joined = (...texts: string[]) => new Blob(texts.map((t) => new Uint8Array(gzipSync(Buffer.from(t)))))

afterEach(() => vi.unstubAllGlobals())

describe('a gzipped file of several parts, as each runtime reads it', () => {
  for (const [runtime, stub] of [
    ['Node’s own reader (it reads joined parts whole)', false],
    ['a Chromium-like reader (one part, the rest junk, its last output dropped)', true],
  ] as const) {
    describe(runtime, () => {
      it('reads every line of every part, in order', async () => {
        if (stub) vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
        const seen = await read(joined('one\ntwo\n', many(3000, 'mid'), 'last\n'))
        expect(seen.slice(0, 2)).toEqual(['one', 'two'])
        expect(seen[2]).toBe(`mid 0 ${Math.sin(0)}`)
        expect(seen.at(-2)).toBe(`mid 2999 ${Math.sin(2999)}`)
        expect(seen.at(-1)).toBe('last')
        expect(seen).toHaveLength(2 + 3000 + 1)
      })

      it('reads a line that runs from one part into the next whole', async () => {
        if (stub) vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
        expect(await read(joined('a\nhal', 'f\nb\n'))).toEqual(['a', 'half', 'b'])
      })

      it('never takes bytes that only look like a part’s start for one', async () => {
        if (stub) vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
        // A part stored as it is holds bytes that read as gzip's header: 1f 8b 08.
        const looksLikeStart = Buffer.from([...Buffer.from('a'.repeat(20)), 0x1f, 0x8b, 0x08, 0x62, 0x0a])
        const parts = [gzipSync(looksLikeStart, { level: 0 }), gzipSync(Buffer.from('ok\nlast\n'))]
        const seen = await read(new Blob(parts.map((p) => new Uint8Array(p))))
        expect(seen.slice(1)).toEqual(['ok', 'last'])
        expect(seen).toHaveLength(3)
      })

      it('says a file whose later part is cut short is broken, keeping the lines before', async () => {
        if (stub) vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
        const first = gzipSync(Buffer.from('one\ntwo\n'))
        const second = gzipSync(Buffer.from(many(500, 'x')))
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
        // A reader that read on into the cut part told its lines once (never again when it is read alone).
        expect(new Set(seen).size).toBe(seen.length)
        expect(seen.filter((l) => l.startsWith('x ')).length).toBeLessThanOrEqual(500)
      })
    })
  }

  it('tells once what a reader that reads on into the next parts told before a cut part failed it', async () => {
    vi.stubGlobal('DecompressionStream', ReadsOnDecompressionStream)
    expect(await read(joined('one\ntwo\n', many(50, 'mid'), 'last\n'))).toHaveLength(53)
    const second = gzipSync(Buffer.from(many(500, 'x')))
    const third = gzipSync(Buffer.from(many(500, 'y')))
    const cut = new Blob([
      new Uint8Array(gzipSync(Buffer.from('one\ntwo\n'))),
      new Uint8Array(second),
      new Uint8Array(third.subarray(0, third.length - 20)),
    ])
    const seen: string[] = []
    await expect(
      readLines(
        cut,
        (l) => void seen.push(l),
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/bad_gzip/)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((l) => l.startsWith('x ')).length).toBe(500)
  })

  it('caps what all the parts inflate to together, not each one', async () => {
    vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
    const part = many(100, 'p')
    expect(part.length).toBeLessThan(4000)
    await expect(
      readLines(
        joined(part, part, part),
        () => undefined,
        () => undefined,
        new AbortController().signal,
        undefined,
        { maxBytes: part.length * 2 + 10 },
      ),
    ).rejects.toThrow(/too_large/)
  })

  it('reads a Chromium-like part whose output came out in pieces, never telling a line twice', async () => {
    vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
    // Read in small pieces: the reader gives out part of the first part before the junk error.
    const seen = await read(joined(many(4000, 'p'), many(10, 'q')), 4096)
    expect(seen).toHaveLength(4010)
    expect(new Set(seen).size).toBe(4010)
    expect(seen[3999]).toBe(`p 3999 ${Math.sin(3999)}`)
    expect(seen[4000]).toBe(`q 0 ${Math.sin(0)}`)
  })

  it('stops reading a Chromium-like file when asked, its streams let go', async () => {
    vi.stubGlobal('DecompressionStream', ChromiumLikeDecompressionStream)
    const stop = new AbortController()
    const seen: string[] = []
    await expect(
      readLines(
        joined(many(2000, 'a'), many(2000, 'b')),
        (l) => {
          seen.push(l)
          if (seen.length === 10) stop.abort()
        },
        () => undefined,
        stop.signal,
        4096,
      ),
    ).rejects.toThrow(/stopped/)
    expect(seen.length).toBeLessThanOrEqual(10)
  })
})

describe('the legacy shape’s folding (third review)', () => {
  it('folds a line of a bracket and endless spaces in well under a second', () => {
    const line = `{ a: [${' '.repeat(100_000)}`
    const started = performance.now()
    legacyShapeOf(line)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('folds a long body only as far as its shape is kept', () => {
    // Lists in lists, a hundred deep, over and over for a megabyte: folded whole, a hundred passes.
    const nested = `${'[ '.repeat(99)}1${' ]'.repeat(99)}, `
    const body = `{ a: [ ${nested.repeat(Math.ceil(1_000_000 / nested.length))} ] }`
    // What each fold pass runs over: never more than the shape could keep (four times its length).
    const folded: number[] = []
    const replace = String.prototype.replace
    vi.spyOn(String.prototype, 'replace').mockImplementation(function (
      this: string,
      ...args: Parameters<typeof replace>
    ) {
      if (args[0] instanceof RegExp && args[0].source.startsWith('\\[\\s*')) folded.push(this.length)
      return replace.apply(this, args) as string
    })
    const shape = legacyShapeOf(body)
    vi.restoreAllMocks()
    expect(folded.length).toBeGreaterThan(0)
    expect(Math.max(...folded)).toBeLessThanOrEqual(1200)
    expect(shape.length).toBeLessThanOrEqual(300)
  })

  it('folds a list of values in time linear in its length', () => {
    const started = performance.now()
    expect(foldLists(`[${' '.repeat(100_000)}`)).toBe(`[${' '.repeat(100_000)}`)
    expect(foldLists('{ a: [ ?, [ ?, ? ], ? ] }')).toBe('{ a: ? }')
    expect(performance.now() - started).toBeLessThan(250)
  })
})
