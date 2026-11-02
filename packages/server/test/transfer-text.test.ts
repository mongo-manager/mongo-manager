import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StrictDecoder, decodeText, sniffEncoding } from '../src/transfer/text'
import { boundedGunzip, countBytes, isGzip } from '../src/transfer/gzip'
import { AppError } from '../src/errors'
import { hostile } from './support/hostile'

async function collect(chunks: Uint8Array[], encoding?: 'utf8' | 'utf16le' | 'utf16be'): Promise<string> {
  let out = ''
  for await (const s of decodeText(Readable.from(chunks), encoding)) out += s
  return out
}

async function reason(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? (e.details as { reason?: string }).reason : String(e)
  }
  return 'ok'
}

describe('strict text decoding (spec §7 T11)', () => {
  it('detects and strips byte order marks', async () => {
    expect(sniffEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ encoding: 'utf8', bom: 3 })
    expect(sniffEncoding(Buffer.from([0xff, 0xfe, 0x61, 0]))).toEqual({ encoding: 'utf16le', bom: 2 })
    expect(sniffEncoding(Buffer.from([0xfe, 0xff, 0, 0x61]))).toEqual({ encoding: 'utf16be', bom: 2 })
    expect(await collect([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('şğü')])).toBe('şğü')
    expect(await collect([Buffer.from([0xff, 0xfe, 0x24, 0x00, 0x61, 0x00])])).toBe('$a')
    expect(await collect([Buffer.from([0xfe, 0xff, 0x00, 0x24, 0x00, 0x61])])).toBe('$a')
    expect(await collect([Buffer.from('ab')])).toBe('ab')
    expect(await collect([])).toBe('')
  })

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = Buffer.from('İstanbul €')
    expect(await collect([bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)])).toBe('İstanbul €')
  })

  it('refuses invalid UTF-8 (Windows-1254 bytes) instead of replacing it', async () => {
    const cp1254 = Buffer.from([0x49, 0xfe, 0x6b]) // "Işk" in Windows-1254: 0xFE is not UTF-8
    expect(await reason(collect([cp1254]))).toBe('encoding')
    expect(await reason(collect([Buffer.from([0x61, 0xe2, 0x82])]))).toBe('encoding')
  })

  it('refuses lone surrogates in UTF-16', async () => {
    const d = new StrictDecoder('utf16le')
    expect(() => {
      d.write(Buffer.from([0x00, 0xd8, 0x61, 0x00]))
      d.end()
    }).toThrow(AppError)
  })

  it('decodes with a chosen encoding', async () => {
    expect(await collect([Buffer.from([0x24, 0x00])], 'utf16le')).toBe('$')
  })
})

describe('lenient decoding for record streams (spec §7 T11: a row error, never U+FFFD)', () => {
  async function lenient(chunks: Uint8Array[], encoding?: 'utf8' | 'utf16le' | 'utf16be'): Promise<string> {
    let out = ''
    for await (const s of decodeText(Readable.from(chunks), encoding, { lenient: true })) out += s
    return out
  }

  it('marks invalid UTF-8 with a lone surrogate the record readers refuse, and keeps valid text', async () => {
    const text = await lenient([
      Buffer.from([0x61, 0x0a, 0x49, 0xfe, 0x6b, 0x0a, 0xc3]),
      Buffer.from([0xa7, 0x0a]),
    ])
    expect(text).toBe('a\nI\udfffk\nç\n')
    expect(text.isWellFormed()).toBe(false)
    expect(await lenient([Buffer.from('ok €')])).toBe('ok €')
    expect(await lenient([Buffer.from([0xe2, 0x82])])).toBe('\udfff')
    // An encoded surrogate: ED does not accept A0, so ED, A0 and 80 are three maximal subparts (as WHATWG).
    expect(await lenient([Buffer.from([0xed, 0xa0, 0x80, 0x61])])).toBe('\udfff\udfff\udfffa')
  })

  it('keeps lone surrogates of UTF-16 as they are, and a real U+FFFD as it is', async () => {
    expect(await lenient([Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00])])).toBe('\ud800a')
    expect(await lenient([Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00])])).toBe('a\udfff')
    expect(await lenient([Buffer.from('�')])).toBe('�')
  })
})

describe('bounded gunzip (spec §7 T4)', () => {
  let counted = 0
  const drain = (input: Buffer, size: number, max: number) =>
    pipeline(
      Readable.from([input]),
      countBytes((n) => (counted += n)),
      boundedGunzip(size, max),
      new Writable({ write: (_c, _e, done) => done() }),
    )

  it('passes ordinary gzip and counts the compressed bytes', async () => {
    const z = gzipSync(Buffer.from('hello '.repeat(100)))
    expect(isGzip(z)).toBe(true)
    expect(isGzip(Buffer.from('ab'))).toBe(false)
    counted = 0
    expect(await reason(drain(z, z.length, 1e9))).toBe('ok')
    expect(counted).toBe(z.length)
  })

  it('stops a gzip bomb by ratio and by absolute size', async () => {
    const bomb = hostile.gzipBomb(1000)
    expect(await reason(drain(bomb, bomb.length, 1e12))).toBe('inflate')
    const z = gzipSync(Buffer.alloc(10_000))
    expect(await reason(drain(z, 1e9, 5_000))).toBe('inflate')
  })

  it('reports damaged gzip data as a bad file', async () => {
    const z = gzipSync(Buffer.from('hello world'))
    z[12] = z[12]! ^ 0xff
    expect(await reason(drain(z, z.length, 1e9))).toBe('gzip')
  })
})
