// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createServer, type Server, type Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { certificates } from './https-server'

export interface ReceivedMail {
  from: string
  to: string[]
  data: string
  /** Whether the session was encrypted when the message was sent. */
  tls: boolean
  user: string | null
}

export interface FakeSmtp {
  port: number
  caPem: string
  /** Every line the client sent, in order, with whether it came over TLS. */
  lines: Array<{ line: string; tls: boolean }>
  mails: ReceivedMail[]
  close(): Promise<void>
}

/**
 * W3.3: a small SMTP server on 127.0.0.1 for the mail channel's tests: STARTTLS or TLS from the
 * start, AUTH PLAIN and LOGIN against one account, and the messages it took.
 */
export async function startFakeSmtp(
  opts: {
    implicitTls?: boolean
    startTls?: boolean
    user?: string
    password?: string
    authMechs?: string
  } = {},
): Promise<FakeSmtp> {
  const { caPem, key, cert } = await certificates()
  const lines: FakeSmtp['lines'] = []
  const mails: ReceivedMail[] = []
  const sockets = new Set<Socket>()
  const offerStartTls = opts.startTls ?? true
  const handle = (raw: Socket) => {
    sockets.add(raw)
    raw.on('close', () => sockets.delete(raw))
    let socket: Socket = raw
    let tls = false
    let buffer = ''
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' = 'cmd'
    let mail: ReceivedMail | null = null
    let user: string | null = null
    let loginUser = ''
    const say = (text: string) => socket.write(`${text}\r\n`)
    const onLine = (line: string) => {
      lines.push({ line, tls })
      if (mode === 'data') {
        if (line === '.') {
          mails.push(mail!)
          mail = null
          mode = 'cmd'
          return say('250 2.0.0 queued')
        }
        mail!.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`
        return
      }
      if (mode === 'login-user') {
        loginUser = Buffer.from(line, 'base64').toString()
        mode = 'login-pass'
        return say('334 UGFzc3dvcmQ6')
      }
      if (mode === 'login-pass') {
        mode = 'cmd'
        const pass = Buffer.from(line, 'base64').toString()
        if (loginUser === opts.user && pass === opts.password) {
          user = loginUser
          return say('235 2.7.0 ok')
        }
        return say('535 5.7.8 Authentication credentials invalid')
      }
      const verb = line.split(' ')[0]!.toUpperCase()
      if (verb === 'EHLO') {
        const caps = ['250-mail.test', ...(!tls && offerStartTls ? ['250-STARTTLS'] : [])]
        if (tls || !offerStartTls) caps.push(`250-AUTH ${opts.authMechs ?? 'PLAIN LOGIN'}`)
        caps.push('250 SIZE 1000000')
        return socket.write(`${caps.join('\r\n')}\r\n`)
      }
      if (verb === 'STARTTLS') {
        say('220 2.0.0 ready')
        socket.removeAllListeners('data')
        const secure = new TLSSocket(socket, { isServer: true, key, cert })
        socket = secure
        tls = true
        buffer = ''
        secure.on('data', onData)
        secure.on('error', () => undefined)
        return
      }
      if (verb === 'AUTH') {
        const [, mech, arg] = line.split(' ')
        if (mech?.toUpperCase() === 'PLAIN') {
          const [, u, p] = Buffer.from(arg ?? '', 'base64')
            .toString()
            .split('\0')
          if (u === opts.user && p === opts.password) {
            user = u ?? null
            return say('235 2.7.0 ok')
          }
          return say('535 5.7.8 Authentication credentials invalid')
        }
        if (mech?.toUpperCase() === 'LOGIN') {
          mode = 'login-user'
          return say('334 VXNlcm5hbWU6')
        }
        return say('504 unknown mechanism')
      }
      if (verb === 'MAIL') {
        if (opts.user && !user) return say('530 5.7.0 Authentication required')
        mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? '', to: [], data: '', tls, user }
        return say('250 2.1.0 ok')
      }
      if (verb === 'RCPT') {
        mail?.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
        return say('250 2.1.5 ok')
      }
      if (verb === 'DATA') {
        mode = 'data'
        return say('354 go ahead')
      }
      if (verb === 'QUIT') {
        say('221 bye')
        return socket.end()
      }
      return say('502 not implemented')
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        onLine(line)
      }
    }
    if (opts.implicitTls) {
      const secure = new TLSSocket(raw, { isServer: true, key, cert })
      socket = secure
      tls = true
      secure.on('error', () => undefined)
      secure.on('data', onData)
      secure.once('secure', () => say('220 mail.test ESMTP'))
    } else {
      raw.on('data', onData)
      say('220 mail.test ESMTP')
    }
    raw.on('error', () => undefined)
  }
  const server: Server = createServer(handle)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    caPem,
    lines,
    mails,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
}
