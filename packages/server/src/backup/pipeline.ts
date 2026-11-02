import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { createGzip } from 'node:zlib'
import { PassThrough, Readable, Transform, pipeline as pipe, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ArchiveSummary, BackupFormat } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { BackupFileRow, BackupStore } from './store'
import { ArchiveWriter } from './archive-writer'
import { readArchive, type ArchiveEvent } from './archive-reader'
import { readDirectoryZip } from './dir-zip-reader'
import type { OpenedWith } from '@mongo-manager/shared'
import { decryptMmbak, encryptMmbak, readMmbakHeader, slotsOf, type MmbakHeader } from './mmbak'
import type { SlotKeys } from './keys/slot-keys'
import { boundedInflate, zstdCompress } from './inflate'
import { detectContainer } from './detect'

/** A growing upload has not yet sent what the reader needs (an inspection answers "waiting"). */
export class MoreNeeded extends Error {}
/** An encrypted backup was opened without a password (an inspection answers "password"). */
export class PasswordNeeded extends Error {}

/** Phase 3d-3c: a backup-key file none of the caller's keys opens (an inspection answers "key"). */
export class KeyNeeded extends Error {
  constructor(
    readonly fingerprint: string,
    readonly password: boolean,
  ) {
    super('A backup key is needed')
  }
}

/** The clear header of an .mmbak (at most 12 + 64 KiB), following a growing upload as `opts` says. */
async function mmbakHeaderOf(
  store: BackupStore,
  row: BackupFileRow,
  opts: { follow: Follow; signal: AbortSignal },
): Promise<MmbakHeader> {
  let buf = Buffer.alloc(0)
  for await (const part of fileBytes(store, row, opts)) {
    buf = Buffer.concat([buf, part])
    const h = readMmbakHeader(buf)
    if (h !== 'more') return h.header
    if (buf.length > 12 + 64 * 1024) break
  }
  const h = readMmbakHeader(buf)
  if (h === 'more')
    throw Errors.badFile('The encrypted backup is damaged or was changed: it ends too early', {
      reason: 'mmbak',
    })
  return h.header
}

const READ = 1024 * 1024
/** No backup decompresses past this, whatever its ratio (16 TiB). */
const ABSOLUTE_MAX = 16 * 1024 ** 4
export type Follow = 'complete' | 'wait' | 'idle'

/**
 * A stored file's bytes from `from`. `wait` follows a growing upload until it completes; `idle`
 * throws MoreNeeded as soon as it would wait; `complete` reads what is there.
 */
