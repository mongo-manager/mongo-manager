// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditAction } from '@mongo-manager/shared'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireAuth } from '../src/http/guards'
import { requestForLog } from '../src/http/app'
import { resolveConfig } from '../src/config'
import { Errors } from '../src/errors'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Security audit 2026-10-16 (Important 1): a request's body is never read for someone who may not
 * send it, and a body that trickles in (or never arrives) does not hold a connection open.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function serve(extra: Parameters<typeof makeApp>[1] = {}) {
  const t = await makeApp({ auth: true }, extra)
  apps.push(t)
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
  const port = Number(new URL(address).port)
  const { ctx } = t.app
  const as = (role: 'admin' | 'viewer') => {
    const user = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    const { sessionId, session } = ctx.sessions.create(user.id, {})
    return { cookie: `mm_sid=${sessionId}`, csrf: session.csrfToken }
  }
  return { t, port, as }
}

interface Raw {
  socket: Socket
  /** Everything the server sent, once it answered or closed. */
  answer: (ms: number) => Promise<string>
  closed: Promise<void>
}

/** Sends a request's head (and the start of its body) by hand; the rest of the body never comes. */
function rawRequest(port: number, head: string[], body = ''): Raw {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  let received = ''
  socket.on('data', (d) => (received += String(d)))
  const closed = new Promise<void>((r) => socket.on('close', () => r()))
  socket.write(`${head.join('\r\n')}\r\n\r\n${body}`)
  const answer = async (ms: number) => {
    const until = Date.now() + ms
    while (!received.includes('\r\n\r\n') && Date.now() < until && !socket.destroyed)
      await new Promise((r) => setTimeout(r, 20))
    return received
  }
  return { socket, answer, closed }
}

const FIVE_MIB = 5 * 1024 * 1024

describe('security audit 2026-10-16: no body is read before the caller is allowed to send it', () => {
  it('refuses an anonymous plugin upload at once, without waiting for its 5 MiB', async () => {
    const { port } = await serve()
    const raw = rawRequest(port, [
      'PUT /api/plugins HTTP/1.1',
      `Host: ${H.host}`,
      'Content-Type: application/gzip',
      `Content-Length: ${FIVE_MIB}`,
    ])
    const answer = await raw.answer(2_000)
    raw.socket.destroy()
    expect(answer).toMatch(/^HTTP\/1\.1 401/)
  })

  it('refuses a viewer’s plugin upload at once, before its body', async () => {
    const { port, as } = await serve()
    const viewer = as('viewer')
    const raw = rawRequest(port, [
      'PUT /api/plugins HTTP/1.1',
      `Host: ${H.host}`,
      `Origin: ${H.origin}`,
      `Cookie: ${viewer.cookie}`,
      `X-CSRF-Token: ${viewer.csrf}`,
      'Content-Type: application/gzip',
      `Content-Length: ${FIVE_MIB}`,
    ])
    const answer = await raw.answer(2_000)
    raw.socket.destroy()
    expect(answer).toMatch(/^HTTP\/1\.1 403/)
  })

  // Independent review (minor): every API route but sign-in's refuses someone not signed in on the
  // request's head — not after parsing up to 1 MiB of JSON.
  it('refuses an anonymous JSON request at once, sign-in routes excepted', async () => {
    const { port } = await serve()
    for (const line of ['POST /api/connections HTTP/1.1', 'PUT /api/me/dashboard HTTP/1.1']) {
      const raw = rawRequest(port, [
        line,
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        'Content-Type: application/json',
        'Content-Length: 900000',
      ])
      const answer = await raw.answer(2_000)
      raw.socket.destroy()
      expect(answer, line).toMatch(/^HTTP\/1\.1 401/)
    }
    // Sign-in reads its body (it cannot know who is asking before).
    const login = rawRequest(port, [
      'POST /api/auth/login HTTP/1.1',
      `Host: ${H.host}`,
      `Origin: ${H.origin}`,
      'Content-Type: application/json',
      'Content-Length: 50',
    ])
    expect(await login.answer(500)).toBe('')
    login.socket.destroy()
  })

  it('reads an archive on no other plugin route (the parser is the upload’s alone)', async () => {
    const { port } = await serve()
    for (const line of ['POST /api/plugins/scan HTTP/1.1', 'PUT /api/plugins/hello/settings HTTP/1.1']) {
      const raw = rawRequest(port, [
        line,
        `Host: ${H.host}`,
        'Content-Type: application/octet-stream',
        `Content-Length: ${FIVE_MIB}`,
      ])
      const answer = await raw.answer(2_000)
      raw.socket.destroy()
      expect(answer).toMatch(/^HTTP\/1\.1 4(01|15)/)
    }
  })
})

