// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
import { Errors } from '../errors'
import { stableJson } from '../transfer/copy-access'
import { ByteReader } from './bytes'
import { backupKeyFingerprint } from './keys/kit'
import { passwordId } from '../crypto/password-id'

export const MMBAK_MAGIC = Buffer.from([0x4d, 0x4d, 0x42, 0x41, 0x4b, 0x00, 0x0d, 0x0a])
const MAX_HEADER = 64 * 1024
const MIN_CHUNK = 1024
const MAX_CHUNK = 128 * 1024 * 1024
export const KDF_WRITE = { N: 2 ** 17, r: 8, p: 1 } as const
/** Final review I2: a file may ask for no more than what we write (3d-3b can widen this on purpose). */
const KDF_MAX = KDF_WRITE
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const b64 = (len: number) =>
  z.string().refine((s) => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && Buffer.from(s, 'base64').length === len)
const PasswordSlot = z.strictObject({
  type: z.literal('password'),
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: z
      .number()
      .int()
      .min(2 ** 14)
      .max(KDF_MAX.N)
      .refine((n) => (n & (n - 1)) === 0),
    r: z.number().int().min(1).max(KDF_MAX.r),
    p: z.number().int().min(1).max(KDF_MAX.p),
    salt: b64(16),
  }),
  iv: b64(12),
  wrapped: b64(32),
  tag: b64(16),
})
/** Phase 3d-3c spec §2 (plan ruling 8): a backup key's slot. */
const ServerSlot = z.strictObject({
  type: z.literal('server'),
  keyId: z.string().regex(UUID),
  fingerprint: z.string().regex(/^K-[0-9a-f]{8}$/),
  iv: b64(12),
  wrapped: b64(32),
  tag: b64(16),
})
type ServerSlotT = z.infer<typeof ServerSlot>
/** A reader skips slot types it does not know; a malformed known type is refused (never "unknown"). */
const OtherSlot = z
  .object({
    type: z
      .string()
      .max(32)
      .refine((t) => t !== 'password' && t !== 'server'),
  })
  .passthrough()
const HeaderSchema = z.strictObject({
  format: z.literal(1),
  cipher: z.literal('AES-256-GCM'),
  compression: z.literal('zstd'),
  chunkBytes: z.number().int().min(MIN_CHUNK).max(MAX_CHUNK),
  noncePrefix: b64(4),
  keySlots: z
    .array(z.union([PasswordSlot, ServerSlot, OtherSlot]))
    .min(1)
    .max(8),
  createdAt: z.number().int().min(0),
  tool: z.strictObject({ name: z.string().max(100), version: z.string().max(100) }),
})
export type MmbakHeader = z.infer<typeof HeaderSchema>

const damaged = (what: string) =>
  Errors.badFile(`The encrypted backup is damaged or was changed: ${what}`, { reason: 'mmbak' })
const wrongPassword = () =>
  Errors.validation('The password is wrong, or the file is damaged', { reason: 'backup_password' })
const wrongKey = (message: string) => Errors.validation(message, { reason: 'backup_key' })
const keyNeeded = () =>
  Errors.validation('This backup opens with a backup key or its recovery kit', {
    reason: 'backup_key_needed',
  })

/** How a file was opened (phase 3d-3c spec §5: "Opened with your backup key K-…"). */
export type OpenedSlot =
  | { kind: 'password' }
  | { kind: 'key'; keyId: string; fingerprint: string }
  | { kind: 'kit'; fingerprint: string }

/**
 * Final review I2: scrypt costs about 170 ms and 128 MiB. At most two run at once in the server and
 * a few wait; more are refused (429), so files or requests cannot stall the thread pool.
 */
const KDF_RUNNING = 2
const KDF_QUEUE = 8
let kdfRunning = 0
let kdfRuns = 0
const kdfWaiting: Array<() => void> = []
const kdfWatchers = new Set<(running: number) => void>()
/** For tests and metrics: how many key derivations ran. */
export const mmbakKdfRuns = (): number => kdfRuns
/** For tests: told how many derivations run, at each change. */
export function watchKdf(watcher: (running: number) => void): () => void {
  kdfWatchers.add(watcher)
  return () => kdfWatchers.delete(watcher)
}
const kdfChanged = () => {
  for (const w of kdfWatchers) w(kdfRunning)
}
async function kdfSlot(): Promise<() => void> {
  if (kdfRunning >= KDF_RUNNING) {
    if (kdfWaiting.length >= KDF_QUEUE) throw Errors.rateLimited(2_000)
    await new Promise<void>((resolve) => kdfWaiting.push(resolve))
  }
  kdfRunning++
  kdfChanged()
  let freed = false
  return () => {
    if (freed) return
    freed = true
    kdfRunning--
    kdfChanged()
    kdfWaiting.shift()?.()
  }
}

