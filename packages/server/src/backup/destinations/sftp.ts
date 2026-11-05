// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { posix } from 'node:path'
import { PassThrough, pipeline as pipe, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ssh2, { type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2'
import type { z } from 'zod'
import type { SftpConfigSchema } from '@mongo-manager/shared'
import { EgressError, readBounded, type Egress } from '../../net/egress'
import { fingerprintOf } from '../../connections/ssh'
import { safeEqual } from '../../http/security'
import { assertSafePath, isSafeKey } from './layout'
import { withRetry } from './retry'
import {
  DestinationError,
  offsetOf,
  toDestinationError,
  type DestinationAdapter,
  type RemoteItem,
} from './types'

const { Client } = ssh2
export type SftpConfig = z.infer<typeof SftpConfigSchema>
export type SftpSecrets = { password?: string; privateKey?: string; passphrase?: string }

const PAGE = 1000
const MAX_ITEMS = 10_000
/** Entries read from one folder at most (a year, a month): more is not ours to walk. */
const MAX_ENTRIES = 20_000
/** A session left unused this long is closed. */
const IDLE_MS = 15_000
const READY_MS = 20_000
/** W4 review (minor): a download that receives nothing for this long is given up. */
const STALL_MS = 60_000
/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3
const YEAR = /^\d{4}$/
const MONTH = /^\d{2}$/

interface Session {
  client: InstanceType<typeof Client>
  sftp: SFTPWrapper
  /** Aborted when the session closes. */
  gone: AbortSignal
}

const call = <T>(fn: (cb: (e: Error | null | undefined, v: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))))
const codeOf = (e: unknown) => (e as { code?: unknown })?.code

function sftpError(e: unknown): DestinationError {
  if (e instanceof DestinationError) return e
  if (e instanceof EgressError) return toDestinationError(e)
  const code = codeOf(e)
  if (code === NO_SUCH_FILE) return new DestinationError('not_found', 'Not found at the destination')
  if (code === PERMISSION_DENIED)
    return new DestinationError('forbidden', 'The SFTP user may not do this in the folder')
  if (typeof code === 'number') return new DestinationError('provider', `The SFTP server refused (${code})`)
  return new DestinationError('network', 'The SFTP connection failed')
}

/**
 * W4.5 (completion design §2 W4.5): SFTP over ssh2 (already a dependency; no native module). The
 * TCP connection is the egress guard's (the address judged, a proxy's CONNECT when one is set); the
 * server's host key must be the pinned SHA-256 fingerprint — none pinned, or another one, and the
 * session ends before anything is sent (the key shown is reported to be compared and trusted). A
 * backup is written to "<name>.part" and renamed once whole; an interrupted upload continues from the
 * part file's size. SFTP keeps no checksum, so a copy is read back whole unless that is turned off.
 * One session is reused while calls come, and closed when idle.
 */
export function createSftpAdapter(o: {
  egress: Egress
  config: SftpConfig
  secrets: SftpSecrets
  partBytes: number
  now: () => number
  retries?: number
  /** Tests only: how long a download may receive nothing. */
  stallMs?: number
}): DestinationAdapter {
  const { config } = o
  const host = config.host.replace(/^\[|\]$/g, '')
  const base = config.folder === '' ? '.' : config.folder
  const full = (key: string) => posix.join(base, ...assertSafePath(key))

  let current: Promise<Session> | null = null
  let busy = 0
  let idle: NodeJS.Timeout | null = null
  const drop = (s: Promise<Session>) => {
    if (current === s) current = null
    void s.then((x) => x.client.end()).catch(() => undefined)
  }
  const schedule = () => {
    if (idle) clearTimeout(idle)
    idle = null
    if (busy > 0 || !current) return
    const s = current
    idle = setTimeout(() => drop(s), IDLE_MS)
    idle.unref()
  }

  /**
   * A new session, forgotten as the current one when it closes. W4 review (minor): it belongs to the
   * adapter, not to the call that happened to open it — one caller stopping does not stop the
   * session others wait for (each caller's own signal is raced against it, see joined()).
   */
  function start(): Promise<Session> {
    const p: Promise<Session> = open(new AbortController().signal, () => {
      if (current === p) current = null
    })
    p.catch(() => {
      if (current === p) current = null
    })
    return p
  }

  async function open(signal: AbortSignal, onClose: () => void): Promise<Session> {
    if (!o.egress.socket) throw new DestinationError('provider', 'SFTP needs a TCP egress')
    const socket = await o.egress.socket({ host, port: config.port, signal, viaProxy: true })
    const client = new Client()
    let seen = ''
    let refused: 'host_key' | 'host_key_changed' | null = null
    const stop = () => client.end()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => resolve())
        client.once('error', (e: Error & { level?: string }) => {
          if (refused)
            return reject(
              new DestinationError(
                refused,
                refused === 'host_key'
                  ? 'No host key is trusted for this server yet: compare the key shown and trust it'
                  : 'The server’s host key changed: compare it before trusting the new one',
                { hostKey: seen },
              ),
            )
          if (e.level === 'client-authentication')
            return reject(
              new DestinationError('auth', 'The SFTP server refused the user name or the credentials'),
            )
          if (e.level === 'client-timeout')
            return reject(new DestinationError('timeout', 'The SFTP server did not answer in time'))
          reject(new DestinationError('network', 'The SSH connection failed'))
        })
        client.once('close', () => reject(new DestinationError('network', 'The SSH connection closed')))
        const cfg: ConnectConfig = {
          sock: socket,
          username: config.username,
          readyTimeout: READY_MS,
          keepaliveInterval: 15_000,
          hostVerifier: (key: Buffer) => {
            seen = fingerprintOf(key)
            if (!config.hostFingerprint) refused = 'host_key'
            else if (!safeEqual(seen, config.hostFingerprint)) refused = 'host_key_changed'
            return refused === null
          },
          ...(config.auth === 'password'
            ? { password: o.secrets.password ?? '' }
            : {
                privateKey: o.secrets.privateKey ?? '',
                ...(o.secrets.passphrase ? { passphrase: o.secrets.passphrase } : {}),
              }),
        }
        try {
          client.connect(cfg)
        } catch {
          // ssh2 throws at once on a key it cannot read (or a wrong passphrase).
          socket.destroy()
          reject(new DestinationError('auth', 'The private key cannot be read (or its passphrase is wrong)'))
        }
      })
      const sftp = await call<SFTPWrapper>((cb) => client.sftp(cb)).catch(() => {
        throw new DestinationError('provider', 'The server does not offer SFTP')
      })
      const gone = new AbortController()
      client.on('error', () => undefined)
      client.on('close', () => {
        gone.abort()
        onClose()
      })
      return { client, sftp, gone: gone.signal }
    } catch (e) {
      client.end()
      socket.destroy()
      throw e
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  /** The shared session, as one caller waits for it: their stop ends their wait, not the session. */
  function joined(s: Promise<Session>, signal: AbortSignal): Promise<Session> {
    if (signal.aborted) return Promise.reject(new DestinationError('aborted', 'The request was stopped'))
    return new Promise<Session>((resolve, reject) => {
      const stop = () => reject(new DestinationError('aborted', 'The request was stopped'))
      signal.addEventListener('abort', stop, { once: true })
      s.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
    })
  }

  /** Runs fn on the shared session; a failure that is not the server's answer drops the session. */
  async function withSession<T>(
    signal: AbortSignal,
    fn: (s: Session, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (idle) clearTimeout(idle)
    busy++
    const s = (current ??= start())
    try {
      const session = await joined(s, signal)
      // A session that ends midway (the server gone, the network cut) fails the call at once:
      // a pending SFTP request would otherwise wait for an answer that never comes.
      const sig = AbortSignal.any([signal, session.gone])
      const ended = new Promise<never>((_, reject) => {
        const fail = () => reject(new DestinationError('network', 'The SSH connection closed'))
        if (sig.aborted) fail()
        else sig.addEventListener('abort', fail, { once: true })
      })
      ended.catch(() => undefined)
      return await Promise.race([fn(session, sig), ended])
    } catch (e) {
      const d = sftpError(e)
      // A caller's own stop leaves the session to the others.
      const own = d.reason === 'aborted' && signal.aborted
      if (!own && typeof codeOf(e) !== 'number' && !(e instanceof DestinationError && e.reason === 'path'))
        drop(s)
      throw d
    } finally {
      busy--
      schedule()
    }
  }
  const retry = <T>(signal: AbortSignal, fn: () => Promise<T>) =>
    withRetry(fn, { signal, ...(o.retries !== undefined ? { retries: o.retries } : {}) })

  const statOrNull = async (s: Session, path: string): Promise<Stats | null> =>
    call<Stats>((cb) => s.sftp.stat(path, cb)).catch((e) => {
      if (codeOf(e) === NO_SUCH_FILE) return null
      throw e
    })

  /** W4 review (minor): whether the first `length` bytes there are those of the local file. */
  async function samePrefix(
    s: Session,
    remote: string,
    local: string,
    length: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const digest = async (r: Readable) => {
      const h = createHash('sha256')
      await pipeline(
        r,
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const c of chunks) h.update(c)
        },
        { signal },
      )
      return h.digest('hex')
    }
    const [there, here] = await Promise.all([
      digest(s.sftp.createReadStream(remote, { start: 0, end: length - 1 }) as unknown as Readable),
      digest(createReadStream(local, { start: 0, end: length - 1 })),
    ])
    return there === here
  }

  /** The folders above a key, made one by one where missing (inside the destination's folder). */
  async function folders(s: Session, key: string): Promise<void> {
    const parts = assertSafePath(key).slice(0, -1)
    let at = base
    for (const p of parts) {
      at = posix.join(at, p)
      const st = await statOrNull(s, at)
      if (st?.isDirectory()) continue
      if (st) throw new DestinationError('path', 'A file stands where the backup folder should be')
      await call<void>((cb) => s.sftp.mkdir(at, cb)).catch(async (e) => {
        // Made meanwhile by another send: fine.
        if (!(await statOrNull(s, at))?.isDirectory()) throw e
      })
    }
  }

  async function rename(s: Session, from: string, to: string): Promise<void> {
    try {
      await call<void>((cb) => s.sftp.rename(from, to, cb))
    } catch (e) {
      // SFTP 3 never replaces a file: one already there is a copy sent before (the send job checks it).
      if (await statOrNull(s, to)) throw new DestinationError('conflict', 'A copy is already there')
      throw e
    }
  }

  async function readDir(s: Session, path: string) {
    const list = await call<Array<{ filename: string; attrs: Stats }>>((cb) =>
      s.sftp.readdir(path, cb),
    ).catch((e) => {
      if (codeOf(e) === NO_SUCH_FILE) return []
      throw e
    })
    return list.slice(0, MAX_ENTRIES)
  }

  const adapter: DestinationAdapter = {
    readBack: config.verifyReadBack,
    // W4 review (minor): an IPv6 address in brackets.
    endpoint: () => new URL(`sftp://${host.includes(':') ? `[${host}]` : host}:${config.port}`),
    caPem: () => undefined,
    async probe(signal) {
      try {
        let timing = { resolveMs: 0, connectMs: 0 }
        const s = await o.egress.socket!({
          host,
          port: config.port,
          signal,
          viaProxy: true,
          onTiming: (t) => (timing = { resolveMs: t.resolveMs, connectMs: t.connectMs }),
        })
        s.destroy()
        return timing
      } catch (e) {
        throw sftpError(e)
      }
    },
    async authCheck(signal) {
      await withSession(signal, async (s) => {
        const st = await statOrNull(s, base)
        if (!st?.isDirectory()) throw new DestinationError('path', 'The folder does not exist on the server')
      })
      return {}
    },
    async put(key, file, resume, io, signal) {
      const target = full(key)
      const part = `${target}.part`
      // W4 review (minor): the state this send saved, so a retry within it goes on from the part file.
      let state = resume as { key?: unknown } | null
      await retry(signal, () =>
        withSession(signal, async (s, sig) => {
          await folders(s, key)
          let held = state?.key === key ? await statOrNull(s, part) : null
          // W4 review (minor): a part file larger than the backup, or one whose beginning is not the
          // backup's (checked even with reading back off: a resumed part is never trusted on its size
          // alone), is not this send's: it starts again.
          if (
            held?.isFile() &&
            held.size > 0 &&
            (held.size > file.size || !(await samePrefix(s, part, file.path, held.size, sig)))
          ) {
            await call<void>((cb) => s.sftp.unlink(part, cb))
            held = null
          }
          const offset = held?.isFile() ? held.size : 0
          state = { key }
          io.saveResume(state)
          let sent = offset
          io.progress(sent)
          if (offset < file.size) {
            const counter = new PassThrough()
            counter.on('data', (c: Buffer) => {
              sent += c.length
              io.progress(sent)
            })
            await pipeline(
              createReadStream(file.path, { start: offset }),
              counter,
              s.sftp.createWriteStream(part, { flags: offset > 0 ? 'r+' : 'w', start: offset, mode: 0o600 }),
              { signal: sig },
            )
          } else if (!held) {
            // An empty backup still leaves a file to rename.
            await call<Buffer>((cb) => s.sftp.open(part, 'w', cb)).then((h) =>
              call<void>((cb) => s.sftp.close(h, cb)),
            )
          }
          const st = await statOrNull(s, part)
          if (!st || st.size !== file.size)
            throw new DestinationError('verify', 'The uploaded size does not match the backup')
          await rename(s, part, target)
        }),
      )
      io.saveResume(null)
      io.progress(file.size)
      return {}
    },
    async putSmall(key, body, signal) {
      const target = full(key)
      await retry(signal, () =>
        withSession(signal, async (s) => {
          await folders(s, key)
          const part = `${target}.part`
          await call<void>((cb) => s.sftp.writeFile(part, body, { mode: 0o600 }, cb))
          // A manifest written again replaces the old one: at once where the server can
          // (posix-rename@openssh.com, W4 review minor), else removed then renamed (SFTP 3 never replaces).
          const ext = (s.sftp as unknown as { _extensions?: Record<string, string> })._extensions
          if (ext?.['posix-rename@openssh.com'] === '1')
            await call<void>((cb) => s.sftp.ext_openssh_rename(part, target, cb))
          else {
            if (await statOrNull(s, target)) await call<void>((cb) => s.sftp.unlink(target, cb))
            await rename(s, part, target)
          }
        }),
      )
    },
    async stat(key, signal) {
      const path = full(key)
      return retry(signal, () =>
        withSession(signal, async (s) => {
          const st = await statOrNull(s, path)
          return st?.isFile() ? { size: st.size, archived: false } : null
        }),
      )
    },
    async get(key, offset, signal) {
      const path = full(key)
      if (idle) clearTimeout(idle)
      busy++
      let released = false
      const release = () => {
        if (released) return
        released = true
        busy--
        schedule()
      }
      try {
        const s = await joined((current ??= start()), signal)
        const st = await statOrNull(s, path)
        if (!st?.isFile()) throw new DestinationError('not_found', 'Not found at the destination')
        const stream = s.sftp.createReadStream(path, { start: offset }) as unknown as Readable
        // W4 review (minor): a server that stops sending midway does not hold the download for ever.
        const out = new PassThrough()
        const timer = setTimeout(() => {
          stream.destroy(new DestinationError('timeout', 'The SFTP server stopped sending'))
        }, o.stallMs ?? STALL_MS)
        stream.on('data', () => timer.refresh())
        pipe(stream, out, (e) => {
          clearTimeout(timer)
          release()
          if (e) out.destroy(e instanceof DestinationError ? e : sftpError(e))
        })
        return out
      } catch (e) {
        release()
        if (current && !(signal.aborted && sftpError(e).reason === 'aborted')) drop(current)
        throw sftpError(e)
      }
    },
    async getSmall(key, limit, signal) {
      const path = full(key)
      return retry(signal, () =>
        withSession(signal, async (s) => {
          const st = await statOrNull(s, path)
          if (!st?.isFile()) return null
          return readBounded(
            s.sftp.createReadStream(path, { start: 0, end: limit }) as unknown as Readable,
            limit,
          )
        }),
      )
    },
    async list(cursor, signal) {
      const root = posix.join(base, 'mongo-manager')
      const found: RemoteItem[] = await retry(signal, () =>
        withSession(signal, async (s) => {
          const out: RemoteItem[] = []
          for (const y of await readDir(s, root)) {
            if (!YEAR.test(y.filename) || !y.attrs.isDirectory()) continue
            for (const m of await readDir(s, posix.join(root, y.filename))) {
              if (!MONTH.test(m.filename) || !m.attrs.isDirectory()) continue
              for (const f of await readDir(s, posix.join(root, y.filename, m.filename))) {
                const k = `mongo-manager/${y.filename}/${m.filename}/${f.filename}`
                // Only regular files of the layout: no part file, manifest, link or folder.
                if (!f.attrs.isFile() || !isSafeKey(k, '')) continue
                out.push({ key: k, size: f.attrs.size, modifiedAt: f.attrs.mtime * 1000, archived: false })
                if (out.length >= 2 * MAX_ITEMS) return out
              }
            }
          }
          return out
        }),
      )
      const items = found.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, MAX_ITEMS)
      const from = offsetOf(cursor)
      return {
        items: items.slice(from, from + PAGE),
        cursor: from + PAGE < items.length ? String(from + PAGE) : null,
      }
    },
    async remove(key, signal) {
      const path = full(key)
      await retry(signal, () =>
        withSession(signal, (s) =>
          call<void>((cb) => s.sftp.unlink(path, cb)).catch((e) => {
            if (codeOf(e) !== NO_SUCH_FILE) throw e
          }),
        ),
      )
    },
    async abandon(resume, signal) {
      const k = (resume as { key?: unknown }).key
      if (typeof k !== 'string' || !isSafeKey(k, '')) return
      const part = `${full(k)}.part`
      await withSession(signal, (s) =>
        call<void>((cb) => s.sftp.unlink(part, cb)).catch((e) => {
          if (codeOf(e) !== NO_SUCH_FILE) throw e
        }),
      )
    },
  }
  return adapter
}