describe('security audit 2026-10-16 (minor): the request log holds no query values', () => {
  it('logs the path and the query’s names, never its values (searches, file names, tickets)', () => {
    const req = (url: string) =>
      requestForLog({ method: 'GET', url, host: 'h', ip: '127.0.0.1', socket: { remotePort: 1 } } as never)
    expect(req('/api/ai/history?q=ceo%40corp.example&limit=5').url).toBe('/api/ai/history?q=***&limit=***')
    expect(req('/api/connections/c/library?q=secret').url).toBe('/api/connections/c/library?q=***')
    expect(req('/api/healthz').url).toBe('/api/healthz')
    expect(req('/plugin-frame/TICKET/index.html?x=1').url).toBe('/plugin-frame/***/index.html?x=***')
    // A malformed or bare query is still not shown.
    expect(req('/api/x?just-a-value').url).toBe('/api/x?***')
  })

  // Independent review (minor): a GridFS file id (any _id: an email, a file name) is a path part.
  it('logs no identifying path part: a file id or a document id', () => {
    const req = (url: string, params: Record<string, string>) =>
      requestForLog({ method: 'GET', url, params, host: 'h', ip: '127.0.0.1', socket: {} } as never)
    expect(
      req('/api/connections/c1/databases/shop/gridfs/fs/files/ceo%40corp.example/download?x=1', {
        id: 'c1',
        db: 'shop',
        bucket: 'fs',
        fileId: 'ceo@corp.example',
      }).url,
    ).toBe('/api/connections/c1/databases/shop/gridfs/fs/files/***/download?x=***')
    expect(
      req('/api/connections/c1/databases/shop/collections/people/documents/a%2Fb', { docId: 'a/b' }).url,
    ).toBe('/api/connections/c1/databases/shop/collections/people/documents/***')
  })
})

