import { randomUUID } from 'node:crypto'
import type { WebSocket } from '@fastify/websocket'
import { parseConnectionUri, type Role, type WatchEvent } from '@mongo-manager/shared'
import { H, makeApp } from '../helpers'
import type { WatchMessage } from '../../src/changestreams/feed'
import type { Subscriber } from '../../src/changestreams/manager'

export interface WatchMsg {
  ch?: string
  type: string
  payload: Record<string, unknown> & { id?: string; events?: WatchEvent[]; reason?: string }
}

/** An app with one connection to `uri`, users, and sockets that said hello (phase 3e-1). */
export async function watchApp(uri: string, opts: { config?: object; deps?: object } = {}) {
  const t = await makeApp({ auth: true, ...opts.config }, {
    realtime: { helloTimeoutMs: 5_000 },
    watch: { timing: { flushMs: 20, waitMs: 10 } },
    ...opts.deps,
  } as never)
  await t.app.ready()
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    { name: 'RS', favorite: false, readOnly: false, settings: parseConnectionUri(uri) },
    null,
  ).id
  const user = (role: Role = 'viewer', o: { grant?: Role | 'none'; masked?: boolean } = {}) => {
    const record = ctx.users.create({ username: `u-${role}-${randomUUID()}`, passwordHash: 'x', role })
    if (o.grant || o.masked) ctx.grants.set(connectionId, record.id, o.grant ?? role)
    if (o.masked) ctx.grants.setMasked(connectionId, record.id, true)
    const { sessionId, session } = ctx.sessions.create(record.id, {})
    const principal = {
      kind: 'user' as const,
      userId: record.id,
      username: record.username,
      role,
      csrfToken: session.csrfToken,
      sessionId,
      sessionIdHash: 'h',
    }
    return { id: record.id, sessionId, csrf: session.csrfToken, principal }
  }
  /** A subscriber for driving the manager directly (flow control: one that stops reading). */
  const subscriber = (u: ReturnType<typeof user>, writable = () => true) => {
    const sent: WatchMessage[] = []
    const sub: Subscriber & { sent: WatchMessage[] } = {
      sent,
      ip: '127.0.0.1',
      principal: () => u.principal,
      send: (m) => sent.push(m),
      writable,
      ended: () => undefined,
    }
    return sub
  }
  const socket = async (u: ReturnType<typeof user>) => {
    const messages: WatchMsg[] = []
    const waiters: Array<() => void> = []
    let closedWith!: (code: number) => void
    const closed = new Promise<number>((r) => (closedWith = r))
    const request = {
      headers: { ...H, cookie: `mm_sid=${u.sessionId}` },
      socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    } as never
    const ws: WebSocket = await t.app.injectWS('/ws', request, {
      onInit: (s) => {
        s.on('ping', () => s.pong())
        s.on('message', (data) => {
          messages.push(JSON.parse(String(data)))
          waiters.splice(0).forEach((w) => w())
        })
        s.on('close', (code) => closedWith(code))
      },
    })
    const next = async (type: string, match: (m: WatchMsg) => boolean = () => true, ms = 15_000) => {
      const end = Date.now() + ms
      for (;;) {
        const i = messages.findIndex((m) => m.type === type && match(m))
        if (i >= 0) return messages.splice(i, 1)[0]!
        if (Date.now() > end) throw new Error(`no ${type} message`)
        await Promise.race([new Promise<void>((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 50))])
      }
    }
    const send = (m: unknown) => ws.send(JSON.stringify(m))
    send({ type: 'hello', csrf: u.csrf })
    await next('ready')
    /** Every event received so far for a feed, in order. */
    const events = (id: string) =>
      messages
        .filter((m) => m.ch === 'watch' && m.type === 'events' && m.payload.id === id)
        .flatMap((m) => m.payload.events ?? [])
    return { ws, messages, send, next, events, closed, close: () => ws.terminate() }
  }
  return { t, ctx, connectionId, user, socket, subscriber }
}
