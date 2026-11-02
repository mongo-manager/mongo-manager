import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from '@fastify/websocket'
import { ConnectionSettingsSchema, type Role } from '@mongo-manager/shared'
import { AppError } from '../src/errors'
import type { EvalPart } from '../src/shell/manager'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Phase 3a-1 spec §6: the shell channel over /ws. The real worker/proxy path is covered by
 * shell-manager-e2e; here a fake ShellManager makes the hub's routing, access checks and reconnect
 * deterministic.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

/** A fake manager recording calls and letting the test push eval parts. */
class FakeShell {
  opened: Array<{
    owner: string | null
    admin: boolean
    readOnly: boolean
    connectionId: string
    db: string
  }> = []
  detached: string[] = []
  closed: Array<{ id: string; reason: string }> = []
  sinks = new Map<string, (p: EvalPart) => void>()
  failOpen: AppError | null = null
  /** An open waits for this (a slow spawn), when set. */
  openGate: Promise<void> | null = null
  /** How many opens were asked for, before any gate. */
  asked = 0
  info: { connectionId: string; admin: boolean; readOnly: boolean } | null = null
  /** Whose sess-1 is, once opened (never opened: anyone's, as the older tests attach). */
  owner: string | null | undefined = undefined
  private mine(owner: string | null) {
    return this.owner === undefined || this.owner === owner
  }
  async open(
    caller: { owner: string | null; admin: boolean; readOnly: boolean },
    connectionId: string,
    db: string,
  ) {
    this.asked++
    if (this.failOpen) throw this.failOpen
    if (this.openGate) await this.openGate
    this.opened.push({ ...caller, connectionId, db })
    this.owner = caller.owner
    this.info = { connectionId, admin: caller.admin, readOnly: caller.readOnly }
    return { sessionId: 'sess-1', prompt: 'rs0>' }
  }
  completeCalls: Array<{ sessionId: string; id: number; code: string }> = []
  async complete(_owner: string | null, sessionId: string, id: number, code: string) {
    if (sessionId !== 'sess-1') throw new AppError('NOT_FOUND', 'Shell session not found', 404)
    this.completeCalls.push({ sessionId, id, code })
    return ['db.orders']
  }
  sessionInfo(owner: string | null, sessionId: string) {
    return sessionId === 'sess-1' && this.mine(owner) ? (this.info ?? undefined) : undefined
  }
  async evaluate(
    owner: string | null,
    sessionId: string,
    _id: number,
    _code: string,
    sink: (p: EvalPart) => void,
  ) {
    if (sessionId !== 'sess-1') throw new AppError('NOT_FOUND', 'Shell session not found', 404)
    void owner
    this.sinks.set(sessionId, sink)
    sink({ type: 'result', id: _id, resultType: null, value: 1 })
    sink({ type: 'done', id: _id, prompt: 'rs0>' })
  }
  cancel() {}
  async close(_o: string | null, id: string, reason = 'closed') {
    this.closed.push({ id, reason })
  }
  attachSinks: Array<(p: EvalPart) => void> = []
  runningOnAttach = false
  attachedBy: unknown[] = []
  attach(owner: string | null, id: string, sink?: (p: EvalPart) => void, who?: unknown) {
    if (id !== 'sess-1' || !this.mine(owner)) throw new AppError('NOT_FOUND', 'gone', 404)
    this.attachedBy.push(who)
    if (sink) this.attachSinks.push(sink)
    return { prompt: 'rs0>', db: 'shop', running: this.runningOnAttach }
  }
  detach(id: string) {
    this.detached.push(id)
  }
  async shutdown() {}
}

