// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { Writable } from 'node:stream'
import { PRIVATE_NOTICE, repairPrivate, repairPrivateLater } from '../store/datadir'

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024

const windows = process.platform === 'win32'
// Never follow a symlink planted at the log path (it would redirect or chmod another file); never
// wait on a pipe planted there (sixth review of the CI fixes: an O_WRONLY open of a FIFO blocks).
// Windows has neither flag: a link is refused after the open (see open below).
const FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NOFOLLOW ?? 0) |
  (windows ? 0 : (constants.O_NONBLOCK ?? 0))

/** What a refusal of the log file says to do (CI fixes, seventh and eighth reviews). */
const NAMED = '--log-file, MM_LOG_FILE or logFile in the config'
const FIX_LINK = `remove or rename it, or name another log file (${NAMED})`
const FIX_KIND = `name a regular file for the log (${NAMED}), or none, to log to the console`
const notRegular = (path: string) => `The log file ${path} is not a regular file: ${FIX_KIND}`

/** Why the file at `path` is no log file of the server's, or null (it is, or there is none yet). */
export function logFileProblem(path: string): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false })
  if (!st) return null
  if (st.isSymbolicLink()) return `The log file ${path} is a link: ${FIX_LINK}`
  if (!st.isFile()) return notRegular(path)
  if (st.nlink !== 1) return `The log file ${path} has other names (hard links): ${FIX_LINK}`
  return null
}

/**
 * Opens a log file, and takes it only when it is what it must be (CI fixes, sixth to eighth
 * reviews): a regular file with one name, the very file at the path — never a link, nor one swapped
 * in while it was opened — then private (0600) on POSIX. Checked before anything is created or
 * changed: Windows follows a junction or link even on an exclusive create (eighth review,
 * important 1), so the path itself is looked at first, a file there is opened without creating, and
 * only a path with nothing there is created, exclusively — which says whether it made the file.
 */
