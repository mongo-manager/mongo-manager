// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach } from 'vitest'
import { TEXT_ENCODINGS } from '@mongo-manager/shared'
import { StrictDecoder, decodeText, guessEncoding, type TextEncoding } from '../src/transfer/text'
import { AppError } from '../src/errors'
import { MIGRATIONS } from '../src/store/migrations'
import { TransferFiles } from '../src/transfer/files'
import { MiB, type TransferLimits } from '../src/transfer/limits'
import { openSource, preview } from '../src/transfer/source'
import { isFailure } from '../src/transfer/formats/types'

/**
 * W4 item 1 (completion design §2 W4.1): the encodings a file may be read in, chosen by the user
 * or suggested from the bytes. Single-byte tables are this repository's own (no ICU dependency).
 */
async function read(bytes: Buffer, encoding: TextEncoding, lenient = false): Promise<string> {
  let out = ''
  for await (const s of decodeText(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), encoding, {
    lenient,
  }))
    out += s
  return out
}

// "Işık Şahin, Ğ ğ İ ı ş ç ö ü" in Windows-1254 / ISO-8859-9.
const TURKISH = Buffer.from([
  0x49, 0xfe, 0xfd, 0x6b, 0x20, 0xde, 0x61, 0x68, 0x69, 0x6e, 0x2c, 0x20, 0xd0, 0x20, 0xf0, 0x20, 0xdd, 0x20,
  0xfd, 0x20, 0xfe, 0x20, 0xe7, 0x20, 0xf6, 0x20, 0xfc,
])

describe('single-byte encodings (W4.1)', () => {
  it('lists every encoding the picker offers', () => {
    expect([...TEXT_ENCODINGS]).toEqual([
      'utf8',
      'utf16le',
      'utf16be',
      'latin1',
      'windows1252',
      'windows1254',
      'iso88599',
    ])
  })

  it('reads Turkish text in Windows-1254 and ISO-8859-9', async () => {
    expect(await read(TURKISH, 'windows1254')).toBe('Işık Şahin, Ğ ğ İ ı ş ç ö ü')
    expect(await read(TURKISH, 'iso88599')).toBe('Işık Şahin, Ğ ğ İ ı ş ç ö ü')
  })

  it('reads Latin-1 byte for byte and Windows-1252 with its punctuation block', async () => {
    expect(await read(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xfe]), 'latin1')).toBe('caféþ')
    expect(await read(Buffer.from([0x80, 0x20, 0x93, 0x61, 0x94, 0x8a]), 'windows1252')).toBe('€ “a”Š')
    expect(await read(Buffer.from([0x80, 0x8a]), 'windows1254')).toBe('€Š')
    // ISO-8859 keeps 0x80–0x9F as the C1 controls they are.
    expect(await read(Buffer.from([0x80]), 'iso88599')).toBe('\u0080')
  })

  it('agrees with the WHATWG tables for every defined byte', async () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    for (const [ours, label] of [
      ['windows1252', 'windows-1252'],
      ['windows1254', 'windows-1254'],
    ] as const) {
      const text = await read(all, ours, true)
      const theirs = new TextDecoder(label).decode(all)
      const a = [...text]
      const b = [...theirs]
      expect(a).toHaveLength(256)
      for (let i = 0; i < 256; i++) if (a[i] !== '\udfff') expect([ours, i, a[i]]).toEqual([ours, i, b[i]])
    }
  })

  it('treats a byte Windows-125x leaves undefined as invalid: a row error when lenient, a refusal when strict (T11)', async () => {
    expect(await read(Buffer.from([0x61, 0x81, 0x62]), 'windows1252', true)).toBe('a\udfffb')
    expect(await read(Buffer.from([0x61, 0x9e]), 'windows1254', true)).toBe('a\udfff')
    await expect(read(Buffer.from([0x61, 0x8d]), 'windows1252')).rejects.toBeInstanceOf(AppError)
    expect(() => new StrictDecoder('windows1254').write(Buffer.from([0x8e]))).toThrow(AppError)
  })

  it('never hides a "$" or a NUL that the bytes do not hold', async () => {
    for (const enc of ['latin1', 'windows1252', 'windows1254', 'iso88599'] as const) {
      const text = await read(
        Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 0x24 && b !== 0)),
        enc,
        true,
      )
      expect(text.includes('$')).toBe(false)
      expect(text.includes('\0')).toBe(false)
    }
  })
})