async function setup(overrides: object = {}) {
  const t = await makeApp({ auth: true, ...overrides }, { realtime: { helloTimeoutMs: 200, pingMs: 50 } })
  apps.push(t)
  await t.app.ready()
  const fake = new FakeShell()
  /** Ends a session as the real manager would by itself (idle, lifetime): its listeners are told. */
  const real = t.app.ctx.shell as unknown as { ended: Set<(id: string, reason: string) => void> }
  const endSession = (id: string, reason: string) => real.ended.forEach((l) => l(id, reason))
  ;(t.app.ctx as unknown as { shell: FakeShell }).shell = fake
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'M',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
    },
    null,
  ).id
  const user = (role: Role, grant?: 'viewer' | 'editor', shell?: boolean) => {
    const record = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (grant) ctx.grants.set(connectionId, record.id, grant)
    if (shell) ctx.grants.setShell(connectionId, record.id, true)
    const { sessionId, session } = ctx.sessions.create(record.id, {})
    return { id: record.id, sessionId, csrf: session.csrfToken }
  }
  const open = async (u: ReturnType<typeof user>): Promise<Client> => {
    let closedWith!: (code: number) => void
    const closed = new Promise<number>((r) => (closedWith = r))
    const messages: Array<{ ch?: string; type: string; payload?: Record<string, unknown> }> = []
    const waiters: Array<() => void> = []
    const request = {
      headers: { ...H, cookie: `mm_sid=${u.sessionId}` },
      socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    } as never
    const ws = await t.app.injectWS('/ws', request, {
      onInit: (socket) => {
        socket.on('ping', () => socket.pong())
        socket.on('message', (data) => {
          messages.push(JSON.parse(String(data)))
          waiters.splice(0).forEach((w) => w())
        })
        socket.on('close', (code) => closedWith(code))
      },
    })
    const next = async (type: string) => {
      for (;;) {
        const i = messages.findIndex((m) => m.type === type)
        if (i >= 0) return messages.splice(i, 1)[0]!
        await Promise.race([
          new Promise<void>((r) => waiters.push(r)),
          closed.then(() => {
            throw new Error(`closed waiting ${type}`)
          }),
        ])
      }
    }
    return { ws, next, closed, messages, send: (m: unknown) => ws.send(JSON.stringify(m)) }
  }
  const hello = async (u: ReturnType<typeof user>) => {
    const c = await open(u)
    c.send({ type: 'hello', csrf: u.csrf })
    await c.next('ready')
    return c
  }
  return { t, ctx, connectionId, user, hello, fake, endSession }
}

interface Client {
  ws: WebSocket
  /** What arrived and was not taken by next() yet. */
  messages: Array<{ ch?: string; type: string; payload?: Record<string, unknown> }>
  next(type: string): Promise<{ ch?: string; type: string; payload?: Record<string, unknown> }>
  closed: Promise<number>
  send(m: unknown): void
}

