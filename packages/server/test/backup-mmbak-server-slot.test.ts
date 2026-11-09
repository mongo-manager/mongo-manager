// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  MMBAK_MAGIC,
  decryptMmbak,
  encryptMmbak,
  mmbakKdfRuns,
  readMmbakHeader,
  slotsOf,
  type OpenedSlot,
} from '../src/backup/mmbak'
import { backupKeyFingerprint } from '../src/backup/keys/kit'

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
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const key = randomBytes(32)
const keyId = randomUUID()
const encrypt = (plain: Buffer, opts: { password?: string; serverKey?: { keyId: string; key: Buffer } }) =>
  all(encryptMmbak(from(plain), { ...opts, chunkBytes: 1024, tool, now: 1 }))
const open = (file: Buffer, opts: Parameters<typeof decryptMmbak>[1]) => all(decryptMmbak(from(file), opts))
/** The file with its header edited; the chunks are kept as they were. */
function forge(file: Buffer, edit: (json: { keySlots: Array<Record<string, unknown>> }) => void): Buffer {
  const at = (readMmbakHeader(file) as { bytes: number }).bytes
  const json = JSON.parse(file.subarray(12, at).toString('utf8'))
  edit(json)
  const body = Buffer.from(JSON.stringify(json))
  return Buffer.concat([MMBAK_MAGIC, u32(body.length), body, file.subarray(at)])
}
const damaged = { details: { reason: 'mmbak' } }

describe('.mmbak server key slots (phase 3d-3c spec §2, plan ruling 8)', () => {
  it('writes exactly one server slot and no password slot, and opens with the key without a KDF', async () => {
    const plain = randomBytes(5000)
    const file = await encrypt(plain, { serverKey: { keyId, key } })
    const parsed = readMmbakHeader(file)
    if (parsed === 'more') throw new Error('the header is incomplete')
    expect(parsed.header.keySlots).toEqual([
      expect.objectContaining({ type: 'server', keyId, fingerprint: backupKeyFingerprint(key) }),
    ])
    expect(slotsOf(parsed.header)).toEqual({
      password: false,
      server: { keyId, fingerprint: backupKeyFingerprint(key) },
    })
    expect(file.toString('latin1')).not.toContain(key.toString('base64'))
    const before = mmbakKdfRuns()
    const seen: OpenedSlot[] = []
    expect(await open(file, { serverKey: { key, keyId }, onOpened: (h) => seen.push(h) })).toEqual(plain)
    expect(await open(file, { serverKey: { key }, onOpened: (h) => seen.push(h) })).toEqual(plain)
    expect(mmbakKdfRuns()).toBe(before)
    expect(seen).toEqual([
      { kind: 'key', keyId, fingerprint: backupKeyFingerprint(key) },
      { kind: 'kit', fingerprint: backupKeyFingerprint(key) },
    ])
  })

  it('refuses another key and a password, and says what opens it (D3)', async () => {
    const file = await encrypt(Buffer.from('x'), { serverKey: { keyId, key } })
    await expect(open(file, { serverKey: { key: randomBytes(32) } })).rejects.toMatchObject({
      details: { reason: 'backup_key' },
    })
    await expect(open(file, { serverKey: { key, keyId: randomUUID() } })).rejects.toMatchObject({
      details: { reason: 'backup_key' },
    })
    await expect(open(file, { password: PW })).rejects.toMatchObject({
      details: { reason: 'backup_key_needed' },
    })
    await expect(open(file, {})).rejects.toMatchObject({ details: { reason: 'backup_key_needed' } })
    const withPassword = await encrypt(Buffer.from('x'), { password: PW })
    await expect(open(withPassword, { serverKey: { key } })).rejects.toMatchObject({
      details: { reason: 'backup_key' },
    })
  })

  it('opens a file with both slots by either, the key without running the KDF', async () => {
    const plain = randomBytes(3000)
    const file = await encrypt(plain, { password: PW, serverKey: { keyId, key } })
    const before = mmbakKdfRuns()
    expect(await open(file, { serverKey: { key, keyId } })).toEqual(plain)
    expect(mmbakKdfRuns()).toBe(before)
    expect(await open(file, { password: PW })).toEqual(plain)
  })

  it('refuses crafted headers before any key is tried (D7)', async () => {
    const file = await encrypt(Buffer.from('x'), { serverKey: { keyId, key } })
    const twoSlots = forge(file, (j) => j.keySlots.push({ ...j.keySlots[0]! }))
    expect(() => readMmbakHeader(twoSlots)).toThrow(/more than one backup-key slot/)
    await expect(open(twoSlots, { serverKey: { key, keyId } })).rejects.toMatchObject(damaged)
    const unknownOnly = forge(file, (j) => (j.keySlots = [{ type: 'hsm', id: 'x' }]))
    expect(() => readMmbakHeader(unknownOnly)).toThrow(/no key slot/)
    await expect(open(unknownOnly, { serverKey: { key } })).rejects.toMatchObject(damaged)
    await expect(
      open(
        forge(file, (j) => (j.keySlots[0]!.fingerprint = 'K-zz')),
        { serverKey: { key } },
      ),
    ).rejects.toMatchObject(damaged)
    // A fingerprint that lies about the caller's own key, chosen by its id.
    await expect(
      open(
        forge(file, (j) => (j.keySlots[0]!.fingerprint = 'K-00000000')),
        { serverKey: { key, keyId } },
      ),
    ).rejects.toMatchObject(damaged)
  })

  it('binds the slot to its key id and its position (D3)', async () => {
    const file = await encrypt(Buffer.from('x'), { serverKey: { keyId, key } })
    const other = randomUUID()
    await expect(
      open(
        forge(file, (j) => (j.keySlots[0]!.keyId = other)),
        { serverKey: { key, keyId: other } },
      ),
    ).rejects.toMatchObject(damaged)
    await expect(
      open(
        forge(file, (j) => j.keySlots.unshift({ type: 'hsm' })),
        { serverKey: { key, keyId } },
      ),
    ).rejects.toMatchObject(damaged)
    await expect(
      open(
        forge(file, (j) => (j.keySlots[0]!.wrapped = Buffer.alloc(32, 1).toString('base64'))),
        { serverKey: { key } },
      ),
    ).rejects.toMatchObject(damaged)
  })
})