describe('guessing an encoding (W4.1: detect and suggest)', () => {
  const utf16 = (s: string, be: boolean) => {
    const b = Buffer.from(s, 'utf16le')
    return be ? b.swap16() : b
  }

  it('follows a byte order mark', () => {
    expect(guessEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf8')
    expect(guessEncoding(Buffer.from([0xff, 0xfe, 0x61, 0]))).toBe('utf16le')
    expect(guessEncoding(Buffer.from([0xfe, 0xff, 0, 0x61]))).toBe('utf16be')
  })

  it('spots UTF-16 without a byte order mark by its zero bytes', () => {
    expect(guessEncoding(utf16('id,name\n1,Ali\n', false))).toBe('utf16le')
    expect(guessEncoding(utf16('id,name\n1,Ali\n', true))).toBe('utf16be')
  })

  it('keeps UTF-8 when the bytes are valid UTF-8, a sequence cut at the end included', () => {
    expect(guessEncoding(Buffer.from('ad,şehir\nAli,İzmir\n'))).toBe('utf8')
    expect(guessEncoding(Buffer.from('ab').subarray(0, 2))).toBe('utf8')
    expect(guessEncoding(Buffer.concat([Buffer.from('aş'), Buffer.from('ş').subarray(0, 1)]))).toBe('utf8')
  })

  it('suggests Windows-1254 for Turkish letters and Windows-1252 otherwise', () => {
    expect(guessEncoding(TURKISH)).toBe('windows1254')
    expect(guessEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x61, 0x94]))).toBe('windows1252')
  })
})

describe('the preview with an encoding (W4.1)', () => {
  let dir: string
  let db: DatabaseSync
  let files: TransferFiles
  const limits: TransferLimits = {
    maxUpload: 64 * MiB,
    quota: 256 * MiB,
    ttlMs: 3600_000,
    maxJobMs: 3600_000,
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mm-enc-'))
    db = new DatabaseSync(':memory:')
    for (const m of MIGRATIONS) db.exec(m.sql)
    files = new TransferFiles(db, join(dir, 't'), limits, () => 1)
    files.init()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const upload = (bytes: Buffer) =>
    files.receive({ owner: 'u1', connectionId: 'c1', name: 'f', body: Readable.from([bytes]) })
  const csv = Buffer.concat([
    Buffer.from('ad;sehir\n'),
    TURKISH.subarray(0, 4),
    Buffer.from(';'),
    TURKISH.subarray(5, 10),
    Buffer.from('\n'),
  ])

  it('suggests an encoding but never applies a guess by itself', async () => {
    const p = await preview(await upload(csv), files, { dialect: {} }, limits)
    expect(p.dialect.encoding).toBe('utf8')
    expect(p.suggestedEncoding).toBe('windows1254')
    // The row with bytes that are not UTF-8 is refused, not read as mojibake.
    expect(p.records).toEqual([])
  })

  it('reads the file in the chosen encoding, without the UTF-8 warning', async () => {
    const p = await preview(await upload(csv), files, { dialect: { encoding: 'windows1254' } }, limits)
    expect(p.dialect.encoding).toBe('windows1254')
    expect(p.suggestedEncoding).toBeUndefined()
    expect(p.warnings).toEqual([])
    expect(p.records).toEqual([{ ad: 'Işık', sehir: 'Şahin' }])
  })

  it('imports with the chosen encoding', async () => {
    const file = await upload(csv)
    const o = await openSource(
      file,
      files,
      { format: 'csv', dialect: { encoding: 'iso88599', delimiter: ';' }, allowUnusual: false },
      limits,
    )
    const rows: unknown[] = []
    if (o.source.kind === 'table')
      for await (const r of o.source.rows) rows.push(isFailure(r) ? r.error : r.cells)
    await o.close()
    expect(rows).toEqual([['Işık', 'Şahin']])
  })

  // W4 review (minors): a single-byte encoding chosen for a file that is UTF-8.
  it('drops a byte order mark under a single-byte encoding, and says the file looks like UTF-8', async () => {
    const utf8 = Buffer.from('ad,şehir\nAyşe,İzmir\n', 'utf8')
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])
    const p = await preview(await upload(withBom), files, { dialect: { encoding: 'windows1254' } }, limits)
    // The first header is not "ï»¿ad".
    expect(Object.keys(p.records[0] as object)[0]).toBe('ad')
    expect(p.warnings.join(' ')).toMatch(/byte order mark/)
    const q = await preview(await upload(utf8), files, { dialect: { encoding: 'windows1252' } }, limits)
    expect(q.warnings.join(' ')).toMatch(/valid UTF-8/)
    // Plain ASCII says nothing: it reads the same in both.
    const ascii = await preview(
      await upload(Buffer.from('a,b\n1,2\n')),
      files,
      {
        dialect: { encoding: 'windows1252' },
      },
      limits,
    )
    expect(ascii.warnings).toEqual([])
  })

  it('suggests UTF-16 for a file without a byte order mark and reads it when chosen', async () => {
    const bytes = Buffer.from('id,name\n1,Ayşe\n', 'utf16le')
    const p = await preview(await upload(bytes), files, { dialect: {} }, limits)
    expect(p.suggestedEncoding).toBe('utf16le')
    const q = await preview(
      await upload(bytes),
      files,
      { format: 'csv', dialect: { encoding: 'utf16le' } },
      limits,
    )
    expect(q.records).toEqual([{ id: { $numberInt: '1' }, name: 'Ayşe' }])
  })
})