export function openChecked(path: string): { fd: number; size: number; made: boolean } {
  const before = logFileProblem(path)
  if (before) throw new Error(before)
  const create = () => openSync(path, FLAGS | constants.O_EXCL, 0o600)
  const existing = () => openSync(path, FLAGS & ~constants.O_CREAT, 0o600)
  /** An open's failure in the words of the log file's checks (ninth review, nit 5). */
  const said = (e: unknown): never => {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENXIO') throw new Error(notRegular(path), { cause: e })
    if (code === 'ELOOP') throw new Error(`The log file ${path} is a link: ${FIX_LINK}`, { cause: e })
    throw e
  }
  let made = !lstatSync(path, { throwIfNoEntry: false })
  let fd = -1
  try {
    fd = made ? create() : existing()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // Made, or removed, in between: once more the other way, its checks after the open.
    if (code === 'EEXIST' && made) made = false
    else if (code === 'ENOENT' && !made) made = true
    else said(e)
    try {
      fd = made ? create() : existing()
    } catch (again) {
      said(again)
    }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(notRegular(path))
    if (st.nlink !== 1) throw new Error(`The log file ${path} has other names (hard links): ${FIX_LINK}`)
    // Exact identities (ninth review, minor 1: NTFS file indexes pass 2^53, and as numbers two files
    // may compare equal). Windows: the file index alone (a volume's serial is reported two ways on
    // some file systems).
    const mine = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    const other = mine.ino !== 0n && (named.ino !== mine.ino || (!windows && named.dev !== mine.dev))
    if (named.isSymbolicLink() || other)
      throw new Error(`The log file ${path} is a link, or was replaced while it was opened: ${FIX_LINK}`)
    if (!windows) fchmodSync(fd, 0o600)
    return { fd, size: st.size, made }
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/** Writes `chunk` whole on `fd`, a short write continued; a write that takes nothing is an error. */
function writeAll(fd: number, chunk: Buffer, written: (n: number) => void): void {
  let done = 0
  while (done < chunk.length) {
    const n = writeSync(fd, chunk, done, chunk.length - done)
    // Seventh review (minor 7): a file system that takes no byte never holds the server in a loop.
    if (n <= 0) throw new Error('the log file took no bytes')
    done += n
    written(n)
  }
}

/**
 * One line appended to the log file, opened as the server opens it (CI fixes, seventh review,
 * important 1): a start that failed, before the server's logger exists.
 */
export function appendLogLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const { fd, made } = openChecked(path)
  let done = 0
  try {
    writeAll(fd, Buffer.from(line.endsWith('\n') ? line : `${line}\n`), (n) => (done += n))
  } catch (e) {
    // A line cut short is ended, so the server's next one is not glued to it (eighth review).
    if (done > 0)
      try {
        writeSync(fd, '\n')
      } catch {
        // Then it stays cut.
      }
    throw e
  } finally {
    closeSync(fd)
    // One it made is private on Windows too (eighth review, minor 3): a later start, elevated,
    // could not take it as its own.
    if (made && windows)
      try {
        repairPrivate([path], { made: true })
      } catch {
        // The start failed already; this is said nowhere else.
      }
  }
}

/**
 * The server's log file: private (0600) in a private directory, and rotated whenever the next
 * line would pass `limit` (one previous file is kept as `<path>.1`), so a service that runs for
 * months cannot fill the disk. The server never stops for its log: a line that cannot be written is
 * dropped and said on stderr (CI fixes, fourth to sixth reviews).
 */
export function openLogFile(path: string, limit = LOG_ROTATE_BYTES): Writable {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let fd = -1
  let size = 0
  /** Gives up the descriptor before closing it: nothing writes into its number afterwards. */
  const release = () => {
    const was = fd
    fd = -1
    if (was !== -1) closeSync(was)
  }
  /** Opens the log file as openChecked takes it; says whether it made the file. */
  const open = (): boolean => {
    const opened = openChecked(path)
    fd = opened.fd
    size = opened.size
    return opened.made
  }
  // Security audit 2026-10-16 (minor): Windows has no 0600; a log file there takes its folder's ACL,
  // perhaps open to every user. It is made private (as the data directory is), and the log says so.
  // A notice is written only into the file it is about, while it is open (fourth review, important 2:
  // never into a descriptor the system has given to another file since).
  let generation = 0
  let closed = false
  const notice = (line: Record<string, unknown>, of = generation) => {
    if (closed || of !== generation || fd === -1) return
    const text = `${JSON.stringify({ level: 40, time: Date.now(), pid: process.pid, ...line })}\n`
    try {
      size += put(Buffer.from(text))
    } catch {
      // The log is the one place to say it; it cannot be written now.
    }
  }
  const failedNotice = { path, msg: 'could not check that the log file is private to this account' }
  const privateOnWindows = (made: boolean) => {
    try {
      // One this process made is its own, whoever Windows says owns it (review of the CI fixes).
      const [repaired] = repairPrivate([path], { made })
      if (repaired) notice({ path, was: repaired.was, msg: PRIVATE_NOTICE })
    } catch {
      notice(failedNotice)
    }
  }
  /** A file opened while writing, made private without holding the server (fourth review, minor 6). */
  const privateLater = () => {
    const of = generation
    repairPrivateLater([path], { made: true }).then(
      ([repaired]) => repaired && notice({ path, was: repaired.was, msg: PRIVATE_NOTICE }, of),
      () => notice(failedNotice, of),
    )
  }
  /**
   * Writes the whole chunk, a short write continued (sixth review, minor 5); a line cut by a failure
   * is ended, so the next one is never glued to it. Returns the bytes written.
   */
  const put = (chunk: Buffer): number => {
    let done = 0
    try {
      writeAll(fd, chunk, (n) => (done += n))
    } catch (e) {
      if (done > 0)
        try {
          done += writeSync(fd, '\n')
        } catch {
          // Then it stays cut.
        }
      size += done
      throw e
    }
    return done
  }
  // Fourth review (important 3): a file another program holds open (a reader following the log)
  // cannot be renamed on Windows: the log goes on in the same file, and is rotated once it has grown
  // by another limit, never stopping the server.
  let tryAgainAt = 0
  /** Whether the file was moved aside; a new one is then opened (and its making said). */
  const rotate = (): { moved: boolean; made: boolean } => {
    // Fifth review (minor 2): the descriptor is given up first, so a notice waiting on an earlier
    // repair never writes into the number even when the new file cannot be opened.
    generation++
    release()
    let moved = true
    try {
      renameSync(path, `${path}.1`)
    } catch {
      moved = false
    }
    tryAgainAt = moved ? 0 : size + limit
    return { moved, made: open() }
  }
  // Fifth review (minor 3): a line that cannot be written (a full disk) is dropped and said on stderr
  // — once, until the log is written again — and the log goes on: the file is opened again at the
  // next line if need be.
  let failing = false
  const failed = (e: unknown) => {
    if (failing) return
    failing = true
    process.stderr.write(`Mongo Manager: could not write to the log file ${path}: ${(e as Error).message}\n`)
  }
  const created = open()
  // Second and third reviews (minor 11, minor 2): the file there is made private, then, when it is
  // over its limit, rotated, and the new one made private too.
  if (windows) privateOnWindows(created)
  if (size > limit) {
    // Ninth review (nit 4): its own only when it made it.
    const turned = rotate()
    if (turned.moved && windows) privateOnWindows(turned.made)
  }
  const out = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        // Opened again after a failed open (sixth review, minor 3): one it made is made private.
        if (fd === -1 && open() && windows) privateLater()
        if (size > 0 && size + chunk.length > limit && size >= tryAgainAt) {
          const turned = rotate()
          // The new file is made private soon after, never inside the write (independent review).
          if (turned.made && windows) privateLater()
        }
        size += put(chunk)
        failing = false
      } catch (e) {
        failed(e)
      }
      callback()
    },
    final(callback) {
      closed = true
      try {
        // Sixth review (minor 4): given up before it is closed, so a close that fails is never
        // retried on a number the system may have given to another file.
        release()
        callback()
      } catch (e) {
        callback(e as Error)
      }
    },
    destroy(error, callback) {
      closed = true
      try {
        release()
      } catch {
        // Closing is all that is left to do.
      }
      callback(error)
    },
  })
  // Fourth review (important 3): pino adds no error listener to a stream it is given; whatever error
  // is left (closing) is said on stderr, never ending the server.
  out.on('error', (e) => failed(e))
  return out
}
