import { createWriteStream } from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable, pipeline as pipe, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  MAX_KIT_TEXT,
  boundedInflate,
  decryptMmbak,
  detectContainer,
  parseKit,
  readArchive,
  readDirectoryZip,
  readMmbakHeader,
  slotsOf,
} from '@mongo-manager/server'
import { UsageError, type Values } from '../args'
import type { Io } from '../io'
import { readSecret, readStdinSecret } from '../prompt'

/** Never from the command line (it would sit in the shell history and the process list). */
async function password(io: Io, values: Values): Promise<string> {
  if (values['password-stdin']) {
    if (io.stdin.isTTY)
      throw new UsageError(
        '--password-stdin reads from a pipe; on a terminal, leave it out to be asked without echo',
      )
    return readStdinSecret(io)
  }
  if (!io.stdin.isTTY)
    throw new UsageError('No terminal to read a password from: pipe it in with --password-stdin')
  return readSecret(io, 'Backup password: ')
}

/** Phase 3d-3c: usage is checked before any file is read (a key never comes on the command line). */
function keyUsage(values: Values): void {
  if (values.key !== undefined && values.key !== '-')
    throw new UsageError(
      'A key is never given on the command line: use --key - (stdin) or --key-file <kit.txt>',
    )
  if (values.key !== undefined && values['key-file'])
    throw new UsageError('Use --key - or --key-file, not both')
  if ((values.key !== undefined || values['key-file']) && values['password-stdin'])
    throw new UsageError('Give the kit or the password, not both')
}

/** The kit's key, from its file or stdin (bounded), or null when none was given. */
async function kitKey(io: Io, values: Values): Promise<Buffer | null> {
  if (values.key === '-') {
    if (io.stdin.isTTY) throw new UsageError('--key - reads the recovery kit from a pipe')
    let text = ''
    for await (const chunk of io.stdin) {
      text += chunk.toString()
      if (text.length > MAX_KIT_TEXT) throw new Error('This is too large to be a recovery kit')
    }
    return parseKit(text)
  }
  if (values['key-file']) {
    // One handle: its size and its text are the same file's (CodeQL 2026-11-01).
    const h = await open(resolve(io.cwd, values['key-file']), 'r')
    try {
      if ((await h.stat()).size > MAX_KIT_TEXT) throw new Error('This file is too large to be a recovery kit')
      const buf = Buffer.alloc(MAX_KIT_TEXT + 1)
      const { bytesRead } = await h.read(buf, 0, buf.length, 0)
      if (bytesRead > MAX_KIT_TEXT) throw new Error('This file is too large to be a recovery kit')
      return parseKit(buf.subarray(0, bytesRead).toString('utf8'))
    } finally {
      await h.close()
    }
  }
  return null
}

/** The clear header of an .mmbak file (at most 12 + 64 KiB). */
async function mmbakHeader(h: FileHandle) {
  const buf = Buffer.alloc(12 + 64 * 1024)
  const { bytesRead } = await h.read(buf, 0, buf.length, 0)
  const parsed = readMmbakHeader(buf.subarray(0, bytesRead))
  if (parsed === 'more') throw new Error('The encrypted backup is damaged: its header is incomplete')
  return parsed.header
}

/** Final review minor 1: errors travel through (a plain pipe() would leave the reader waiting). */
const through = (src: AsyncIterable<Buffer>, t: Transform): AsyncIterable<Buffer> =>
  pipe(Readable.from(src), t, () => undefined) as unknown as AsyncIterable<Buffer>

async function head(h: FileHandle): Promise<Buffer> {
  const buf = Buffer.alloc(16)
  const { bytesRead } = await h.read(buf, 0, 16, 0)
  return buf.subarray(0, bytesRead)
}

/** The file's contents from the start, through the handle (left open: its owner closes it). */
const contents = (h: FileHandle) =>
  h.createReadStream({ start: 0, autoClose: false }) as AsyncIterable<Buffer>

/** Phase 3d-3a spec §10: inspect any backup file; decrypt an .mmbak into a plain mongodump archive. */
export async function backupCommand(positionals: string[], values: Values, io: Io): Promise<number> {
  const [sub, file] = positionals
  if ((sub !== 'inspect' && sub !== 'decrypt') || !file)
    throw new UsageError('Use "backup inspect <file>" or "backup decrypt <file.mmbak> -o <file.archive>"')
  keyUsage(values)
  // CodeQL 2026-11-01 (file-system-race): opened once; every read below is of this very file.
  const h = await open(file, 'r')
  try {
    return await backupOf(h, sub, values, io)
  } finally {
    await h.close()
  }
}

