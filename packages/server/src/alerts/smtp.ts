// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import { isIP, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import { EgressError, scrubText, type SocketEgress } from '../net/egress'
import { trustedCa } from '../net/pem'

/**
 * W3.3: a minimal SMTP client for alert mail. No dependency (the repo takes none it can avoid, and a
 * mail library would dial on its own, past the egress guard): the socket comes from the egress
 * guard, TLS is required — from the start (465) or by STARTTLS, never a plaintext fallback — and the
 * password only ever travels inside TLS. Replies are bounded in size and time.
 */
export type SmtpReason =
  'connect' | 'tls' | 'starttls_missing' | 'auth' | 'auth_unsupported' | 'refused' | 'protocol' | 'timeout'

export class SmtpError extends Error {
  override name = 'SmtpError'
  constructor(
    readonly reason: SmtpReason,
    message: string,
  ) {
    super(message)
  }
}

export interface MailMessage {
  from: string
  to: string[]
  subject: string
  text: string
}

export interface SmtpRequest {
  host: string
  port: number
  security: 'starttls' | 'tls'
  username?: string | null
  password?: string | null
  message: MailMessage
  /** Tests trust their own CA besides the system's. */
  caPem?: string
  /** One reply's deadline (and the TLS handshake's). */
  replyMs?: number
  /** The whole session's deadline (W3 review I2). */
  deadlineMs?: number
  signal?: AbortSignal
}

const REPLY_LIMIT = 64 * 1024
/** W3 review (M5): lines in one reply (EHLO answers a few dozen at most). */
const REPLY_LINES = 100
/** Re-review (M5): complete replies waiting to be read (one is ever expected). */
const MAX_WAITING_REPLIES = 10
/** W3 review (I2): a whole session, connection to QUIT. */
const SESSION_MS = 120_000
const REPLY_MS = 30_000
/** An address as it may stand inside <…>: nothing that ends the command or starts another. */
const ADDRESS = /^[^\s<>()",;:\\[\]@]+@[A-Za-z0-9.-]+$/

interface Reply {
  code: number
  lines: string[]
}

/** Reads replies off a socket: "250-…" lines continue, "250 …" ends one. */
class Replies {
  private buffer = ''
  private queue: Reply[] = []
  private current: string[] = []
  private waiter: { resolve(r: Reply): void; reject(e: Error): void } | null = null
  private failure: Error | null = null
  private socket: Socket | TLSSocket
  private readonly onData = (chunk: Buffer) => this.push(chunk.toString('utf8'))
  private readonly onError = (e: Error) =>
    this.fail(
      new SmtpError(
        'connect',
        `The mail server connection failed (${(e as NodeJS.ErrnoException).code ?? 'error'})`,
      ),
    )
  private readonly onClose = () =>
    this.fail(new SmtpError('protocol', 'The mail server closed the connection'))

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket
    this.attach(socket)
  }

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
  }

  private push(text: string): void {
    this.buffer += text
    if (this.buffer.length > REPLY_LIMIT)
      return this.fail(new SmtpError('protocol', 'The mail server sent too long a reply'))
    let at: number
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '')
      this.buffer = this.buffer.slice(at + 1)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) return this.fail(new SmtpError('protocol', 'The mail server sent something that is not SMTP'))
      this.current.push(m[3]!)
      if (this.current.length > REPLY_LINES)
        return this.fail(new SmtpError('protocol', 'The mail server sent too many lines in one reply'))
      if (m[2] === ' ') {
        const reply = { code: Number(m[1]), lines: this.current }
        this.current = []
        if (this.waiter) {
          const w = this.waiter
          this.waiter = null
          w.resolve(reply)
        } else {
          // Re-review (M5): the client pipelines nothing, so more than a few replies waiting are
          // ones nobody asked for: refused, not kept.
          if (this.queue.length >= MAX_WAITING_REPLIES)
            return this.fail(new SmtpError('protocol', 'The mail server sent replies nobody asked for'))
          this.queue.push(reply)
        }
      }
    }
  }

  private fail(e: Error): void {
    this.failure ??= e
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.reject(e)
    }
  }

  next(ms: number): Promise<Reply> {
    // A broken session answers nothing more, even replies read before it broke.
    if (this.failure) return Promise.reject(this.failure)
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new SmtpError('timeout', 'The mail server did not answer in time'))
      }, ms)
      this.waiter = {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
    })
  }
}

const shortText = (r: Reply) => scrubText(`${r.code} ${r.lines.join(' ')}`).slice(0, 200)

/** A header value on one line: control characters (CR and LF first) never reach the header. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g
function headerText(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').trim().slice(0, 900)
}

/**
 * RFC 2047 when the text is not plain ASCII: encoded-words within its 75 characters — 39 bytes of
 * UTF-8, 64 characters, so "Subject: " and the first fit a line — never splitting a character,
 * one per folded line (W3 review M6).
 */
function encodeHeader(value: string): string {
  const text = headerText(value)
  if (/^[ -~]*$/.test(text)) return text
  const words: string[] = []
  let chunk = ''
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 39) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

/** A list of addresses folded so no header line passes 78 characters (W3 review M6). */
function foldAddresses(name: string, addresses: readonly string[]): string {
  const lines: string[] = []
  let line = `${name}:`
  addresses.map(headerText).forEach((a, i) => {
    const piece = `${i === 0 ? ' ' : ''}${a}${i < addresses.length - 1 ? ',' : ''}`
    if (line.length + piece.length + 1 > 78 && i > 0) {
      lines.push(line)
      line = ` ${piece.trimStart()}`
    } else line += i === 0 ? piece : ` ${piece}`
  })
  lines.push(line)
  return lines.join('\r\n')
}