/**
 * Final review I2: an opened file's data key, for a few minutes, so polls, plans, the start and the
 * job derive it once. Keyed by the header's hash and a password hash of the password (passwordId:
 * scrypt under a secret that lives only in this process): nothing here helps an offline guess.
 * Wrong passwords are never kept.
 */
const KEY_TTL_MS = 10 * 60_000
const KEY_CACHE_MAX = 32
const keyCache = new Map<string, { key: Buffer; until: number }>()
const cacheId = async (headerHash: Buffer, password: string): Promise<string> =>
  `${headerHash.toString('hex')}:${await passwordId(password.normalize('NFC'))}`
function cachedKey(id: string): Buffer | null {
  const hit = keyCache.get(id)
  if (!hit) return null
  if (hit.until < Date.now()) {
    hit.key.fill(0)
    keyCache.delete(id)
    return null
  }
  return Buffer.from(hit.key)
}
function keepKey(id: string, key: Buffer): void {
  if (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value
    if (oldest !== undefined) {
      keyCache.get(oldest)?.key.fill(0)
      keyCache.delete(oldest)
    }
  }
  keyCache.set(id, { key: Buffer.from(key), until: Date.now() + KEY_TTL_MS })
}

async function kek(
  password: string,
  kdf: { N: number; r: number; p: number; salt: string },
): Promise<Buffer> {
  const release = await kdfSlot()
  try {
    kdfRuns++
    return await scryptKey(password, kdf)
  } finally {
    release()
  }
}
function scryptKey(
  password: string,
  kdf: { N: number; r: number; p: number; salt: string },
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize('NFC'),
      Buffer.from(kdf.salt, 'base64'),
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  )
}
const slotAad = (index: number, salt: string) =>
  Buffer.concat([Buffer.from('mmbak-key-v1'), Buffer.from([index]), Buffer.from(salt, 'base64')])
/** Phase 3d-3c spec §2: a server slot is bound to its position and its key id. */
const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex')
const serverAad = (index: number, keyId: string) =>
  Buffer.concat([Buffer.from('mmbak-key-v1'), Buffer.from([index]), uuidBytes(keyId)])
const serverWrapKey = (key: Buffer, keyId: string) =>
  Buffer.from(hkdfSync('sha256', key, uuidBytes(keyId), 'mmbak-server-slot-v1', 32))
const chunkAad = (headerHash: Buffer, index: bigint, final: boolean) => {
  const b = Buffer.alloc(9)
  b.writeBigUInt64BE(index)
  b[8] = final ? 1 : 0
  return Buffer.concat([headerHash, b])
}
const nonce = (prefix: Buffer, index: bigint) => {
  const b = Buffer.alloc(12)
  prefix.copy(b, 0)
  b.writeBigUInt64BE(index, 4)
  return b
}

/** The clear header of an .mmbak, or 'more' while fewer bytes than it needs are at hand. */
export function readMmbakHeader(head: Buffer): { header: MmbakHeader; bytes: number } | 'more' {
  if (head.length < 12) return 'more'
  if (!head.subarray(0, 8).equals(MMBAK_MAGIC)) throw damaged('magic')
  const len = head.readUInt32LE(8)
  if (len < 2 || len > MAX_HEADER) throw damaged('header length')
  if (head.length < 12 + len) return 'more'
  let parsed: unknown
  try {
    parsed = JSON.parse(head.subarray(12, 12 + len).toString('utf8'))
  } catch {
    throw damaged('header')
  }
  const h = HeaderSchema.safeParse(parsed)
  if (!h.success) throw damaged('header fields')
  // Final review I2 and phase 3d-3c D7: one slot of a kind at most, decided before any key is tried.
  const count = (type: string) => h.data.keySlots.filter((s) => s.type === type).length
  if (count('password') > 1) throw damaged('more than one password slot')
  if (count('server') > 1) throw damaged('more than one backup-key slot')
  if (!count('password') && !count('server')) throw damaged('no key slot this version can open')
  return { header: h.data, bytes: 12 + len }
}

/** Phase 3d-3c: what a header can be opened with, to ask for the right thing before reading on. */
export function slotsOf(header: MmbakHeader): {
  password: boolean
  server: { keyId: string; fingerprint: string } | null
} {
  const server = header.keySlots.find((s) => s.type === 'server') as ServerSlotT | undefined
  return {
    password: header.keySlots.some((s) => s.type === 'password'),
    server: server ? { keyId: server.keyId, fingerprint: server.fingerprint } : null,
  }
}

/**
 * Spec §4.3 (3d-3a) and §2 (3d-3c): zstd output in, .mmbak out. A random data key per file, wrapped
 * by a password slot, a backup key's server slot, or both (a password slot first); chunks of
 * `chunkBytes` sealed with AES-256-GCM, bound to the header, their index and the final flag.
 */