export async function* fileBytes(
  store: BackupStore,
  row: BackupFileRow,
  opts: { from?: number; follow: Follow; signal: AbortSignal; waitMs?: number },
): AsyncGenerator<Buffer> {
  // An upload that has received nothing has no file yet.
  for (;;) {
    const now = store.byId(row.id)
    if (!now) throw Errors.notFound('File not found')
    if (now.size > 0 || now.complete || opts.follow === 'complete') break
    if (opts.follow === 'idle') throw new MoreNeeded()
    await store.waitForGrowth(row.id, opts.signal, opts.waitMs ?? 30_000)
    if (opts.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
  }
  const handle = await store.openRead(row)
  let at = opts.from ?? 0
  // Final review I1: never past the recorded size — bytes beyond it were never accepted.
  const recorded = () => {
    const now = store.byId(row.id)
    if (!now) throw Errors.notFound('File not found')
    return now
  }
  let limit = recorded().size
  try {
    for (;;) {
      if (opts.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
      if (at < limit) {
        const want = Math.min(READ, limit - at)
        const buf = Buffer.alloc(want)
        const { bytesRead } = await handle.read(buf, 0, want, at)
        if (bytesRead === 0)
          throw Errors.badFile('The stored file is shorter than recorded', { reason: 'file' })
        at += bytesRead
        yield buf.subarray(0, bytesRead)
        continue
      }
      // Final review minor 5: a complete file is read to its end without asking for its row again.
      if (opts.follow === 'complete') return
      const now = recorded()
      if (now.size > limit) {
        limit = now.size
        continue
      }
      if (now.complete) return
      if (opts.follow === 'idle') throw new MoreNeeded()
      await store.waitForGrowth(row.id, opts.signal, opts.waitMs ?? 30_000)
      limit = recorded().size
    }
  } finally {
    await handle.close()
  }
}

/** A transform over an async source; errors and early ends travel both ways. */
function through(src: AsyncIterable<Buffer>, t: Transform): AsyncIterable<Buffer> {
  return pipe(Readable.from(src), t, () => undefined) as unknown as AsyncIterable<Buffer>
}

async function head(
  store: BackupStore,
  row: BackupFileRow,
  opts: { follow: Follow; signal: AbortSignal },
): Promise<Buffer> {
  const parts: Buffer[] = []
  let n = 0
  for await (const p of fileBytes(store, row, opts)) {
    parts.push(p)
    n += p.length
    if (n >= 16) break
  }
  return Buffer.concat(parts)
}

/** Spec §3.2: detection by magic bytes, then decryption or decompression, then archive events. */
export async function openArchive(
  store: BackupStore,
  row: BackupFileRow,
  opts: {
    password?: string
    signal: AbortSignal
    follow: Follow
    onWrongPassword?: () => void
    /** Phase 3d-3c: the caller's own backup keys and a request's kit, for a server slot. */
    keys?: SlotKeys
    /** Phase 3d-3c: told how an encrypted file opened (once its key slot verified). */
    onOpened?: (how: OpenedWith) => void
    /** Bytes of the stored file read so far: a job's progress, whatever the compression. */
    onFileBytes?: (n: number) => void
  },
): Promise<{ container: ArchiveSummary['container']; events: AsyncGenerator<ArchiveEvent> }> {
  const first = await head(store, row, opts)
  const current = store.byId(row.id) ?? row
  if (
    first.length < 16 &&
    !current.complete &&
    opts.follow === 'idle' &&
    first.length < (current.declaredSize ?? 0)
  )
    throw new MoreNeeded()
  const container = detectContainer(first)
  if (!container)
    throw Errors.badFile('This is not a backup file Mongo Manager can read', { reason: 'not_backup' })
  const declared = current.declaredSize ?? current.size
  const bytes = async function* () {
    for await (const chunk of fileBytes(store, row, opts)) {
      opts.onFileBytes?.(chunk.length)
      yield chunk
    }
  }
  if (container === 'zip') {
    if (!current.complete && current.kind === 'upload') {
      if (opts.follow === 'idle') throw new MoreNeeded()
      throw Errors.conflict('The upload is not complete', { reason: 'upload_incomplete' })
    }
    const handle = await store.openRead(current)
    const events = (async function* () {
      try {
        yield* readDirectoryZip(handle, current.size)
      } finally {
        await handle.close()
      }
    })()
    return { container: 'directory', events }
  }
  if (container === 'archive') return { container, events: readArchive(bytes()) }
  if (container === 'gzip')
    return {
      container,
      events: readArchive(through(bytes(), boundedInflate('gzip', declared, ABSOLUTE_MAX))),
    }
  // Phase 3d-3c spec §1.1: the caller's own key for a server slot first (by its id only, D3), then a
  // kit given with the request, then the password; with none of them, say what the file takes.
  const header = await mmbakHeaderOf(store, row, opts)
  const slots = slotsOf(header)
  let given: { key: Buffer; keyId?: string } | null = null
  let opened: OpenedWith | null = null
  let own: Buffer | null = null
  if (slots.server && opts.keys) {
    const mine = opts.keys.own(slots.server.keyId)
    if (mine) {
      own = mine.key
      given = { key: mine.key, keyId: slots.server.keyId }
      opened = { kind: 'key', fingerprint: slots.server.fingerprint, name: mine.name }
    } else if (opts.keys.kit) {
      given = { key: opts.keys.kit }
      opened = { kind: 'kit', fingerprint: slots.server.fingerprint }
    }
  }
  if (!given) {
    if (opts.password !== undefined && slots.password) opened = { kind: 'password' }
    else if (slots.server) throw new KeyNeeded(slots.server.fingerprint, slots.password)
    else if (opts.password === undefined) throw new PasswordNeeded()
  }
  const plain = decryptMmbak(bytes(), {
    ...(given ? { serverKey: given } : { password: opts.password! }),
    ...(opts.onWrongPassword ? { onWrongPassword: opts.onWrongPassword } : {}),
    onOpened: () => {
      if (opened) opts.onOpened?.(opened)
    },
  })
  const events = readArchive(through(plain, boundedInflate('zstd', declared, ABSOLUTE_MAX)))
  if (!own) return { container, events }
  // The caller's own key, opened for this read only, is wiped when the read ends.
  const key = own
  return {
    container,
    events: (async function* () {
      try {
        yield* events
      } finally {
        key.fill(0)
      }
    })(),
  }
}

/** The prelude as a summary; the events are closed at `prelude-end`. */
export async function summarize(
  container: ArchiveSummary['container'],
  events: AsyncGenerator<ArchiveEvent>,
): Promise<ArchiveSummary> {
  const out: ArchiveSummary = {
    container,
    serverVersion: null,
    toolVersion: null,
    mongoManager: null,
    namespaces: [],
  }
  try {
    for await (const e of events) {
      if (e.kind === 'header') {
        out.serverVersion = e.serverVersion
        out.toolVersion = e.toolVersion
        out.mongoManager = e.mongoManager
      } else if (e.kind === 'meta') {
        const m = e.meta
        out.namespaces.push({
          db: m.db,
          coll: m.coll,
          type: m.type,
          indexes: m.indexes.length,
          ttl: m.indexes.filter((i) => i.expireAfterSeconds !== undefined).map((i) => String(i.name)),
          capped: m.options.capped === true,
          ...(typeof m.options.viewOn === 'string' ? { viewOn: m.options.viewOn } : {}),
        })
      } else if (e.kind === 'prelude-end') break
    }
  } finally {
    await events.return(undefined)
  }
  return out
}

/** Hashes and counts what passes; an error `onBytes` throws (a full quota) ends the stream. */
function counter(onBytes: (total: number) => void, hash: ReturnType<typeof createHash>): Transform {
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length
      hash.update(chunk)
      try {
        onBytes(total)
      } catch (e) {
        done(e as Error)
        return
      }
      done(null, chunk)
    },
  })
}

