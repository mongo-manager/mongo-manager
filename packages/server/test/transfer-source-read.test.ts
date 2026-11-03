import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { MiB, type TransferLimits } from '../src/transfer/limits'
import { detect } from '../src/transfer/source'
import { slow } from './support/slowness'

/**
 * Review of the stream errors (2026-10-20): a gzip file's head was read through .pipe(), which does
 * not pass an error on. A read that failed part way (a disk error) was an uncaught error, which ends
 * the server, and the detection waited for the rest for ever. It fails with the read's error.
 */
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return { ...real, createReadStream: vi.fn(real.createReadStream) }
})

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-source-read-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("a gzip file's head that cannot be read whole", () => {
  it(
    'fails the detection with the read error',
    async () => {
      // Little to compress: within the inflate ratio a file of its size may reach.
      const zipped = gzipSync(Buffer.from(randomBytes(60_000).toString('hex')))
      const path = join(dir, 'f.csv.gz')
      writeFileSync(path, zipped)
      const real = vi.mocked(fs.createReadStream).getMockImplementation()!
      // The plain head reads as it is; the inflated one breaks after its first bytes.
      vi.mocked(fs.createReadStream)
        .mockImplementationOnce(real)
        .mockImplementationOnce(() => {
          const s = new Readable({ read() {} })
          s.push(zipped.subarray(0, 64))
          setImmediate(() => s.destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })))
          return s as never
        })
      const limits = { maxUpload: 64 * MiB } as TransferLimits
      await expect(detect(path, zipped.length, limits)).rejects.toMatchObject({ code: 'EIO' })
    },
    slow(10_000),
  )
})
