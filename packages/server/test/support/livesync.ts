import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { MongoClient } from 'mongodb'
import { parseConnectionUri, type PersonalRule, type Role } from '@mongo-manager/shared'
import { buildApp, type AppDeps } from '../../src/http/app'
import { resolveConfig, type PartialConfig } from '../../src/config'
import { openStore } from '../../src/store/db'
import { createSecretBox } from '../../src/crypto/secret-box'
import { H } from '../helpers'

export type Conn = 'A' | 'B' | 'A2' | 'S'
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Phase 3e-2: team mode with connections A (replica set a), B (replica set b), A2 (set a reached as
 * "localhost": the same deployment under another name) and, when given, S (a standalone server).
 * The app runs on the real clock (change events carry real wall times) and can be restarted on the
 * same data directory and key: `restart()` is a server restart (Review Focus 2).
 */
export async function liveSyncHarness(
  a: string,
  b: string,
  solo?: string,
  overrides: PartialConfig = {},
  extra: Partial<AppDeps> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-live-'))
  const key = randomBytes(32)
  const open = async (more: PartialConfig = {}) => {
    const config = resolveConfig({
      cli: { dataDir: dir, logLevel: 'silent', auth: true, ...overrides, ...more },
    })
    const store = await openStore(dir)
    const app = await buildApp({
      config,
      store,
      secretBox: createSecretBox(key),
      now: Date.now,
      scheduler: { autoStart: false },
      ...extra,
    })
    await app.ready()
    return { app, store }
  }
  let current = await open()
  const app = (): FastifyInstance => current.app
  const make = (name: string, uri: string, host?: string) => {
    const settings = parseConnectionUri(uri)
    if (host) settings.hosts = settings.hosts.map((h) => ({ ...h, host }))
    return app().ctx.connections.create({ name, favorite: false, readOnly: false, settings }, null).id
  }
  const ids = {
    A: make('A', a),
    B: make('B', b),
    A2: make('A2', a, 'localhost'),
    ...(solo ? { S: make('S', solo) } : {}),
  } as Record<Conn, string>
  const user = (spec: { role?: Role; on?: Partial<Record<Conn, Role | 'none'>>; masked?: Conn[] } = {}) => {
    const { ctx } = app()
    const role = spec.role ?? 'admin'
    const u = ctx.users.create({ username: `u-${randomUUID()}`, passwordHash: 'x', role })
    for (const c of Object.keys(ids) as Conn[]) {
      const grant = spec.on?.[c] ?? (spec.masked?.includes(c) ? role : undefined)
      if (grant) ctx.grants.set(ids[c], u.id, grant)
    }
    for (const c of spec.masked ?? []) ctx.grants.setMasked(ids[c], u.id, true)
    const s = ctx.sessions.create(u.id, {})
    const headers = { ...H, 'x-csrf-token': s.session.csrfToken }
    const cookies = { mm_sid: s.sessionId }
    // Sessions live in SQLite: the same cookie works after a restart.
    const call = (method: Method, url: string, payload?: unknown) =>
      app().inject({
        method,
        url,
        headers,
        cookies,
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
    return {
      id: u.id,
      username: u.username,
      sessionId: s.sessionId,
      csrf: s.session.csrfToken,
      call,
      get: (url: string) => call('GET', url),
    }
  }
  /** A /ws socket of a harness user (phase 3e-2: the livesync channel). */
  const socket = async (u: { sessionId: string; csrf: string }) => {
    const messages: Array<{ ch?: string; type: string; payload: Record<string, unknown> }> = []
    const request = {
      headers: { ...H, cookie: `mm_sid=${u.sessionId}` },
      socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    } as never
    const ws = await app().injectWS('/ws', request, {
      onInit: (s) => {
        s.on('ping', () => s.pong())
        s.on('message', (data) => messages.push(JSON.parse(String(data))))
      },
    })
    const send = (m: unknown) => ws.send(JSON.stringify(m))
    const next = async (match: (m: (typeof messages)[number]) => boolean, ms = 15_000) => {
      await until(() => messages.some(match), ms)
      return messages.splice(messages.findIndex(match), 1)[0]!
    }
    send({ type: 'hello', csrf: u.csrf })
    await next((m) => m.type === 'ready')
    return { messages, send, next, close: () => ws.terminate() }
  }
  return {
    get app() {
      return app()
    },
    get ctx() {
      return app().ctx
    },
    ids,
    user,
    rules: (c: Conn, list: PersonalRule[]) => app().ctx.personalFields.set(ids[c], list),
    client: (c: Conn): Promise<MongoClient> => app().ctx.manager.getClient(ids[c]),
    socket,
    /** A server restart: this app closes, `whileDown` runs, and a new one opens on the same data and key. */
    async restart(more: PartialConfig = {}, whileDown?: () => Promise<void>) {
      await current.app.close()
      current.store.close()
      await whileDown?.()
      current = await open(more)
    },
    async close() {
      await current.app.close()
      current.store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
export type LiveSyncHarness = Awaited<ReturnType<typeof liveSyncHarness>>

/** A sync request between two connections' namespaces (writes on the target confirmed). */
export const syncBody = (
  ids: Record<Conn, string>,
  from: Conn,
  to: Conn,
  ns: { db: string; coll?: string; targetDb?: string; targetColl?: string },
  extra: Record<string, unknown> = {},
) => ({
  source: { connectionId: ids[from], db: ns.db, ...(ns.coll ? { coll: ns.coll } : {}) },
  target: {
    connectionId: ids[to],
    db: ns.targetDb ?? ns.db,
    ...(ns.coll ? { coll: ns.targetColl ?? ns.coll } : {}),
  },
  confirmOverwrite: true,
  ...extra,
})

/** Polls until `test` holds (10 s by default). */
export async function until(test: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
