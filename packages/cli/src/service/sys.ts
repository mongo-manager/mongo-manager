// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { spawnSync } from 'node:child_process'
import { logFileProblem, powershellEnv, windowsEnv, windowsTool } from '@mongo-manager/server'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProgramSource } from './common'

/** Everything a service installer does to the system: replaced by a fake in tests. */
export interface Sys {
  platform: NodeJS.Platform
  isAdmin(): boolean
  /** Runs a program without a shell and captures its output. */
  run(
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): { status: number; stdout: string; stderr: string }
  /** Runs a program without a shell, attached to this terminal (status, logs). */
  runInherit(cmd: string, args: string[]): number
  exists(path: string): boolean
  read(path: string): string
  /** The last `bytes` of a file, without reading all of it. */
  readTail(path: string, bytes: number): string
  /** Why the server would refuse this log file (a link, other names, not a file), or null. */
  logFileProblem(path: string): string | null
  /** The whole file (an executable, to read what it loads). */
  readBytes(path: string): Buffer
  /** Replaces a file atomically (temp file + rename) with the given mode. */
  write(path: string, content: string | Buffer, mode: number): void
  mkdir(path: string, mode: number): void
  /**
   * Copies the program into `to`, replacing it atomically: the standalone binary to
   * bin/mongo-manager[.exe], or the package (dist/cli.cjs, public/) with the Node binary that will
   * run it (bin/node[.exe]).
   */
  copyProgram(from: ProgramSource, to: string): void
  remove(path: string): void
  randomKey(): string
  /** The path with every symlink resolved. */
  realpath(path: string): string
  /** As the system itself resolves it: short (8.3) names made long too; the path when it cannot. */
  realpathNative(path: string): string
  /** Owner, group and mode of a path itself, a link not followed, or null when nothing is there. */
  lstat(path: string): { uid: number; gid?: number; mode: number } | null
  /** What a link says, as written in it. */
  readlink(path: string): string
  /** Owner, group and mode of a path (POSIX), or null when it does not exist. */
  stat(path: string): { uid: number; gid?: number; mode: number } | null
  /** A new directory only the current (administrator) user can use, e.g. for the task XML. */
  privateTempDir(): string
  /**
   * Tidies away a folder only when it is an empty folder (never a link, nor what one leads to);
   * nothing when it is not, or is gone. Never throws: why one that is empty was left (held by a
   * prompt in it, say), or null (ninth review of the CI fix 2026-10-20, important 1, minor 2).
   */
  removeEmptyDir(path: string): string | null
  /** Waits, blocking (a command line waiting for a service to stop). */
  sleep(ms: number): void
  /** The time, in milliseconds (the deadline of such a wait). */
  now(): number
}

type Rename = (from: string, to: string) => void

function renameWithRetry(rename: Rename, from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
}

const { O_NOFOLLOW, O_NONBLOCK } = constants
let chunk: Buffer | undefined
const notPlain = (path: string) =>
  `${path} is a link or special file: the program is copied only from plain files`

/**
 * Copies one plain file into a new file this process owns (CI 2026-10-19: a file copied with
 * copyFile keeps its owner, so the service's Node stayed the nvm user's, who could have kept it open
 * to write). Never through a link: the path is looked at itself, opened without following a link
 * (POSIX) and must be the very file looked at, so one swapped in after it was checked is refused, not
 * copied as a link a later chmod would follow (review of the CI fixes, I1; second review of them, minor 1).
 * Opened without blocking, so a FIFO swapped in cannot hold the install (second review of the CI fixes, minor 2).
 * `alone`: a file that has other names (hard links) is refused — on macOS anyone may link a file
 * they cannot read, which the copy would make readable (second review of the CI fixes, minor 3). Only for a --node
 * of someone else's: the running Node and the package's own files are what this install runs as
 * root already, and a package pnpm installed shares its files with its store. Left as it is (third
 * review, minor 7): a --node's owner who swaps a folder above it for a link between the look and the
 * open has root copy a file of the same name from there, which must then pass checkProgram.
 */