export async function* encryptMmbak(
  src: AsyncIterable<Buffer>,
  opts: {
    password?: string
    serverKey?: { keyId: string; key: Buffer }
    chunkBytes: number
    tool: { name: string; version: string }
    now: number
  },
): AsyncGenerator<Buffer> {
  if (opts.password === undefined && !opts.serverKey)
    throw new Error('An encrypted backup needs a password or a backup key')
  const dataKey = randomBytes(32)
  const keySlots: MmbakHeader['keySlots'] = []
  try {
    if (opts.password !== undefined) {
      const salt = randomBytes(16).toString('base64')
      const kdf = { name: 'scrypt' as const, ...KDF_WRITE, salt }
      // Writing derives once per backup (bounded by the backup jobs), outside the guessing limit.
      const wrapKey = await scryptKey(opts.password, kdf)
      const iv = randomBytes(12)
      const wrap = createCipheriv('aes-256-gcm', wrapKey, iv)
      wrap.setAAD(slotAad(keySlots.length, salt))
      const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final()])
      wrapKey.fill(0)
      keySlots.push({
        type: 'password',
        kdf,
        iv: iv.toString('base64'),
        wrapped: wrapped.toString('base64'),
        tag: wrap.getAuthTag().toString('base64'),
      })
    }
    if (opts.serverKey) {
      const { keyId, key } = opts.serverKey
      const wrapKey = serverWrapKey(key, keyId)
      const iv = randomBytes(12)
      const wrap = createCipheriv('aes-256-gcm', wrapKey, iv)
      wrap.setAAD(serverAad(keySlots.length, keyId))
      const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final()])
      wrapKey.fill(0)
      keySlots.push({
        type: 'server',
        keyId,
        fingerprint: backupKeyFingerprint(key),
        iv: iv.toString('base64'),
        wrapped: wrapped.toString('base64'),
        tag: wrap.getAuthTag().toString('base64'),
      })
    }
  } catch (e) {
    dataKey.fill(0)
    throw e
  }
  const header: MmbakHeader = {
    format: 1,
    cipher: 'AES-256-GCM',
    compression: 'zstd',
    chunkBytes: opts.chunkBytes,
    noncePrefix: randomBytes(4).toString('base64'),
    keySlots,
    createdAt: opts.now,
    tool: opts.tool,
  }
  const headerBytes = Buffer.from(stableJson(header))
  const headerHash = createHash('sha256').update(headerBytes).digest()
  const prefix = Buffer.from(header.noncePrefix, 'base64')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(headerBytes.length)
  yield Buffer.concat([MMBAK_MAGIC, len, headerBytes])
  let index = 0n
  const seal = (plain: Buffer, final: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', dataKey, nonce(prefix, index))
    c.setAAD(chunkAad(headerHash, index, final))
    const body = Buffer.concat([c.update(plain), c.final()])
    const l = Buffer.alloc(4)
    l.writeUInt32LE(body.length)
    index++
    return Buffer.concat([l, body, c.getAuthTag()])
  }
  try {
    // One full chunk is held back until we know whether more follows: the last one is marked final.
    let pending: Buffer[] = []
    let have = 0
    let held: Buffer | null = null
    for await (const part of src) {
      let p = part
      while (p.length) {
        const take = Math.min(p.length, opts.chunkBytes - have)
        pending.push(p.subarray(0, take))
        have += take
        p = p.subarray(take)
        if (have === opts.chunkBytes) {
          if (held) yield seal(held, false)
          held = Buffer.concat(pending)
          pending = []
          have = 0
        }
      }
    }
    if (have > 0) {
      if (held) yield seal(held, false)
      yield seal(Buffer.concat(pending), true)
    } else yield seal(held ?? Buffer.alloc(0), true)
  } finally {
    dataKey.fill(0)
  }
}

/**
 * Phase 3d-3c spec §2: a server slot opens with the given key only. The caller's own key comes with
 * its id (a slot naming another id is not tried; one whose fingerprint does not name that key lies,
 * D7); a kit's key is matched by fingerprint, and a key with the slot's fingerprint that fails the
 * tag means the slot was changed.
 */
