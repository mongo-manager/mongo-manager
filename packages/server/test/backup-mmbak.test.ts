import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  encryptMmbak,
  decryptMmbak,
  MMBAK_MAGIC,
  mmbakKdfRuns,
  readMmbakHeader,
  watchKdf,
} from '../src/backup/mmbak'
import { boundedInflate, zstdCompress } from '../src/backup/inflate'
import { detectContainer } from '../src/backup/detect'
import { AppError } from '../src/errors'

const PW = 'correct horse battery staple'
const tool = { name: 'mongo-manager', version: 'test' }
async function all(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const p of it) parts.push(p)
  return Buffer.concat(parts)
}
const from = (...bufs: Buffer[]) =>
  (async function* () {
    for (const b of bufs) yield b
  })()
const enc = (plain: Buffer, chunkBytes: number, parts = 1) => {
  const step = Math.ceil(plain.length / parts) || 1
  const pieces: Buffer[] = []
  for (let i = 0; i < plain.length; i += step) pieces.push(plain.subarray(i, i + step))
  return all(encryptMmbak(from(...pieces), { password: PW, chunkBytes, tool, now: 1 }))
}
const dec = (file: Buffer, password = PW) => all(decryptMmbak(from(file), { password }))
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

describe('.mmbak (spec §4.3)', () => {
  it('round-trips across chunk boundaries, empty input and one exact chunk (Review Focus 2)', async () => {
    for (const [size, chunk] of [
      [0, 1024],
      [1024, 1024],
      [1025, 1024],
      [10_000, 1024],
      [200_000, 4096],
    ] as const) {
      const plain = randomBytes(size)
      const file = await enc(plain, chunk, 7)
      expect(file.subarray(0, 8)).toEqual(MMBAK_MAGIC)
      expect(await dec(file), `${size}/${chunk}`).toEqual(plain)
    }
  })

  it('keeps names and flags out of the clear header', async () => {
    const file = await enc(Buffer.from('shop.orders secret@example.com'), 1024)
    const h = readMmbakHeader(file)
    expect(h).not.toBe('more')
    const text = JSON.stringify((h as { header: unknown }).header)
    expect(text).not.toMatch(/shop|orders|secret/)
    expect(file.includes(Buffer.from('secret@example.com'))).toBe(false)
  })

  it('refuses a wrong password, and every tampering, before releasing the damaged part (B6)', async () => {
    const plain = randomBytes(5000)
    const file = await enc(plain, 1024)
    await expect(dec(file, 'wrong password!!')).rejects.toMatchObject({
      details: { reason: 'backup_password' },
    })
    const chunkAt = (readMmbakHeader(file) as { bytes: number }).bytes
    const c1 = 4 + 1024 + 16
    const tampered: Array<[string, Buffer]> = []
    const flipped = Buffer.from(file)
    flipped[chunkAt + 10]! ^= 1
    tampered.push(['flipped ciphertext', flipped])
    tampered.push(['truncated (no final chunk)', file.subarray(0, file.length - 1040)])
    tampered.push(['trailing bytes', Buffer.concat([file, Buffer.from([0])])])
    const headerJson = file.subarray(12, chunkAt).toString('utf8')
    const changed = Buffer.from(headerJson.replace('"createdAt":1', '"createdAt":2'))
    expect(changed.toString()).not.toBe(headerJson)
    tampered.push([
      'changed header',
      Buffer.concat([file.subarray(0, 8), u32(changed.length), changed, file.subarray(chunkAt)]),
    ])
    tampered.push([
      'swapped chunks',
      Buffer.concat([
        file.subarray(0, chunkAt),
        file.subarray(chunkAt + c1, chunkAt + 2 * c1),
        file.subarray(chunkAt, chunkAt + c1),
        file.subarray(chunkAt + 2 * c1),
      ]),
    ])
    // A part from another backup made with the same password.
    const other = await enc(randomBytes(5000), 1024)
    const otherAt = (readMmbakHeader(other) as { bytes: number }).bytes
    tampered.push([
      'foreign chunk',
      Buffer.concat([
        file.subarray(0, chunkAt),
        other.subarray(otherAt, otherAt + c1),
        file.subarray(chunkAt + c1),
      ]),
    ])
    for (const [label, buf] of tampered) {
      let released = 0
      await expect(
        (async () => {
          for await (const part of decryptMmbak(from(buf), { password: PW })) released += part.length
        })(),
        label,
      ).rejects.toBeInstanceOf(AppError)
      // Only whole parts before the damaged one may have been released.
      expect(released % 1024, label).toBe(0)
    }
  })

  it('refuses oversized KDF parameters before running the KDF', async () => {
    const file = await enc(Buffer.from('x'), 1024)
    const at = (readMmbakHeader(file) as { bytes: number }).bytes
    const json = JSON.parse(file.subarray(12, at).toString('utf8'))
    json.keySlots[0].kdf.N = 2 ** 30
    const body = Buffer.from(JSON.stringify(json))
    const forged = Buffer.concat([MMBAK_MAGIC, u32(body.length), body, file.subarray(at)])
    const started = Date.now()
    await expect(dec(forged)).rejects.toMatchObject({ details: { reason: 'mmbak' } })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('.mmbak key derivation cost (final review I2)', () => {
  const forge = async (
    edit: (json: { keySlots: Array<Record<string, unknown> & { kdf: Record<string, unknown> }> }) => void,
  ) => {
    const file = await enc(Buffer.from('x'), 1024)
    const at = (readMmbakHeader(file) as { bytes: number }).bytes
    const json = JSON.parse(file.subarray(12, at).toString('utf8'))
    edit(json)
    const body = Buffer.from(JSON.stringify(json))
    return Buffer.concat([MMBAK_MAGIC, u32(body.length), body, file.subarray(at)])
  }

  it('accepts only the KDF cost it writes, and one password slot', async () => {
    for (const forged of [
      await forge((j) => (j.keySlots[0]!.kdf.N = 2 ** 18)),
      await forge((j) => (j.keySlots[0]!.kdf.r = 16)),
      await forge((j) => (j.keySlots[0]!.kdf.p = 4)),
      await forge((j) => j.keySlots.push(JSON.parse(JSON.stringify(j.keySlots[0])))),
    ]) {
      const before = mmbakKdfRuns()
      await expect(dec(forged, 'wrong password')).rejects.toMatchObject({ details: { reason: 'mmbak' } })
      expect(mmbakKdfRuns()).toBe(before)
    }
  })

  it('derives a key once per file and password, never for a wrong password', async () => {
    const file = await enc(randomBytes(3000), 1024)
    const before = mmbakKdfRuns()
    expect((await dec(file)).length).toBe(3000)
    expect((await dec(file)).length).toBe(3000)
    expect(mmbakKdfRuns()).toBe(before + 1)
    await expect(dec(file, 'wrong password')).rejects.toMatchObject({
      details: { reason: 'backup_password' },
    })
    await expect(dec(file, 'wrong password')).rejects.toMatchObject({
      details: { reason: 'backup_password' },
    })
    expect(mmbakKdfRuns()).toBe(before + 3)
  })

  it('runs at most two key derivations at once, and refuses past a short queue', async () => {
    const files = await Promise.all(Array.from({ length: 24 }, () => enc(Buffer.from('y'), 1024)))
    let peak = 0
    const stop = watchKdf((running) => (peak = Math.max(peak, running)))
    const results = await Promise.allSettled(files.map((f) => dec(f, `nope ${Math.random()}`)))
    stop()
    expect(peak).toBeLessThanOrEqual(2)
    const reasons = results.map((r) => (r.status === 'rejected' ? (r.reason as AppError).statusCode : 200))
    expect(reasons).toContain(429)
    expect(reasons.filter((c) => c === 400).length).toBeGreaterThan(0)
  })
})

describe('bounded inflation and detection', () => {
  it('stops a zstd bomb and a gzip bomb (B1)', async () => {
    const zeros = Buffer.alloc(50 * 1024 * 1024)
    for (const kind of ['zstd', 'gzip'] as const) {
      const compressed = await all(
        Readable.from([zeros]).pipe(kind === 'zstd' ? zstdCompress() : createGzip()),
      )
      await expect(
        pipeline(
          Readable.from([compressed]),
          boundedInflate(kind, compressed.length, 1024 * 1024 * 1024),
          async function (src: AsyncIterable<Buffer>) {
            for await (const chunk of src) void chunk
          },
        ),
        kind,
      ).rejects.toMatchObject({ details: { reason: 'inflate' } })
    }
  })

  it('detects containers by magic bytes', () => {
    const archive = Buffer.alloc(4)
    archive.writeUInt32LE(0x8199e26d)
    expect(detectContainer(archive)).toBe('archive')
    expect(detectContainer(Buffer.from([0x1f, 0x8b, 8, 0]))).toBe('gzip')
    expect(detectContainer(Buffer.concat([MMBAK_MAGIC, Buffer.alloc(4)]))).toBe('mmbak')
    expect(detectContainer(Buffer.from('PK\u0003\u0004'))).toBe('zip')
    expect(detectContainer(Buffer.from('{"a":1}'))).toBeNull()
  })
})