function copyPlainFile(from: string, to: string, alone = false): void {
  const seen = lstatSync(from, { bigint: true })
  if (!seen.isFile()) throw new Error(notPlain(from))
  const linked = (n: bigint) => {
    if (alone && n > 1n)
      throw new Error(
        `${from} has other names (hard links), so it may not be the file it seems: copy it to a file of its own and name that with --node`,
      )
  }
  linked(seen.nlink)
  let src: number
  try {
    src = openSync(from, constants.O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0))
  } catch (e) {
    // A link opened with O_NOFOLLOW fails with ELOOP.
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(notPlain(from), { cause: e })
    throw e
  }
  try {
    const opened = fstatSync(src, { bigint: true })
    if (!opened.isFile()) throw new Error(notPlain(from))
    if (opened.ino !== seen.ino || opened.dev !== seen.dev)
      throw new Error(`${from} changed while it was copied: run the install again`)
    linked(opened.nlink)
    const dest = openSync(to, 'wx', 0o600)
    try {
      // One buffer for every file copied (third review of the CI fixes, minor 8).
      const buffer = (chunk ??= Buffer.allocUnsafe(1 << 20))
      for (let n; (n = readSync(src, buffer, 0, buffer.length, null)) > 0;) {
        for (let off = 0; off < n;) off += writeSync(dest, buffer, off, n - off)
      }
    } finally {
      closeSync(dest)
    }
  } finally {
    closeSync(src)
  }
}

/**
 * Copies a folder of the package entry by entry, each looked at itself: a link or junction anywhere,
 * the folder itself included, stops the install (second review of the CI fixes, I-A: Node's cp
 * follows a junction on Windows and links one at the top, so content outside the administrators'
 * copy ended up in it, or stayed changeable by its owner). Files are copied as copyPlainFile does.
 */
function copyTree(from: string, to: string): void {
  const s = lstatSync(from)
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(notPlain(from))
  mkdirSync(to, { mode: 0o755 })
  for (const name of readdirSync(from)) {
    const path = join(from, name)
    const entry = lstatSync(path)
    if (entry.isDirectory() && !entry.isSymbolicLink()) copyTree(path, join(to, name))
    else if (entry.isFile()) copyPlainFile(path, join(to, name))
    else throw new Error(notPlain(path))
  }
}

/**
 * Removes a copy left behind; a failure to (Windows' scanner holding a new file) never hides why, nor
 * makes a program already in place a failed install (third review of the CI fixes, minor 3).
 */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // Left for the next install, which removes it first.
  }
}

/**
 * Program files are the installer's (root's, for the service) and world-readable, whatever the
 * installing shell's umask is and whoever owned what they were copied from; `exe` is executable.
 * Anything but a plain file or folder in the copy (a link swapped into the package after it was
 * checked) stops the install (review of the CI fixes, I1). Owner first: a chown may clear mode bits;
 * a folder is opened to others last, once all inside it is the installer's (review of the CI fixes, M1).
 */
export function makeInstallersOwn(dir: string, uid: number, gid: number, exe: string): void {
  lchownSync(dir, uid, gid)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) makeInstallersOwn(path, uid, gid, exe)
    else if (entry.isFile()) {
      lchownSync(path, uid, gid)
      chmodSync(path, path === exe ? 0o755 : 0o644)
    } else throw new Error(notPlain(path))
  }
  chmodSync(dir, 0o755)
}

/**
 * On Windows, a tool named without a folder is Windows' own, run from its place, and Windows
 * PowerShell gets its own modules only (CI 2026-10-18; see windowsTool and powershellEnv).
 */
function command(cmd: string, extra: Record<string, string> = {}): { file: string; env: NodeJS.ProcessEnv } {
  if (process.platform !== 'win32') return { file: cmd, env: { ...process.env, ...extra } }
  const bare = !/[\\/]/.test(cmd)
  return {
    file: bare ? windowsTool(cmd) : cmd,
    env: bare && cmd === 'powershell' ? powershellEnv(extra) : windowsEnv(process.env, extra),
  }
}