describe('the shell channel over /ws (phase 3a-1 §6)', () => {
  it('opens a shell for an admin and streams an eval', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    const opened = await c.next('opened')
    expect(opened.payload).toMatchObject({ sessionId: 'sess-1', prompt: 'rs0>' })
    expect(fake.opened[0]).toMatchObject({ admin: true, connectionId, db: 'shop' })
    c.send({ ch: 'shell', type: 'eval', sessionId: 'sess-1', id: 1, code: '1+1' })
    const result = await c.next('result')
    expect(result.payload).toMatchObject({ value: 1 })
    await c.next('done')
  })

  // The shell's redesign (2026-10-11): several shell tabs share one socket. Every message names its
  // session — an open its tab's ref — so a tab takes only its own, never another's output.
  it('names the session on every message, and an open its ref', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop', ref: 'tab-a' })
    expect((await c.next('opened')).payload).toEqual({ sessionId: 'sess-1', prompt: 'rs0>', ref: 'tab-a' })
    c.send({ ch: 'shell', type: 'eval', sessionId: 'sess-1', id: 1, code: '1+1' })
    expect((await c.next('result')).payload).toMatchObject({ sessionId: 'sess-1', value: 1 })
    expect((await c.next('done')).payload).toMatchObject({ sessionId: 'sess-1' })
    c.send({ ch: 'shell', type: 'complete', sessionId: 'sess-1', id: 9, code: 'db.or' })
    expect((await c.next('completions')).payload).toEqual({
      sessionId: 'sess-1',
      id: 9,
      items: ['db.orders'],
    })
    c.send({ ch: 'shell', type: 'eval', sessionId: 'nope', id: 2, code: '1' })
    expect((await c.next('failed')).payload).toMatchObject({ sessionId: 'nope', code: 'NOT_FOUND' })
    fake.failOpen = new AppError('UPSTREAM_ERROR', 'down', 502)
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop', ref: 'tab-b' })
    expect((await c.next('failed')).payload).toMatchObject({ ref: 'tab-b', code: 'UPSTREAM_ERROR' })
  })

  // Review 2026-10-11 (I2): a session the server ends by itself is said to its page, by a reason
  // code the page words in its language.
  it('tells the page when the server ends its session by itself, and only that page', async () => {
    const { connectionId, user, hello, endSession } = await setup()
    const owner = user('admin')
    const c = await hello(owner)
    const other = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop', ref: 'tab-a' })
    await c.next('opened')
    endSession('sess-1', 'idle')
    expect((await c.next('closed')).payload).toEqual({ sessionId: 'sess-1', reason: 'idle' })
    other.send({ ch: 'shell', type: 'eval', sessionId: 'nope', id: 1, code: '1' })
    await other.next('failed')
    expect(other.messages.some((m) => m.type === 'closed')).toBe(false)
    // Said once: a session already said closed is not said again.
    endSession('sess-1', 'closed')
    c.send({ ch: 'shell', type: 'eval', sessionId: 'nope', id: 1, code: '1' })
    await c.next('failed')
    expect(c.messages.some((m) => m.type === 'closed')).toBe(false)
  })

  // Review I4: a command still running when the socket dropped finishes on the one that came back.
  it('hands a running command’s output to the socket that reattaches, and says it runs', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const owner = user('admin')
    const c = await hello(owner)
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    fake.runningOnAttach = true
    c.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    expect((await c.next('opened')).payload).toEqual({
      sessionId: 'sess-1',
      prompt: 'rs0>',
      db: 'shop',
      running: true,
    })
    fake.attachSinks.at(-1)!({ type: 'done', id: 4, prompt: 'rs0>' })
    expect((await c.next('done')).payload).toEqual({
      type: 'done',
      id: 4,
      prompt: 'rs0>',
      sessionId: 'sess-1',
    })
  })

  // Security review 2026-10-13 (low): the shell's audit rows name the user and the address.
  it('tells the manager who opens or takes a session, and from where', async () => {
    const { ctx, connectionId, user, hello, fake } = await setup()
    const owner = user('admin')
    const c = await hello(owner)
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    const username = ctx.users.findById(owner.id)!.username
    expect(fake.opened[0]).toMatchObject({ username, ip: '127.0.0.1' })
    c.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    await c.next('opened')
    expect(fake.attachedBy).toEqual([{ username, ip: '127.0.0.1' }])
  })

  it('names why it closed by a code, never a sentence', async () => {
    const { user, hello } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'attach', sessionId: 'gone' })
    expect((await c.next('closed')).payload).toEqual({ sessionId: 'gone', reason: 'ended' })
  })

  it('refuses a ref that is not a short plain tag', async () => {
    const { connectionId, user, hello } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop', ref: '<script>' })
    await expect(c.closed).resolves.toBeGreaterThanOrEqual(4000)
  })

  it('refuses an empty ref and one longer than 64', async () => {
    const { connectionId, user, hello } = await setup()
    for (const ref of ['', 'a'.repeat(65)]) {
      const c = await hello(user('admin'))
      c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop', ref })
      await expect(c.closed).resolves.toBeGreaterThanOrEqual(4000)
    }
  })

  it('refuses a viewer with a failed message, not a crash', async () => {
    const { connectionId, user, hello } = await setup()
    const c = await hello(user('viewer', 'viewer'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    const failed = await c.next('failed')
    expect(failed.payload).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('opens for an editor granted the shell', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const c = await hello(user('editor', 'editor', true))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    expect(fake.opened[0]).toMatchObject({ admin: false })
  })

  it('answers an eval for an unknown session with failed, and the socket stays up', async () => {
    const { user, hello } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'eval', sessionId: 'nope', id: 1, code: '1+1' })
    const failed = await c.next('failed')
    expect(failed.payload).toMatchObject({ code: 'NOT_FOUND' })
  })

  // Review 2026-10-12 (I1): a socket gone while its shell was still opening left the session held
  // forever: no page knew its id, and with no idle limit nothing closed it.
  it('lets a session go whose socket closed while it was opening', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const c = await hello(user('admin'))
    let release!: () => void
    fake.openGate = new Promise<void>((r) => (release = r))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await vi.waitFor(() => expect(fake.asked).toBe(1), { timeout: 2000 })
    c.ws.terminate()
    await c.closed
    expect(fake.detached).toEqual([])
    release()
    await vi.waitFor(() => expect(fake.opened).toHaveLength(1), { timeout: 2000 })
    await vi.waitFor(() => expect(fake.detached).toContain('sess-1'), { timeout: 2000 })
  })

  it('detaches the session when the socket closes', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    c.ws.terminate()
    await c.closed
    await vi.waitFor(() => expect(fake.detached).toContain('sess-1'), { timeout: 2000 })
  })

  // User report 2026-10-12: a reloaded page's new socket took the session over, and the old socket's
  // close then let it go — closed two minutes later under the page using it.
  it('keeps a session another socket took over when the socket it left closes', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const ada = user('admin')
    const before = await hello(ada)
    before.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await before.next('opened')
    const after = await hello(ada)
    after.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    await after.next('opened')
    before.ws.terminate()
    await before.closed
    // The new socket's own close still lets it go.
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.detached).not.toContain('sess-1')
    after.ws.terminate()
    await after.closed
    await vi.waitFor(() => expect(fake.detached).toContain('sess-1'), { timeout: 2000 })
  })

  // Review 2026-10-12 (I5): a duplicated browser tab took the session over without a word to the
  // first, which went on showing a shell no longer its own.
  it('tells the socket a session moved from that it was taken over', async () => {
    const { connectionId, user, hello } = await setup()
    const ada = user('admin')
    const first = await hello(ada)
    first.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await first.next('opened')
    const second = await hello(ada)
    second.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    await second.next('opened')
    expect((await first.next('closed')).payload).toEqual({ sessionId: 'sess-1', reason: 'moved' })
    // The socket that took it over is told nothing of the kind.
    expect(second.messages.some((m) => m.type === 'closed')).toBe(false)
  })

  // Review 2026-10-12 (I7): another user's session can never be attached to, nor taken from its page.
  it('never attaches another user’s session, and leaves it with its page', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const ada = await hello(user('admin'))
    ada.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await ada.next('opened')
    const bob = await hello(user('admin'))
    bob.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    expect((await bob.next('closed')).payload).toEqual({ sessionId: 'sess-1', reason: 'ended' })
    expect(fake.attachSinks).toHaveLength(0)
    expect(ada.messages.some((m) => m.type === 'closed')).toBe(false)
    // Still Ada's: her socket closing lets it go, as before.
    ada.ws.terminate()
    await ada.closed
    await vi.waitFor(() => expect(fake.detached).toContain('sess-1'), { timeout: 2000 })
  })

  // Review 2026-10-12 (M8): access is read again before a session is taken back.
  it('closes a session instead of attaching to it after the shell grant is revoked', async () => {
    const { ctx, connectionId, user, hello, fake } = await setup()
    const editor = user('editor', 'editor', true)
    const c = await hello(editor)
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    ctx.grants.setShell(connectionId, editor.id, false)
    const again = await hello(editor)
    again.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    expect((await again.next('closed')).payload).toMatchObject({ sessionId: 'sess-1', reason: 'access' })
    expect(fake.closed).toContainEqual({ id: 'sess-1', reason: 'access' })
    expect(fake.attachSinks).toHaveLength(0)
  })

  it('reattaches to a live session and reports a gone one as closed', async () => {
    const { user, hello } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'attach', sessionId: 'sess-1' })
    expect((await c.next('opened')).payload).toMatchObject({ sessionId: 'sess-1' })
    c.send({ ch: 'shell', type: 'attach', sessionId: 'gone' })
    expect((await c.next('closed')).payload).toMatchObject({ reason: expect.stringContaining('ended') })
  })

  // Review Focus 5 / C1: access is re-read on every eval, so a command never runs under stale rules.
  it('closes the session instead of running an eval after the shell grant is revoked', async () => {
    const { ctx, connectionId, user, hello, fake } = await setup()
    const editor = user('editor', 'editor', true)
    const c = await hello(editor)
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    // The admin revokes the editor's shell grant while the session is open.
    ctx.grants.setShell(connectionId, editor.id, false)
    c.send({ ch: 'shell', type: 'eval', sessionId: 'sess-1', id: 1, code: 'db.x.insertOne({})' })
    const closed = await c.next('closed')
    expect(closed.payload).toMatchObject({ sessionId: 'sess-1', reason: expect.stringContaining('access') })
    expect(fake.closed).toContainEqual({ id: 'sess-1', reason: 'access' })
    // The command never reached the manager to run.
    expect(fake.sinks.has('sess-1')).toBe(false)
  })

  it('answers a completion request with the manager items (phase 3a-2)', async () => {
    const { connectionId, user, hello, fake } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    c.send({ ch: 'shell', type: 'complete', sessionId: 'sess-1', id: 9, code: 'db.or' })
    const reply = await c.next('completions')
    expect(reply.payload).toEqual({ sessionId: 'sess-1', id: 9, items: ['db.orders'] })
    expect(fake.completeCalls).toEqual([{ sessionId: 'sess-1', id: 9, code: 'db.or' }])
  })

  it('closes the session instead of completing after the shell grant is revoked (A2)', async () => {
    const { ctx, connectionId, user, hello, fake } = await setup()
    const editor = user('editor', 'editor', true)
    const c = await hello(editor)
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    ctx.grants.setShell(connectionId, editor.id, false)
    c.send({ ch: 'shell', type: 'complete', sessionId: 'sess-1', id: 1, code: 'db.' })
    const closed = await c.next('closed')
    expect(closed.payload).toMatchObject({ sessionId: 'sess-1', reason: expect.stringContaining('access') })
    expect(fake.completeCalls).toEqual([])
  })

  it('answers an unknown session with no items, not a failure', async () => {
    const { user, hello } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'complete', sessionId: 'nope', id: 2, code: 'db.' })
    const reply = await c.next('completions')
    expect(reply.payload).toEqual({ sessionId: 'nope', id: 2, items: [] })
  })

  it('closes the session instead of running an eval after the connection is turned read-only', async () => {
    const { ctx, connectionId, user, hello, fake } = await setup()
    const c = await hello(user('admin'))
    c.send({ ch: 'shell', type: 'open', connectionId, db: 'shop' })
    await c.next('opened')
    ctx.connections.update(connectionId, { readOnly: true })
    c.send({ ch: 'shell', type: 'eval', sessionId: 'sess-1', id: 1, code: 'db.x.insertOne({})' })
    const closed = await c.next('closed')
    expect(closed.payload).toMatchObject({ sessionId: 'sess-1', reason: expect.stringContaining('access') })
    expect(fake.sinks.has('sess-1')).toBe(false)
  })
})
