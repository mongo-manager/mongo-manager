// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import fs from 'node:fs'
import net from 'node:net'
import { join, posix } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import ssh2 from 'ssh2'
import { fingerprintOf } from '../../src/connections/ssh'
import { sshKeyPair } from './ssh-server'

const { Server, utils } = ssh2
const { STATUS_CODE } = utils.sftp

export interface TestSftpServer {
  port: number
  fingerprint: string
  root: string
  /** Bytes written through SFTP since the start. */
  readonly written: number
  /** Drops the session once this many more bytes have been written (an interrupted upload). */
  dropAfter: number | null
  /** Sessions opened since the start (the adapter reuses one while busy). */
  readonly sessions: number
  /** W4 review: reads are never answered (a server that stalls). */
  stallReads: boolean
  /** W4 review: the paths removed, and renamed over with posix-rename@openssh.com, since the start. */
  readonly removed: string[]
  readonly posixRenamed: string[]
  close(): Promise<void>
}

/**
 * W4.5: a real SSH server (ssh2) with an SFTP subsystem over a folder, as if chrooted to it: "/" and
 * "." are the folder, and no path leaves it. One user, "backup", with a password or a public key.
 */
export async function startSftpServer(opts: {
  root: string
  password?: string
  publicKey?: string
}): Promise<TestSftpServer> {
  const hostKey = sshKeyPair()
  const allowedKey = opts.publicKey ? utils.parseKey(opts.publicKey) : undefined
  const clients = new Set<{ end(): void }>()
  let written = 0
  let sessions = 0
  const state = { dropAfter: null as number | null, stallReads: false }
  const removed: string[] = []
  const posixRenamed: string[] = []

  const real = (p: string) => join(opts.root, posix.normalize(`/${p}`).replace(/^\/+/, ''))
  const attrsOf = (st: fs.Stats) => ({
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  })
  const codeOf = (e: unknown) =>
    (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? STATUS_CODE.NO_SUCH_FILE
      : (e as NodeJS.ErrnoException).code === 'EACCES'
        ? STATUS_CODE.PERMISSION_DENIED
        : STATUS_CODE.FAILURE

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'backup') return ctx.reject()
      if (ctx.method === 'password' && opts.password && ctx.password === opts.password) return ctx.accept()
      if (ctx.method === 'publickey' && allowedKey && !(allowedKey instanceof Error)) {
        const same =
          ctx.key.algo === allowedKey.type &&
          ctx.key.data.length === allowedKey.getPublicSSH().length &&
          timingSafeEqual(ctx.key.data, allowedKey.getPublicSSH())
        if (same && (!ctx.signature || allowedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true))
          return ctx.accept()
      }
      return ctx.reject(['password', 'publickey'])
    })
    client.on('ready', () => {
      sessions++
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<string, { fd?: number; dir?: string[]; path: string }>()
          let next = 0
          const handle = (h: { fd?: number; dir?: string[]; path: string }) => {
            const id = Buffer.alloc(4)
            id.writeUInt32BE(next++)
            handles.set(id.toString('hex'), h)
            return id
          }
          sftp.on('REALPATH', (id, p) => {
            const abs = posix.normalize(`/${p}`)
            sftp.name(id, [{ filename: abs, longname: abs, attrs: {} as never }])
          })
          sftp.on('OPEN', (id, p, flags) => {
            try {
              const mode = utils.sftp.flagsToString(flags) ?? 'r'
              sftp.handle(id, handle({ fd: fs.openSync(real(p), mode), path: real(p) }))
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          })
          sftp.on('WRITE', (id, h, offset, data) => {
            const f = handles.get(h.toString('hex'))
            if (f?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE)
            fs.writeSync(f.fd, data, 0, data.length, offset)
            written += data.length
            if (state.dropAfter !== null) {
              state.dropAfter -= data.length
              if (state.dropAfter <= 0) {
                state.dropAfter = null
                client.end()
                return
              }
            }
            sftp.status(id, STATUS_CODE.OK)
          })
          sftp.on('READ', (id, h, offset, len) => {
            if (state.stallReads) return
            const f = handles.get(h.toString('hex'))
            if (f?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(len)
            const n = fs.readSync(f.fd, buf, 0, len, offset)
            if (n === 0) return sftp.status(id, STATUS_CODE.EOF)
            sftp.data(id, buf.subarray(0, n))
          })
          sftp.on('CLOSE', (id, h) => {
            const f = handles.get(h.toString('hex'))
            if (f?.fd !== undefined) fs.closeSync(f.fd)
            handles.delete(h.toString('hex'))
            sftp.status(id, STATUS_CODE.OK)
          })
          const stat = (id: number, p: string, link: boolean) => {
            try {
              sftp.attrs(id, attrsOf(link ? fs.lstatSync(real(p)) : fs.statSync(real(p))))
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          }
          sftp.on('STAT', (id, p) => stat(id, p, false))
          sftp.on('LSTAT', (id, p) => stat(id, p, true))
          sftp.on('FSTAT', (id, h) => {
            const f = handles.get(h.toString('hex'))
            if (f?.fd === undefined) return sftp.status(id, STATUS_CODE.FAILURE)
            sftp.attrs(id, attrsOf(fs.fstatSync(f.fd)))
          })
          sftp.on('OPENDIR', (id, p) => {
            try {
              const dir = fs.readdirSync(real(p))
              sftp.handle(id, handle({ dir, path: real(p) }))
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          })
          sftp.on('READDIR', (id, h) => {
            const f = handles.get(h.toString('hex'))
            if (!f?.dir) return sftp.status(id, STATUS_CODE.FAILURE)
            if (!f.dir.length) return sftp.status(id, STATUS_CODE.EOF)
            const names = f.dir.splice(0, 50).map((n) => ({
              filename: n,
              longname: n,
              attrs: attrsOf(fs.lstatSync(join(f.path, n))),
            }))
            sftp.name(id, names)
          })
          sftp.on('MKDIR', (id, p) => {
            try {
              fs.mkdirSync(real(p))
              sftp.status(id, STATUS_CODE.OK)
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          })
          sftp.on('REMOVE', (id, p) => {
            removed.push(p)
            try {
              fs.unlinkSync(real(p))
              sftp.status(id, STATUS_CODE.OK)
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          })
          // posix-rename@openssh.com: a rename that replaces the target at once.
          sftp.on('EXTENDED', (id, name, data) => {
            if (name !== 'posix-rename@openssh.com' || !data)
              return sftp.status(id, STATUS_CODE.OP_UNSUPPORTED)
            const from = data.subarray(4, 4 + data.readUInt32BE(0)).toString('utf8')
            const rest = data.subarray(4 + data.readUInt32BE(0))
            const to = rest.subarray(4, 4 + rest.readUInt32BE(0)).toString('utf8')
            try {
              fs.renameSync(real(from), real(to))
              posixRenamed.push(to)
              sftp.status(id, STATUS_CODE.OK)
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          })
          sftp.on('RENAME', (id, from, to) => {
            // SFTP version 3: a rename never replaces a file.
            if (fs.existsSync(real(to))) return sftp.status(id, STATUS_CODE.FAILURE)
            try {
              fs.renameSync(real(from), real(to))
              sftp.status(id, STATUS_CODE.OK)
            } catch (e) {
              sftp.status(id, codeOf(e))
            }
          })
        })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const publicKey = utils.parseKey(hostKey.public)
  if (publicKey instanceof Error) throw publicKey
  return {
    port: (server.address() as net.AddressInfo).port,
    fingerprint: fingerprintOf(publicKey.getPublicSSH()),
    root: opts.root,
    get removed() {
      return removed
    },
    get posixRenamed() {
      return posixRenamed
    },
    get stallReads() {
      return state.stallReads
    },
    set stallReads(v: boolean) {
      state.stallReads = v
    },
    get written() {
      return written
    },
    get sessions() {
      return sessions
    },
    get dropAfter() {
      return state.dropAfter
    },
    set dropAfter(v: number | null) {
      state.dropAfter = v
    },
    close: () =>
      new Promise((resolve) => {
        for (const c of clients) c.end()
        server.close(() => resolve())
      }),
  }
}
