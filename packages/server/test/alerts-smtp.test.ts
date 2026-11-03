import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type AddressInfo } from 'node:net'
import { createEgress } from '../src/net/egress'
import { SmtpError, buildMessage, sendMail, type MailMessage } from '../src/alerts/smtp'
import { startFakeSmtp, type FakeSmtp } from './support/fake-smtp'
import { pastedBundle } from './support/tls'

/**
 * W3.3: the mail channel's SMTP client (no dependency: the repo's rules want no new packages, and
 * every connection must go through the egress guard). Threat model: credentials sent in the clear
 * (no STARTTLS, a downgrade), an untrusted certificate, header injection through a subject or a
 * name, the password showing in an error.
 */
const servers: FakeSmtp[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

const egress = createEgress({ networks: ['127.0.0.1/32'] })
const PASSWORD = 'smtp-Secret-pass-42'
const message: MailMessage = {
  from: 'alerts@example.com',
  to: ['ops@example.com', 'dba@example.com'],
  subject: 'Firing: connections above 500 on Prod',
  text: 'Connections: 812 (threshold 500)\n.\nA line that starts with a dot above.\nŞükrü çalıştı.',
}

async function server(opts: Parameters<typeof startFakeSmtp>[0] = {}) {
  const s = await startFakeSmtp({ user: 'mailer', password: PASSWORD, ...opts })
  servers.push(s)
  return s
}

const decode = (data: string) => {
  const [head, ...rest] = data.split('\r\n\r\n')
  return {
    head: head!,
    body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8'),
  }
}

describe('SMTP (W3.3)', () => {
  it('upgrades with STARTTLS before signing in, and delivers to every recipient', async () => {
    const s = await server()
    await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: PASSWORD,
      caPem: s.caPem,
      message,
    })
    expect(s.mails).toHaveLength(1)
    const mail = s.mails[0]!
    expect(mail).toMatchObject({ from: 'alerts@example.com', to: message.to, tls: true, user: 'mailer' })
    const { head, body } = decode(mail.data)
    expect(head).toContain('Subject: Firing: connections above 500 on Prod')
    expect(head).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m)
    expect(body).toBe(message.text.replace(/\n/g, '\r\n'))
    // Nothing but EHLO and STARTTLS went out before TLS.
    const clear = s.lines.filter((l) => !l.tls).map((l) => l.line.split(' ')[0])
    expect(clear).toEqual(['EHLO', 'STARTTLS'])
  })

  it('speaks TLS from the start on an implicit-TLS port, with AUTH LOGIN when that is all there is', async () => {
    const s = await server({ implicitTls: true, authMechs: 'LOGIN' })
    await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'tls',
      username: 'mailer',
      password: PASSWORD,
      caPem: s.caPem,
      message,
    })
    expect(s.mails[0]).toMatchObject({ tls: true, user: 'mailer' })
  })

  // Review 2026-10-17 (minor 1): the mail server's CA pasted after another, with no line between.
  it('trusts every CA of a bundle pasted with its blocks run together', async () => {
    const s = await server()
    await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: PASSWORD,
      caPem: await pastedBundle(s.caPem),
      message,
    })
    expect(s.mails[0]).toMatchObject({ tls: true, user: 'mailer' })
  })

  it('refuses a server that offers no STARTTLS: nothing is sent in the clear', async () => {
    const s = await server({ startTls: false })
    const err = await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: PASSWORD,
      caPem: s.caPem,
      message,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SmtpError)
    expect((err as SmtpError).reason).toBe('starttls_missing')
    expect(s.lines.map((l) => l.line.split(' ')[0])).not.toContain('AUTH')
    expect(s.mails).toHaveLength(0)
    expect(JSON.stringify(s.lines)).not.toContain(Buffer.from(PASSWORD).toString('base64'))
  })

  it('refuses an untrusted certificate', async () => {
    const s = await server()
    const err = await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: PASSWORD,
      message,
    }).catch((e: unknown) => e)
    expect((err as SmtpError).reason).toBe('tls')
    expect(s.lines.some((l) => l.tls)).toBe(false)
  })

  it('says a refused sign-in without the password', async () => {
    const s = await server()
    const err = await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: 'wrong-password',
      caPem: s.caPem,
      message,
    }).catch((e: unknown) => e)
    expect((err as SmtpError).reason).toBe('auth')
    expect((err as SmtpError).message).toMatch(/535/)
    expect((err as SmtpError).message).not.toContain('wrong-password')
  })

  it('keeps a subject on one header line (no injected headers)', async () => {
    const s = await server()
    await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: PASSWORD,
      caPem: s.caPem,
      message: { ...message, subject: 'Hi\r\nBcc: victim@example.com\r\n\r\nInjected body' },
    })
    const { head } = decode(s.mails[0]!.data)
    expect(head).not.toMatch(/^Bcc:/m)
    expect(head.split('\r\n').filter((l) => l.startsWith('Subject:'))).toHaveLength(1)
    // A recipient with a line break never reaches the server.
    const bad = await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      caPem: s.caPem,
      username: 'mailer',
      password: PASSWORD,
      message: { ...message, to: ['ops@example.com>\r\nRCPT TO:<evil@example.com'] },
    }).catch((e: unknown) => e)
    expect((bad as SmtpError).reason).toBe('protocol')
    expect(s.lines.some((l) => l.line.includes('evil@example.com'))).toBe(false)
  })

  it('builds headers that hold no line breaks, whatever reaches them', () => {
    const built = buildMessage({
      from: 'a@example.com\r\nBcc: x@example.com',
      to: ['b@example.com\nX-Evil: 1'],
      subject: 'plain',
      text: 'body',
    })
    const head = built.split('\r\n\r\n')[0]!
    expect(head).not.toMatch(/^(Bcc|X-Evil):/m)
  })

  // W3 review (I2): a server that never finishes the TLS handshake holds nothing for ever.
  it('gives up on a TLS handshake that stalls, implicit or after STARTTLS, and on a session past its deadline', async () => {
    const stalled = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => undefined)
      let buf = ''
      socket.on('data', (d) => {
        buf += String(d)
        if (buf.includes('EHLO')) {
          buf = ''
          socket.write('250-mail.test\r\n250 STARTTLS\r\n')
        } else if (buf.includes('STARTTLS')) {
          buf = ''
          // Says go ahead, then never speaks TLS.
          socket.write('220 go ahead\r\n')
        }
      })
      if (mode === 'starttls') socket.write('220 mail.test ESMTP\r\n')
    })
    const sockets = new Set<import('node:net').Socket>()
    let mode: 'tls' | 'starttls' = 'tls'
    await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', r))
    const port = (stalled.address() as AddressInfo).port
    try {
      const started = Date.now()
      const implicit = await sendMail(egress, {
        host: '127.0.0.1',
        port,
        security: 'tls',
        message,
        replyMs: 300,
      }).catch((e: unknown) => e)
      expect((implicit as SmtpError).reason).toBe('timeout')
      mode = 'starttls'
      const upgrade = await sendMail(egress, {
        host: '127.0.0.1',
        port,
        security: 'starttls',
        message,
        replyMs: 300,
      }).catch((e: unknown) => e)
      expect((upgrade as SmtpError).reason).toBe('timeout')
      // The whole session too: each reply in time, the whole too long.
      const whole = await sendMail(egress, {
        host: '127.0.0.1',
        port,
        security: 'starttls',
        message,
        replyMs: 10_000,
        deadlineMs: 400,
      }).catch((e: unknown) => e)
      expect((whole as SmtpError).reason).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(5_000)
      // Every socket the client opened is closed again.
      await new Promise((r) => setTimeout(r, 100))
      expect([...sockets].every((s) => s.destroyed || s.readableEnded)).toBe(true)
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => stalled.close(() => r()))
    }
  })

  // W3 review (M5): a reply of endless continuation lines is cut short.
  // Re-review (M5 remainder): replies nobody asked for are not kept piling up.
  it('refuses a stream of replies it did not ask for', async () => {
    const open = new Set<import('node:net').Socket>()
    const flood = createServer((socket) => {
      open.add(socket)
      socket.on('error', () => undefined)
      socket.write(`220 hello\r\n${'250 ok\r\n'.repeat(50)}`)
    })
    await new Promise<void>((r) => flood.listen(0, '127.0.0.1', r))
    try {
      const err = await sendMail(egress, {
        host: '127.0.0.1',
        port: (flood.address() as AddressInfo).port,
        security: 'starttls',
        message,
        replyMs: 2_000,
      }).catch((e: unknown) => e)
      expect((err as SmtpError).reason).toBe('protocol')
    } finally {
      for (const s of open) s.destroy()
      await new Promise<void>((r) => flood.close(() => r()))
    }
  })

  it('refuses a reply with too many lines', async () => {
    const chatty = createServer((socket) => {
      socket.on('error', () => undefined)
      socket.write(`${'220-hello\r\n'.repeat(500)}220 done\r\n`)
    })
    await new Promise<void>((r) => chatty.listen(0, '127.0.0.1', r))
    try {
      const err = await sendMail(egress, {
        host: '127.0.0.1',
        port: (chatty.address() as AddressInfo).port,
        security: 'starttls',
        message,
        replyMs: 2_000,
      }).catch((e: unknown) => e)
      expect((err as SmtpError).reason).toBe('protocol')
    } finally {
      await new Promise<void>((r) => chatty.close(() => r()))
    }
  })

  // W3 review (M6): headers stay within the line limits.
  it('folds a long To: and splits a long encoded subject into words of at most 75 characters', () => {
    const subject = 'Uyarı: '.repeat(40) + 'ş'
    const to = Array.from({ length: 20 }, (_, i) => `operations-team-${i}@example.com`)
    const built = buildMessage({ from: 'a@example.com', to, subject, text: 'x' })
    const head = built.split('\r\n\r\n')[0]!
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
    const subjectLines = head.slice(head.indexOf('Subject:')).split('\r\n')
    const words = [...head.matchAll(/=\?UTF-8\?B\?[^?]+\?=/g)].map((m) => m[0])
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75)
    expect(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')).toBe(subject)
    expect(subjectLines.length).toBeGreaterThan(1)
    // Every recipient is still there, unfolded.
    const unfolded = head.replace(/\r\n /g, ' ')
    for (const r of to) expect(unfolded).toContain(r)
  })

  it('encodes a non-ASCII subject', async () => {
    const s = await server()
    await sendMail(egress, {
      host: '127.0.0.1',
      port: s.port,
      security: 'starttls',
      username: 'mailer',
      password: PASSWORD,
      caPem: s.caPem,
      message: { ...message, subject: 'Uyarı: bağlantı sayısı yüksek' },
    })
    const { head } = decode(s.mails[0]!.data)
    const encoded = /^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m.exec(head)![1]!
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Uyarı: bağlantı sayısı yüksek')
  })
})