describe('security audit 2026-10-16: a body that does not arrive does not hold the connection', () => {
  it('closes an anonymous request whose body trickles past its deadline', async () => {
    const { port } = await serve({ http: { anonymousBodyMs: 300, bodyIdleMs: 5_000 } })
    const raw = rawRequest(
      port,
      [
        'POST /api/auth/login HTTP/1.1',
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        'Content-Type: application/json',
        'Content-Length: 1000',
      ],
      '{"user',
    )
    // A byte every 100 ms: never idle, but never done either.
    const drip = setInterval(() => raw.socket.writable && raw.socket.write(' '), 100)
    const closedInTime = await Promise.race([
      raw.closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
    ])
    clearInterval(drip)
    raw.socket.destroy()
    expect(closedInTime).toBe(true)
  })

  it('closes a signed-in request whose body stops arriving', async () => {
    const { port, as } = await serve({ http: { bodyIdleMs: 300 } })
    const admin = as('admin')
    const raw = rawRequest(
      port,
      [
        'PUT /api/plugins HTTP/1.1',
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        `Cookie: ${admin.cookie}`,
        `X-CSRF-Token: ${admin.csrf}`,
        'Content-Type: application/gzip',
        'Content-Length: 1000',
      ],
      'abc',
    )
    const closedInTime = await Promise.race([
      raw.closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
    ])
    raw.socket.destroy()
    expect(closedInTime).toBe(true)
  })

  it('lets a signed-in upload stream past the in-memory deadline while bytes keep coming', async () => {
    const t = await makeApp({ auth: true }, { http: { bodyMs: 300, bodyIdleMs: 2_000 } })
    apps.push(t)
    // Two routes alike but for streamBody: an upload streamed to disk, and a body read in memory.
    await t.app.register(async (scope) => {
      scope.addContentTypeParser('application/octet-stream', (_r, payload, done) => done(null, payload))
      for (const [url, config] of [
        ['/api/test-stream', { streamBody: true as const }],
        ['/api/test-buffer', {}],
      ] as const)
        scope.put(url, { preHandler: requireAuth, config }, async (request) => {
          let n = 0
          for await (const piece of request.body as AsyncIterable<Buffer>) n += piece.length
          return { n }
        })
    })
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const user = t.app.ctx.users.create({ username: 'streamer', passwordHash: 'x', role: 'admin' })
    const { sessionId, session } = t.app.ctx.sessions.create(user.id, {})
    const drip = async (url: string) => {
      const raw = rawRequest(port, [
        `PUT ${url} HTTP/1.1`,
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        `Cookie: mm_sid=${sessionId}`,
        `X-CSRF-Token: ${session.csrfToken}`,
        'Content-Type: application/octet-stream',
        'Content-Length: 10',
      ])
      for (let i = 0; i < 10 && !raw.socket.destroyed; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if (raw.socket.writable) raw.socket.write('x')
      }
      const answer = await raw.answer(1_000)
      raw.socket.destroy()
      return answer
    }
    expect(await drip('/api/test-stream')).toMatch(/^HTTP\/1\.1 200[\s\S]*"n":10/)
    expect(await drip('/api/test-buffer')).toBe('')
  })

  // Independent review (minor): a streamed upload the server itself holds back (a GridFS chunk being
  // written, a cold connect) is not a client gone idle.
  it('does not close a streamed upload while the server holds it back', async () => {
    const t = await makeApp({}, { http: { bodyIdleMs: 300 } })
    apps.push(t)
    await t.app.register(async (scope) => {
      scope.addContentTypeParser('application/octet-stream', (_r, payload, done) => done(null, payload))
      scope.put('/api/test-held', { config: { streamBody: true } }, async (request) => {
        const body = request.body as NodeJS.ReadableStream & { pause(): void; resume(): void }
        let n = 0
        let held = false
        await new Promise<void>((resolve, reject) => {
          body.on('data', (piece: Buffer) => {
            n += piece.length
            if (held) return
            held = true
            body.pause()
            setTimeout(() => body.resume(), 1_200)
          })
          body.on('end', () => resolve())
          body.on('error', reject)
        })
        return { n }
      })
    })
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const big = 'x'.repeat(2 * 1024 * 1024)
    const raw = rawRequest(
      port,
      [
        'PUT /api/test-held HTTP/1.1',
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        `X-CSRF-Token: ${t.app.ctx.localCsrfToken}`,
        `Cookie: ${H.cookie}`,
        `X-MM-Local: ${H['x-mm-local']}`,
        'Content-Type: application/octet-stream',
        `Content-Length: ${big.length}`,
      ],
      big,
    )
    const answer = await raw.answer(5_000)
    raw.socket.destroy()
    expect(answer).toMatch(/^HTTP\/1\.1 200/)
  })

  // Independent review (I1): a $out or a bulk update works silently for minutes; the socket's idle
  // timeout must not cut it, and a request whose answer never went out is still audited and released.
  it('answers a handler that works silently past the idle timeout', async () => {
    const t = await makeApp({}, { http: { connectionTimeoutMs: 300 } })
    apps.push(t)
    t.app.get('/api/test-silent', async () => {
      await new Promise((r) => setTimeout(r, 1_000))
      return { ok: true }
    })
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const res = await fetch(new URL('/api/test-silent', address), {
      headers: { host: H.host, cookie: H.cookie, 'x-mm-local': H['x-mm-local'] },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // An idle keep-alive socket is still closed: the timeout is back once the answer went out.
    const port = Number(new URL(address).port)
    const silent = connect(port, '127.0.0.1')
    silent.on('error', () => undefined)
    const closed = await Promise.race([
      new Promise<boolean>((r) => silent.on('close', () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
    ])
    expect(closed).toBe(true)
  })

  it('audits and releases a request whose client left before the answer', async () => {
    const t = await makeApp({})
    apps.push(t)
    let released = 0
    let finished!: () => void
    const done = new Promise<void>((r) => (finished = r))
    t.app.post('/api/test-audited', { config: { audit: 'test.left' as AuditAction } }, async (request) => {
      request.releases = [() => void released++]
      request.auditInfo = { details: { what: 'long write' } }
      await new Promise((r) => setTimeout(r, 600))
      finished()
      return { ok: true }
    })
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const raw = rawRequest(
      port,
      [
        'POST /api/test-audited HTTP/1.1',
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        'Content-Type: application/json',
        'Content-Length: 2',
        `X-CSRF-Token: ${t.app.ctx.localCsrfToken}`,
        `Cookie: ${H.cookie}`,
        `X-MM-Local: ${H['x-mm-local']}`,
      ],
      '{}',
    )
    await new Promise((r) => setTimeout(r, 150))
    raw.socket.destroy()
    // Second review (N1): a confirmed write outlives its closed tab — its connection hold with it,
    // or the idle client would be closed under the write.
    await new Promise((r) => setTimeout(r, 200))
    expect(released).toBe(0)
    await done
    await new Promise((r) => setTimeout(r, 200))
    expect(released).toBe(1)
    const rows = t.app.ctx.audit.list({ action: 'test.left' })
    expect(rows).toHaveLength(1)
    // Second review (minor): written once the handler is done, with what it really did.
    expect(rows[0]).toMatchObject({
      outcome: 'success',
      details: { what: 'long write', aborted: true, status: 200 },
    })
  })

  it('audits a failed handler whose client left as a failure, with its status', async () => {
    const t = await makeApp({})
    apps.push(t)
    let finished!: () => void
    const done = new Promise<void>((r) => (finished = r))
    t.app.post('/api/test-failed', { config: { audit: 'test.failed' as AuditAction } }, async () => {
      await new Promise((r) => setTimeout(r, 400))
      finished()
      throw Errors.conflict('It did not work')
    })
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const raw = rawRequest(
      Number(new URL(address).port),
      [
        'POST /api/test-failed HTTP/1.1',
        `Host: ${H.host}`,
        `Origin: ${H.origin}`,
        'Content-Type: application/json',
        'Content-Length: 2',
        `X-CSRF-Token: ${t.app.ctx.localCsrfToken}`,
        `Cookie: ${H.cookie}`,
        `X-MM-Local: ${H['x-mm-local']}`,
      ],
      '{}',
    )
    await new Promise((r) => setTimeout(r, 150))
    raw.socket.destroy()
    // Nothing yet: the handler is still at work.
    expect(t.app.ctx.audit.list({ action: 'test.failed' })).toHaveLength(0)
    await done
    await new Promise((r) => setTimeout(r, 200))
    const rows = t.app.ctx.audit.list({ action: 'test.failed' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'failure', details: { aborted: true, status: 409 } })
  })

  // Independent review (minor): no cap on connections let one address hold as many as it liked.
  it('caps connections in all and per address, and frees a slot when one closes', async () => {
    const t = await makeApp({ maxConnections: 50, maxConnectionsPerIp: 3 })
    apps.push(t)
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    expect(t.app.server.maxConnections).toBe(50)
    const open = async () => {
      const s = connect(port, '127.0.0.1')
      s.on('error', () => undefined)
      let closed = false
      s.on('close', () => (closed = true))
      await new Promise((r) => setTimeout(r, 150))
      return { s, closed: () => closed }
    }
    const first = await Promise.all([open(), open(), open()])
    expect(first.map((c) => c.closed())).toEqual([false, false, false])
    const fourth = await open()
    expect(fourth.closed()).toBe(true)
    first[0]!.s.destroy()
    await new Promise((r) => setTimeout(r, 150))
    const again = await open()
    expect(again.closed()).toBe(false)
    for (const c of [...first, again]) c.s.destroy()
    expect(
      resolveConfig({ env: { MM_MAX_CONNECTIONS_PER_IP: '9', MM_MAX_CONNECTIONS: '99' } }),
    ).toMatchObject({
      maxConnectionsPerIp: 9,
      maxConnections: 99,
    })
  })

  // Second review (minor): a refused socket is said in the log — once a minute per address, so a
  // flood writes one line — and the default leaves room for an office behind one address.
  it('logs a refused socket once a minute per address, with a roomy default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-cap-'))
    const logFile = join(dir, 'mm.log')
    const t = await makeApp({ maxConnectionsPerIp: 2, logFile, logLevel: 'info' }, { logger: true })
    apps.push(t)
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = Number(new URL(address).port)
    const sockets = Array.from({ length: 5 }, () => {
      const s = connect(port, '127.0.0.1')
      s.on('error', () => undefined)
      return s
    })
    await new Promise((r) => setTimeout(r, 300))
    for (const s of sockets) s.destroy()
    const lines = readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l.includes('too many connections from one address'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('127.0.0.1')
    expect(lines[0]).toContain('MM_MAX_CONNECTIONS_PER_IP')
    expect(resolveConfig({}).maxConnectionsPerIp).toBe(256)
  })

  it('sets the server’s own timeouts: idle sockets and slow headers', async () => {
    const { t } = await serve()
    expect(t.app.server.timeout).toBe(10 * 60_000)
    expect(t.app.server.headersTimeout).toBe(30_000)
    expect(t.app.server.keepAliveTimeout).toBeGreaterThan(0)
  })

  it('keeps an idle real-time socket open past the idle timeout (ws clears it)', async () => {
    const { port, as } = await serve({
      http: { connectionTimeoutMs: 300 },
      realtime: { pingMs: 60_000, helloTimeoutMs: 60_000 },
    })
    const viewer = as('viewer')
    // A real upgrade, by hand: the socket the server keeps once it switched protocols.
    const raw = rawRequest(port, [
      'GET /ws HTTP/1.1',
      `Host: ${H.host}`,
      `Origin: ${H.origin}`,
      `Cookie: ${viewer.cookie}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ])
    expect(await raw.answer(2_000)).toMatch(/^HTTP\/1\.1 101/)
    let closed = false
    void raw.closed.then(() => (closed = true))
    // A plain socket that says nothing is closed meanwhile: the idle timeout is in force.
    const silent = connect(port, '127.0.0.1')
    silent.on('error', () => undefined)
    let silentClosed = false
    silent.on('close', () => (silentClosed = true))
    await new Promise((r) => setTimeout(r, 1_000))
    expect(silentClosed).toBe(true)
    expect(closed).toBe(false)
    raw.socket.destroy()
  })
})