/** `rename` is replaceable for tests that make moving the new program into place fail. */
export function realSys(ops: { rename?: Rename } = {}): Sys {
  const rename = ops.rename ?? renameSync
  const posix = process.platform !== 'win32'
  return {
    platform: process.platform,
    isAdmin: () =>
      posix
        ? process.getuid?.() === 0
        : spawnSync(command('net').file, ['session'], { stdio: 'ignore', windowsHide: true, shell: false })
            .status === 0,
    run: (cmd, args, opts = {}) => {
      const { file, env } = command(cmd, opts.env)
      const r = spawnSync(file, args, { encoding: 'utf8', shell: false, windowsHide: true, env })
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? '',
        stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}`,
      }
    },
    runInherit: (cmd, args) => {
      const { file, env } = command(cmd)
      return spawnSync(file, args, { stdio: 'inherit', shell: false, env }).status ?? -1
    },
    exists: existsSync,
    read: (p) => readFileSync(p, 'utf8'),
    readBytes: (p) => readFileSync(p),
    logFileProblem,
    readTail: (p, bytes) => {
      const fd = openSync(p, 'r')
      try {
        const size = fstatSync(fd).size
        const length = Math.min(size, bytes)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        return buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
    },
    write: (p, content, mode) => {
      const tmp = `${p}.tmp-${process.pid}`
      rmSync(tmp, { force: true })
      writeFileSync(tmp, content, { mode, flag: 'wx' })
      if (posix) chmodSync(tmp, mode)
      renameSync(tmp, p)
    },
    mkdir: (p, mode) => {
      mkdirSync(p, { recursive: true, mode })
      if (posix) chmodSync(p, mode)
    },
    copyProgram: (from, to) => {
      const old = `${to}.old`
      const ext = posix ? '' : '.exe'
      // Second review of the CI fixes (minor 5): a run that could not put the earlier program back
      // left it only as .old: it goes back into place, never removed — only a program, one with its
      // executable (third review of the CI fixes, minor 4).
      const program = (dir: string) =>
        existsSync(join(dir, 'bin', `mongo-manager${ext}`)) || existsSync(join(dir, 'bin', `node${ext}`))
      if (!existsSync(to) && program(old)) {
        try {
          renameWithRetry(rename, old, to)
        } catch (e) {
          // Fifth review of the CI fixes (nit 2): said with where it is.
          throw new Error(
            `The earlier program at ${old} could not be put back in place (${(e as Error).message}): ` +
              'run service install again, which puts it back',
            { cause: e },
          )
        }
      }
      // The folders we create above it (e.g. /opt/mongo-manager) must be enterable by the service
      // whatever the umask; an existing system folder keeps its own mode. Made before anything else
      // is, so they are known as ours (review of the CI fixes, I2: the copy made them first), one by
      // one, so a path that appeared meanwhile (a link) stops it instead of being followed (second
      // review of the CI fixes, minor 6), with what to do (third review, minor 5; fourth, minor 5).
      const made: string[] = []
      let top = dirname(to)
      for (; !existsSync(top) && dirname(top) !== top; top = dirname(top)) made.unshift(top)
      // Fifth review (nit 3): a file where a folder above it should be.
      if (existsSync(top) && !statSync(top).isDirectory())
        throw new Error(`${top} is not a folder: remove it, then install again`)
      for (const p of made) {
        try {
          mkdirSync(p, { mode: 0o755 })
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code === 'EEXIST')
            throw new Error(
              `${p} is there but is no folder this install can use (a link, or one it may not look into): ` +
                'remove it, or make it a folder only administrators can change, then install again',
              { cause: e },
            )
          if (code === 'EPERM' || code === 'EACCES')
            throw new Error(
              `${p} could not be made in ${dirname(p)} (${code}): make it yourself, a folder only ` +
                'administrators can change, then install again',
              { cause: e },
            )
          throw e
        }
        if (posix) chmodSync(p, 0o755)
      }
      const next = `${to}.new`
      rmSync(next, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      // Only this process may enter the copy until all of it is its own (review of the CI fixes, M1).
      mkdirSync(next, { mode: 0o700 })
      try {
        if (posix) chmodSync(next, 0o700)
        mkdirSync(join(next, 'bin'), { mode: 0o755 })
        // The executable the service runs: the standalone binary, or its own copy of Node (an nvm or
        // per-user install elsewhere is fine, only this copy runs).
        const exe = join(next, 'bin', `${'binary' in from ? 'mongo-manager' : 'node'}${ext}`)
        if ('binary' in from) {
          copyPlainFile(from.binary, exe)
        } else {
          mkdirSync(join(next, 'dist'), { mode: 0o755 })
          copyPlainFile(from.cli, join(next, 'dist', 'cli.cjs'))
          // Third review of the CI fixes (I-1): the shell worker the server starts from beside the
          // bundle (without it no shell opened), and the notices the package ships.
          const worker = join(dirname(from.cli), 'shell-worker.cjs')
          if (!lstatSync(worker, { throwIfNoEntry: false }))
            throw new Error(`${worker} is missing: the package is incomplete; install mongo-manager again`)
          copyPlainFile(worker, join(next, 'dist', 'shell-worker.cjs'))
          const notices = join(dirname(from.cli), 'THIRD-PARTY-NOTICES.txt')
          if (lstatSync(notices, { throwIfNoEntry: false }))
            copyPlainFile(notices, join(next, 'dist', 'THIRD-PARTY-NOTICES.txt'))
          // And the package's own licence beside them (fourth review, nit 4), with its additional
          // terms (NOTICE, user request 2026-11-03).
          for (const name of ['LICENSE', 'NOTICE']) {
            const licence = join(dirname(from.cli), '..', name)
            if (lstatSync(licence, { throwIfNoEntry: false })) copyPlainFile(licence, join(next, name))
          }
          copyTree(from.publicDir, join(next, 'public'))
          // Phase 4b §4: the bundled plugins, beside public/ in the package, when it ships them; a
          // link there is refused, not taken for no plugins.
          const plugins = join(from.publicDir, '..', 'plugins')
          if (lstatSync(plugins, { throwIfNoEntry: false })) copyTree(plugins, join(next, 'plugins'))
          // Third review of the CI fixes (minor 1): compared by the real place (nvm-windows runs Node through a link).
          copyPlainFile(from.node, exe, from.node !== realpathSync(process.execPath))
        }
        if (posix) makeInstallersOwn(next, process.getuid!(), process.getgid!(), exe)
      } catch (e) {
        removeQuietly(next)
        throw e
      }
      try {
        // Both there: an earlier run's .old that could not be removed.
        rmSync(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        // Windows keeps a just-stopped program's files locked for a moment.
        if (existsSync(to)) renameWithRetry(rename, to, old)
      } catch (e) {
        // Nothing changed yet: the new copy is not left behind (fourth review of the CI fixes, minor 2).
        removeQuietly(next)
        throw e
      }
      try {
        renameWithRetry(rename, next, to)
      } catch (e) {
        // Never leave no program behind: the earlier one goes back into place; when it cannot, both
        // causes are said and where it is (third review of the CI fixes, minor 2).
        try {
          if (existsSync(old) && !existsSync(to)) renameWithRetry(rename, old, to)
        } catch (back) {
          throw new Error(
            `The new program could not be moved into place (${(e as Error).message}), nor the earlier one ` +
              `put back (${(back as Error).message}): it is at ${old}, which the next install puts back`,
            // The first cause is in the message.
            { cause: back },
          )
        } finally {
          removeQuietly(next)
        }
        throw e
      }
      removeQuietly(old)
    },
    // Windows' scanner holds a file just stopped or written for a moment (fourth review, minor 4).
    remove: (p) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    randomKey: () => randomBytes(32).toString('base64'),
    realpath: (p) => realpathSync(p),
    realpathNative: (p) => {
      // Some virtual drives refuse the system's own resolving (seventh review, minor 1).
      for (const resolve of [realpathSync.native, realpathSync]) {
        try {
          return resolve(p)
        } catch {
          // The next way, then the path itself.
        }
      }
      return p
    },
    lstat: (p) => {
      try {
        const s = lstatSync(p)
        return { uid: s.uid, gid: s.gid, mode: s.mode }
      } catch {
        return null
      }
    },
    readlink: (p) => readlinkSync(p),
    stat: (p) => {
      try {
        const s = statSync(p)
        return { uid: s.uid, gid: s.gid, mode: s.mode }
      } catch {
        return null
      }
    },
    privateTempDir: () => mkdtempSync(join(tmpdir(), 'mm-service-')),
    removeEmptyDir: (p) => {
      try {
        const own = lstatSync(p)
        if (own.isSymbolicLink() || !own.isDirectory()) return null
        rmdirSync(p)
        return null
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'EEXIST') return null
        // The code alone: Node's message names the path again (tenth review, minor 4).
        return code ?? (e as Error).message
      }
    },
    sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    now: () => Date.now(),
  }
}