/**
 * Spec §7.1: archive bytes in (from the writer, or the tools engine's stdout through `input`), the
 * chosen container out to `path`, with its size and SHA-256.
 */
export function createDumpSink(opts: {
  path: string
  format: BackupFormat
  password?: string
  /** Phase 3d-3c: the owner's backup key, for a scheduled .mmbak's server slot. */
  serverKey?: { keyId: string; key: Buffer }
  chunkBytes: number
  tool: { name: string; version: string }
  now: number
  onBytes: (total: number) => void
}): {
  writer: ArchiveWriter
  input: PassThrough
  done(): Promise<{ size: number; sha256: string }>
  abort(e: Error): void
} {
  const input = new PassThrough()
  const hash = createHash('sha256')
  let size = 0
  const count = counter((t) => {
    size = t
    opts.onBytes(t)
  }, hash)
  const file: Writable = createWriteStream(opts.path, { flags: 'wx', mode: 0o600 })
  const finished =
    opts.format === 'archive'
      ? pipeline(input, count, file)
      : opts.format === 'gzip'
        ? pipeline(input, createGzip({ level: 6 }), count, file)
        : pipeline(
            input,
            zstdCompress(),
            async function* (src: AsyncIterable<Buffer>) {
              yield* encryptMmbak(src, {
                ...(opts.password !== undefined ? { password: opts.password } : {}),
                ...(opts.serverKey ? { serverKey: opts.serverKey } : {}),
                chunkBytes: opts.chunkBytes,
                tool: opts.tool,
                now: opts.now,
              })
            },
            count,
            file,
          )
  // A failure surfaces through done(); never as an unhandled rejection meanwhile.
  finished.catch(() => undefined)
  return {
    writer: new ArchiveWriter(input),
    input,
    async done() {
      input.end()
      await finished
      return { size, sha256: hash.digest('hex') }
    },
    abort(e) {
      input.destroy(e)
    },
  }
}