function openServerSlot(raw: unknown, index: number, given: { key: Buffer; keyId?: string }): Buffer {
  const checked = ServerSlot.safeParse(raw)
  if (!checked.success) throw damaged('backup-key slot')
  const slot = checked.data
  if (given.keyId !== undefined && given.keyId !== slot.keyId)
    throw wrongKey('This backup was made with another backup key')
  const fingerprint = backupKeyFingerprint(given.key)
  if (fingerprint !== slot.fingerprint) {
    if (given.keyId !== undefined) throw damaged('the backup-key slot names another key')
    throw wrongKey(`This key (${fingerprint}) does not open this backup; it needs ${slot.fingerprint}`)
  }
  const wrapKey = serverWrapKey(given.key, slot.keyId)
  try {
    const d = createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(slot.iv, 'base64'))
    d.setAAD(serverAad(index, slot.keyId))
    d.setAuthTag(Buffer.from(slot.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(slot.wrapped, 'base64')), d.final()])
  } catch {
    throw damaged('the backup-key slot does not verify')
  } finally {
    wrapKey.fill(0)
  }
}

/** Spec §4.3, §8 B6: .mmbak in, zstd data out; a chunk is released only after its tag verifies. */
export async function* decryptMmbak(
  src: AsyncIterable<Buffer>,
  opts: {
    password?: string
    /** Phase 3d-3c: a backup key — the caller's own (with its id) or a recovery kit's (without). */
    serverKey?: { key: Buffer; keyId?: string }
    onWrongPassword?: () => void
    onOpened?: (how: OpenedSlot) => void
  },
): AsyncGenerator<Buffer> {
  const r = new ByteReader(src)
  const short = () => damaged('it ends too early')
  let dataKey: Buffer | null = null
  try {
    const fixed = await r.exactly(12, short)
    if (!fixed) throw short()
    const len = fixed.subarray(0, 8).equals(MMBAK_MAGIC) ? fixed.readUInt32LE(8) : -1
    if (len < 2 || len > MAX_HEADER) throw damaged('header')
    const body = await r.exactly(len, short)
    if (!body) throw short()
    const parsed = readMmbakHeader(Buffer.concat([fixed, body]))
    if (parsed === 'more') throw short()
    const { header } = parsed
    const headerHash = createHash('sha256').update(body).digest()
    const slots = header.keySlots.map((s, i) => ({ s, i }))
    if (opts.serverKey) {
      const at = slots.find(({ s }) => s.type === 'server')
      if (!at) throw wrongKey('This backup has no backup-key slot; open it with its password')
      dataKey = openServerSlot(at.s, at.i, opts.serverKey)
      const fingerprint = (at.s as ServerSlotT).fingerprint
      opts.onOpened?.(
        opts.serverKey.keyId !== undefined
          ? { kind: 'key', keyId: opts.serverKey.keyId, fingerprint }
          : { kind: 'kit', fingerprint },
      )
    } else if (opts.password !== undefined) {
      const at = slots.find(({ s }) => s.type === 'password')
      if (!at) throw keyNeeded()
      const id = await cacheId(headerHash, opts.password)
      dataKey = cachedKey(id)
      if (!dataKey) {
        const checked = PasswordSlot.safeParse(at.s)
        if (!checked.success) throw damaged('password slot')
        const slot = checked.data
        const kekKey = await kek(opts.password, slot.kdf)
        try {
          const d = createDecipheriv('aes-256-gcm', kekKey, Buffer.from(slot.iv, 'base64'))
          d.setAAD(slotAad(at.i, slot.kdf.salt))
          d.setAuthTag(Buffer.from(slot.tag, 'base64'))
          dataKey = Buffer.concat([d.update(Buffer.from(slot.wrapped, 'base64')), d.final()])
        } catch {
          dataKey = null
        } finally {
          kekKey.fill(0)
        }
        if (!dataKey) {
          opts.onWrongPassword?.()
          throw wrongPassword()
        }
        keepKey(id, dataKey)
      }
      opts.onOpened?.({ kind: 'password' })
    } else throw keyNeeded()
    const prefix = Buffer.from(header.noncePrefix, 'base64')
    let index = 0n
    for (;;) {
      const lb = await r.exactly(4, short)
      if (!lb) throw damaged('the final part is missing')
      const n = lb.readUInt32LE(0)
      if (n > header.chunkBytes) throw damaged('a part is larger than the header allows')
      const sealed = await r.exactly(n + 16, short)
      if (!sealed) throw short()
      const open = (final: boolean): Buffer | null => {
        try {
          const d = createDecipheriv('aes-256-gcm', dataKey!, nonce(prefix, index))
          d.setAAD(chunkAad(headerHash, index, final))
          d.setAuthTag(sealed.subarray(n))
          return Buffer.concat([d.update(sealed.subarray(0, n)), d.final()])
        } catch {
          return null
        }
      }
      const notFinal = open(false)
      if (notFinal) {
        index++
        yield notFinal
        continue
      }
      const final = open(true)
      if (!final) throw damaged(`part ${index} does not verify`)
      if (!(await r.atEnd())) throw damaged('bytes after the final part')
      yield final
      break
    }
  } finally {
    dataKey?.fill(0)
    await r.close()
  }
}
