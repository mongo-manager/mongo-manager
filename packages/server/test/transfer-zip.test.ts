import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32 } from 'node:zlib'
import { AppError } from '../src/errors'
import { InflateBudget, ZipReader, ZipWriter } from '../src/transfer/formats/zip'
import { rawZip, zipBomb } from './support/hostile'
import { fuzz } from './support/fuzz'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-zip-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
async function withZip<T>(bytes: Buffer, use: (zip: ZipReader) => Promise<T>): Promise<T> {
  const path = join(dir, `z${seq++}.zip`)
  writeFileSync(path, bytes)
  const handle = await open(path, 'r')
  try {
    return await use(await ZipReader.open(handle, bytes.length))
  } finally {
    await handle.close()
  }
}
const readEntry = (bytes: Buffer, name: string, budget = bytes.length * 20) =>
  withZip(bytes, (zip) => zip.readAll(name, new InflateBudget(budget), 1e9))
async function reason(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    return e instanceof AppError ? (e.details as { reason?: string }).reason : String(e)
  }
  return 'ok'
}

describe('zip reading (spec §7 T4, T8)', () => {
  it('reads stored and deflated entries, and counts the compressed bytes read', async () => {
    const z = rawZip([
      { name: 'a.txt', data: Buffer.from('hello'), method: 0 },
      { name: 'b.txt', data: Buffer.from('world '.repeat(100)) },
    ])
    expect((await readEntry(z, 'a.txt')).toString()).toBe('hello')
    expect((await readEntry(z, 'b.txt')).toString()).toBe('world '.repeat(100))
    const read = await withZip(z, async (zip) => {
      expect(zip.names()).toEqual(['a.txt', 'b.txt'])
      expect(zip.has('b.txt')).toBe(true)
      await zip.readAll('a.txt', new InflateBudget(1e6), 1e6)
      return zip.bytesRead
    })
    expect(read).toBe(5)
  })

  it('refuses duplicate names, header mismatches, overlaps, encryption and lies about sizes or CRC', async () => {
    const d = Buffer.from('data')
    const open = (z: Buffer) => withZip(z, async () => undefined)
    expect(
      await reason(
        open(
          rawZip([
            { name: 'a', data: d },
            { name: 'a', data: d },
          ]),
        ),
      ),
    ).toBe('zip')
    expect(await reason(open(rawZip([{ name: 'a', data: d, localName: 'b' }])))).toBe('zip')
    expect(
      await reason(
        open(
          rawZip(
            [
              { name: 'a', data: d },
              { name: 'b', data: d },
            ],
            { overlapSecondOntoFirst: true },
          ),
        ),
      ),
    ).toBe('zip')
    expect(await reason(open(rawZip([{ name: 'a', data: d, flags: 1 }])))).toBe('zip')
    expect(await reason(open(Buffer.from('not a zip at all')))).toBe('zip')
    expect(await reason(readEntry(rawZip([{ name: 'a', data: d, declaredSize: 2 }]), 'a'))).toBe('zip')
    expect(await reason(readEntry(rawZip([{ name: 'a', data: d, crc: 1 }]), 'a'))).toBe('zip')
    expect(await reason(readEntry(rawZip([{ name: 'a', data: d }]), 'missing'))).toBe('zip')
  })

  it('refuses an entry declared larger than 512 MiB before reading it', async () => {
    const big = rawZip([{ name: 'a', data: Buffer.from('x'), declaredSize: 600 * 1024 * 1024 }])
    expect(await reason(withZip(big, async () => undefined))).toBe('inflate')
  })

  it('stops a zip bomb (T4)', async () => {
    const started = Date.now()
    expect(await reason(readEntry(zipBomb(), 'xl/worksheets/sheet1.xml'))).toBe('inflate')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('writes zips that it reads back, CRC included', async () => {
    const path = join(dir, 'w.zip')
    const out = createWriteStream(path)
    const w = new ZipWriter(out)
    await w.add('a.xml', '<a/>')
    await w.add(
      'b.bin',
      (async function* () {
        yield Buffer.from('x'.repeat(100_000))
        yield 'tail'
      })(),
    )
    const written = await w.finish()
    await new Promise((r) => out.end(r))
    const bytes = readFileSync(path)
    expect(written).toBe(bytes.length)
    expect((await readEntry(bytes, 'a.xml')).toString()).toBe('<a/>')
    // 100 000 equal bytes compress far beyond the ratio budget: this test checks the format only.
    const b = await readEntry(bytes, 'b.bin', 1e6)
    expect(b.length).toBe(100_004)
    expect(crc32(b)).toBe(crc32(Buffer.from('x'.repeat(100_000) + 'tail')))
  })

  it('survives fuzzing', async () => {
    const base = rawZip([
      { name: 'a', data: Buffer.from('hello world') },
      { name: 'b', data: Buffer.from('x') },
    ])
    await fuzz(6101, 300, base, (input) =>
      withZip(input, async (zip) => {
        for (const name of zip.names()) await zip.readAll(name, new InflateBudget(input.length * 20), 1e6)
      }),
    )
  })
})