async function backupOf(h: FileHandle, sub: string, values: Values, io: Io): Promise<number> {
  const size = (await h.stat()).size
  const container = detectContainer(await head(h))
  if (!container) throw new Error('This is not a backup file Mongo Manager can read')
  // Final review minor 10: a kit opens only an .mmbak; it is never silently left unused.
  if (container !== 'mmbak' && (values.key !== undefined || values['key-file']))
    throw new UsageError('Only an encrypted backup (.mmbak) opens with a recovery kit')
  if (sub === 'decrypt') {
    if (container !== 'mmbak') throw new Error('Only an encrypted backup (.mmbak) needs decrypting')
    if (!values.out) throw new UsageError('decrypt needs -o <file.archive>')
    // Final review minor 10: the file's slots say which opener it takes, before anything is asked.
    const slots = slotsOf(await mmbakHeader(h))
    const kitGiven = values.key !== undefined || Boolean(values['key-file'])
    if (!kitGiven && !slots.password)
      throw new UsageError(
        `This backup opens with its backup key ${slots.server?.fingerprint ?? ''}: give its recovery kit with --key-file <kit.txt> (or --key - from stdin)`,
      )
    if (kitGiven && !slots.server)
      throw new UsageError('This backup has no backup-key slot: open it with its password instead')
    // Phase 3d-3c: a backup-key file opens with its recovery kit; any other with its password.
    const kit = await kitKey(io, values)
    const opener = kit ? { serverKey: { key: kit } } : { password: await password(io, values) }
    // A new private file only: an existing one is never overwritten.
    const out = createWriteStream(values.out, { flags: 'wx', mode: 0o600 })
    try {
      await pipeline(
        Readable.from(decryptMmbak(contents(h), opener)),
        boundedInflate('zstd', size, Number.MAX_SAFE_INTEGER),
        out,
      )
    } catch (e) {
      // A wrong password or a damaged file leaves nothing half-written behind.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') await rm(values.out, { force: true })
      throw e
    } finally {
      kit?.fill(0)
    }
    io.stdout.write(`Wrote ${values.out}\n`)
    return 0
  }
  let events: AsyncGenerator<import('@mongo-manager/server').ArchiveEvent>
  if (container === 'zip') {
    events = readDirectoryZip(h, size)
    await list(io, 'directory (zip)', events)
    return 0
  }
  let opener: { serverKey: { key: Buffer } } | { password: string } | null = null
  let kit: Buffer | null = null
  if (container === 'mmbak') {
    // Phase 3d-3c spec §2: the slots and their fingerprints, then the contents when the file can be opened.
    const slots = slotsOf(await mmbakHeader(h))
    const kinds = [
      slots.password ? 'password' : null,
      slots.server ? `backup key ${slots.server.fingerprint}` : null,
    ]
    io.stdout.write(`Format: mmbak\nKey slots: ${kinds.filter(Boolean).join(', ')}\n`)
    kit = await kitKey(io, values)
    if (!kit && !slots.password) {
      io.stdout.write(
        'To list its contents, give its recovery kit: --key-file <kit.txt> (or --key - from stdin)\n',
      )
      return 0
    }
    opener = kit ? { serverKey: { key: kit } } : { password: await password(io, values) }
  }
  const raw = contents(h)
  const bytes: AsyncIterable<Buffer> =
    container === 'archive'
      ? raw
      : container === 'gzip'
        ? through(raw, boundedInflate('gzip', size, Number.MAX_SAFE_INTEGER))
        : through(decryptMmbak(raw, opener!), boundedInflate('zstd', size, Number.MAX_SAFE_INTEGER))
  try {
    await list(io, container === 'mmbak' ? null : container, readArchive(bytes))
  } finally {
    // Final review minor 10: the kit's key is wiped here too, as decrypt does.
    kit?.fill(0)
  }
  return 0
}

async function list(
  io: Io,
  format: string | null,
  events: AsyncGenerator<import('@mongo-manager/server').ArchiveEvent>,
): Promise<void> {
  if (format) io.stdout.write(`Format: ${format}\n`)
  try {
    for await (const e of events) {
      if (e.kind === 'header')
        io.stdout.write(
          `Server: ${e.serverVersion ?? '?'}  Tool: ${e.toolVersion ?? '?'}${e.mongoManager?.masked ? '  (masked)' : ''}\n`,
        )
      else if (e.kind === 'meta')
        io.stdout.write(`  ${e.meta.db}.${e.meta.coll}  ${e.meta.type}  ${e.meta.indexes.length} indexes\n`)
      else if (e.kind === 'prelude-end') break
    }
  } finally {
    await events.return(undefined)
  }
}