/** The whole message: headers, then the text as base64 (no line can start a dot or end the data). */
export function buildMessage(m: MailMessage, now = new Date()): string {
  const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')
  const lines = body.match(/.{1,76}/g) ?? []
  const domain = m.from.slice(m.from.indexOf('@') + 1)
  return [
    `From: ${headerText(m.from)}`,
    foldAddresses('To', m.to),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${headerText(domain)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    ...lines,
  ].join('\r\n')
}

/** W3 review (I2): the handshake ends within `ms`, or the socket is destroyed and it fails. */
function upgrade(socket: Socket, host: string, caPem: string | undefined, ms: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secure.destroy()
      socket.destroy()
      reject(new SmtpError('timeout', 'The mail server did not finish the TLS handshake in time'))
    }, ms)
    const ca = trustedCa(caPem)
    const secure = connectTls({
      socket,
      minVersion: 'TLSv1.2',
      ...(isIP(host) === 0 ? { servername: host } : {}),
      ...(ca ? { ca } : {}),
    })
    const fail = (e: Error) => {
      clearTimeout(timer)
      secure.destroy()
      reject(
        new SmtpError(
          'tls',
          `The mail server's certificate is not trusted (${(e as NodeJS.ErrnoException).code ?? 'tls'})`,
        ),
      )
    }
    secure.once('error', fail)
    secure.once('secureConnect', () => {
      clearTimeout(timer)
      secure.off('error', fail)
      resolve(secure)
    })
  })
}

/** Sends one message, or throws an SmtpError saying why (never with the password in it). */
export async function sendMail(egress: SocketEgress, r: SmtpRequest): Promise<void> {
  const { message } = r
  for (const address of [message.from, ...message.to])
    if (!ADDRESS.test(address)) throw new SmtpError('protocol', 'An address is not a plain e-mail address')
  if (message.to.length === 0) throw new SmtpError('protocol', 'No recipients')
  const replyMs = r.replyMs ?? REPLY_MS
  let raw: Socket
  try {
    raw = await egress.socket({ host: r.host, port: r.port, ...(r.signal ? { signal: r.signal } : {}) })
  } catch (e) {
    if (e instanceof EgressError) throw new SmtpError('connect', e.message)
    throw e
  }
  let socket: Socket | TLSSocket = raw
  let replies: Replies | null = null
  // W3 review (I2): the whole session has a deadline; past it every socket goes.
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SmtpError('timeout', 'The mail server took too long'))
      socket.destroy()
      raw.destroy()
    }, r.deadlineMs ?? SESSION_MS)
  })
  expired.catch(() => undefined)
  const session = async (): Promise<void> => {
    if (r.security === 'tls') socket = await upgrade(raw, r.host, r.caPem, replyMs)
    replies = new Replies(socket)
    const write = (line: string) => socket.write(`${line}\r\n`)
    const expect = async (codes: number[], reason: SmtpReason = 'refused'): Promise<Reply> => {
      const reply = await replies!.next(replyMs)
      if (!codes.includes(reply.code))
        throw new SmtpError(reason, `The mail server refused: ${shortText(reply)}`)
      return reply
    }
    await expect([220])
    const helo = 'mongo-manager.local'
    write(`EHLO ${helo}`)
    let caps = await expect([250])
    if (r.security === 'starttls') {
      if (!caps.lines.some((l) => /^STARTTLS\b/i.test(l)))
        throw new SmtpError(
          'starttls_missing',
          'The mail server does not offer STARTTLS; nothing was sent in the clear',
        )
      write('STARTTLS')
      await expect([220])
      replies.detach()
      socket = await upgrade(raw, r.host, r.caPem, replyMs)
      replies = new Replies(socket)
      write(`EHLO ${helo}`)
      caps = await expect([250])
    }
    if (r.username) {
      const auth = caps.lines.find((l) => /^AUTH[ =]/i.test(l)) ?? ''
      const mechs = new Set(auth.slice(5).toUpperCase().split(/\s+/))
      const password = r.password ?? ''
      if (mechs.has('PLAIN')) {
        write(`AUTH PLAIN ${Buffer.from(`\0${r.username}\0${password}`, 'utf8').toString('base64')}`)
        await expect([235], 'auth')
      } else if (mechs.has('LOGIN')) {
        write('AUTH LOGIN')
        await expect([334], 'auth')
        write(Buffer.from(r.username, 'utf8').toString('base64'))
        await expect([334], 'auth')
        write(Buffer.from(password, 'utf8').toString('base64'))
        await expect([235], 'auth')
      } else
        throw new SmtpError(
          'auth_unsupported',
          'The mail server offers no sign-in method Mongo Manager speaks (PLAIN, LOGIN)',
        )
    }
    write(`MAIL FROM:<${message.from}>`)
    await expect([250])
    for (const to of message.to) {
      write(`RCPT TO:<${to}>`)
      await expect([250, 251])
    }
    write('DATA')
    await expect([354])
    socket.write(`${buildMessage(message)}\r\n.\r\n`)
    await expect([250])
    write('QUIT')
    await replies.next(5_000).catch(() => undefined)
  }
  try {
    await Promise.race([session(), expired])
  } finally {
    clearTimeout(timer)
    ;(replies as Replies | null)?.detach()
    socket.destroy()
    raw.destroy()
  }
}
