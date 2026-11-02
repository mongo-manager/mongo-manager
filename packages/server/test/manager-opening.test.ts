import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { ConnectionManager, unlessStopped, type ManagerDeps, type Tunnel } from '../src/connections/manager'
import { ConnectionError, OIDC_PER_PERSON } from '../src/connections/errors'
import { settingsStamp } from '../src/livesync/plan'
import { SCHEMA_SKIP } from '../src/livesync/apply'
import { AppError } from '../src/errors'
import { connectionAppError, toAppError } from '../src/data/mongo-errors'
import { MongoServerError } from 'mongodb'
import { liveSyncHarness, syncBody, type LiveSyncHarness } from './support/livesync'
import { HealthCache } from '../src/connections/health'
import { openSshTunnel } from '../src/connections/ssh'
import { H, makeApp, type TestApp } from './helpers'
import { slow } from './support/slowness'

/**
 * CI 2026-10-22: a client still opening — a server that does not answer, sampled for an alert rule —
 * held the app's close for the whole of its cap (10 s), and a connection's edit or deletion until
 * the server selection gave up (30 s here). Closed, it stops opening at once, and says why.
 */
const unreachable = ConnectionSettingsSchema.parse({
  hosts: [{ host: '127.0.0.1', port: 1 }],
  serverSelectionTimeoutMS: 30_000,
})
const viaSsh = (ssh: object = {}): ConnectionSettings =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: 'db' }],
    ssh: { enabled: true, host: 's', username: 'u', method: 'password', password: 'p', ...ssh },
  })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SHUTTING_DOWN = { kind: 'closed', message: 'The server is shutting down' }
const CHANGED = {
  kind: 'closed',
  message: 'The connection was edited, removed or signed out while it was opening; try again',
}
// Well inside the 10 s cap and the 30 s server selection, and wide of a loaded runner's stalls
// (one CI run held a test that does nothing for 18 s).
const AT_ONCE_MS = 8_000

const managers: ConnectionManager[] = []
const apps: TestApp[] = []
const harnesses: LiveSyncHarness[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll(1_000)
  for (const t of apps.splice(0)) await t.close()
  for (const h of harnesses.splice(0)) await h.close()
})

function managerOf(deps: Partial<ManagerDeps> & Pick<ManagerDeps, 'load'>) {
  const made: unknown[] = []
  const m = new ConnectionManager({
    createClient: (uri, options) => {
      const client = new MongoClient(uri, options)
      made.push(client)
      return client
    },
    ...deps,
  })
  managers.push(m)
  return { m, made }
}

/**
 * A client of the test's: its connect settles when `connect` says, and it counts its closes, and
 * those after its connect settled (what the driver made after an earlier close stays open else).
 */
function fakeClient(connect: () => Promise<void>) {
  const state = { closes: 0, settled: false, closesAfter: 0 }
  const client = {
    connect: async () => {
      await connect()
      state.settled = true
    },
    db: () => ({ command: async () => ({ version: '8.0.0' }) }),
    close: async () => {
      state.closes++
      if (state.settled) state.closesAfter++
    },
  } as unknown as MongoClient
  return { client, state }
}

/** How long `work` takes. */
async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = Date.now()
  await work()
  return Date.now() - started
}

describe('a client still opening', () => {
  it('stops at once when the app closes, saying why', async () => {
    const { m } = managerOf({ load: () => ({ settings: unreachable }) })
    const opening = m.getClient('c1').catch((e: unknown) => e)
    await wait(100)
    expect(await timed(() => m.closeAll())).toBeLessThan(AT_ONCE_MS)
    const e = await opening
    expect(e).toBeInstanceOf(ConnectionError)
    expect(e).toMatchObject(SHUTTING_DOWN)
  })

  // Without the fix the edit waits out the 30 s server selection: a limit above it fails it by its
  // assertion, not by the test's own timeout.
  it(
    'stops at once when its connection is edited or removed, and the next one opens anew',
    async () => {
      const { m, made } = managerOf({ load: () => ({ settings: unreachable }) })
      const opening = m.getClient('c1').catch((e: unknown) => e)
      await wait(100)
      expect(await timed(() => m.invalidate('c1'))).toBeLessThan(AT_ONCE_MS)
      expect(await opening).toMatchObject(CHANGED)
      void m.getClient('c1').catch(() => undefined)
      await wait(100)
      expect(made).toHaveLength(2)
    },
    slow(45_000),
  )

  // The driver looks a mongodb+srv host up before it makes anything a close could end: the open is
  // left at once, and what the driver makes after the close is closed when it is made.
  it('is left at once though its connect does not end on close, and closed once it does', async () => {
    const late = fakeClient(async () => {
      await wait(1_000)
    })
    const { m } = managerOf({ load: () => ({ settings: unreachable }), createClient: () => late.client })
    const opening = m.getClient('c1').then(
      () => 'opened',
      (e: unknown) => ({ e, settled: late.state.settled }),
    )
    await wait(20)
    await m.invalidate('c1')
    expect(await opening).toMatchObject({ e: CHANGED, settled: false })
    await vi.waitFor(() => expect(late.state.settled).toBe(true), { timeout: 5_000 })
    await vi.waitFor(() => expect(late.state.closesAfter).toBe(1), { timeout: 5_000 })

    const never = fakeClient(() => new Promise(() => undefined))
    const { m: m2 } = managerOf({ load: () => ({ settings: unreachable }), createClient: () => never.client })
    const stuck = m2.getClient('c1').catch((e: unknown) => e)
    await wait(20)
    expect(await timed(() => m2.closeAll())).toBeLessThan(AT_ONCE_MS)
    expect(await stuck).toMatchObject(SHUTTING_DOWN)
    expect(never.state.closes).toBeGreaterThanOrEqual(1)
  })

  // What runs once a client opened (leftover staging collections are dropped) has no deadline.
  it('is closed and left at once while what runs after its opening still runs', async () => {
    const fake = fakeClient(async () => undefined)
    const told: AbortSignal[] = []
    const { m } = managerOf({
      load: () => ({ settings: unreachable }),
      createClient: () => fake.client,
      onOpen: (_id, _client, signal) => {
        told.push(signal)
        return new Promise(() => undefined)
      },
    })
    const opening = m.getClient('c1').catch((e: unknown) => e)
    await wait(50)
    expect(await timed(() => m.invalidate('c1'))).toBeLessThan(AT_ONCE_MS)
    expect(await opening).toMatchObject(CHANGED)
    expect(fake.state.closes).toBeGreaterThanOrEqual(1)
    // Told too, so what it does stops (and says nothing of a failure it caused).
    expect(told.map((s) => s.aborted)).toEqual([true])
  })

  // Second review of the open's stop (minor 1): stopped already, the work was left unwatched, and
  // its later failure ended the process (no unhandledRejection handler).
  it('watches the work it leaves, stopped already', async () => {
    const unhandled: unknown[] = []
    const note = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', note)
    try {
      const stop = new AbortController()
      const reason = new ConnectionError('closed', CHANGED.message)
      stop.abort(reason)
      const work = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('later')), 10))
      await expect(unlessStopped(work, stop.signal)).rejects.toBe(reason)
      await wait(100)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', note)
    }
  })
})

describe('an SSH tunnel still opening', () => {
  it('is closed when it opens after the app closed, and no client is made through it', async () => {
    let closed = 0
    const tunnel: Tunnel = {
      localPort: 1,
      credentials: { username: 'u', password: 'p' },
      fingerprint: 'SHA256:x',
      onClose: () => undefined,
      close: async () => {
        closed++
      },
    }
    const { m, made } = managerOf({
      load: () => ({ settings: viaSsh({ hostFingerprint: 'SHA256:x' }) }),
      openTunnel: async () => {
        await wait(200)
        return tunnel
      },
    })
    const opening = m.getClient('c1').catch((e: unknown) => e)
    await wait(20)
    await m.closeAll()
    expect(await opening).toMatchObject(SHUTTING_DOWN)
    expect(closed).toBe(1)
    expect(made).toEqual([])
  })

  // An SSH host that does not answer holds the handshake for its ready timeout (10 s); the edit
  // has no cap. Told to stop, the opener stops, and the reason is the manager's, not the SSH error.
  it(
    'stops its handshake when its connection is edited',
    async () => {
      const { m } = managerOf({
        load: () => ({ settings: viaSsh() }),
        openTunnel: (_ssh, _target, opts) =>
          new Promise<Tunnel>((_resolve, reject) => {
            const fail = () => reject(new ConnectionError('ssh', 'SSH connection failed: ended'))
            const timer = setTimeout(fail, 15_000)
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              fail()
            })
          }),
      })
      const opening = m.getClient('c1').catch((e: unknown) => e)
      await wait(20)
      expect(await timed(() => m.invalidate('c1'))).toBeLessThan(AT_ONCE_MS)
      expect(await opening).toMatchObject(CHANGED)
    },
    slow(30_000),
  )

  it('ends the SSH handshake with a host that does not answer when told to stop', async () => {
    const sockets: net.Socket[] = []
    const ended: net.Socket[] = []
    // A server that reads what it is sent and never answers.
    const silent = net.createServer((s) => {
      sockets.push(s)
      s.on('error', () => undefined)
      s.on('close', () => ended.push(s))
      s.resume()
    })
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    try {
      const port = (silent.address() as net.AddressInfo).port
      const stop = new AbortController()
      const opening = openSshTunnel(
        viaSsh({ host: '127.0.0.1', port }).ssh!,
        { host: 'db', port: 27017 },
        { signal: stop.signal },
      ).catch((e: unknown) => e)
      await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 })
      const reason = new ConnectionError('closed', 'stopped')
      stop.abort(reason)
      expect(await opening).toBe(reason)
      await vi.waitFor(() => expect(ended).toEqual(sockets), { timeout: 5_000 })
      // Stopped before it began, it dials nothing.
      expect(
        await openSshTunnel(
          viaSsh({ host: '127.0.0.1', port }).ssh!,
          { host: 'db', port: 27017 },
          {
            signal: stop.signal,
          },
        ).catch((e: unknown) => e),
      ).toBe(reason)
      expect(sockets).toHaveLength(1)
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise((r) => silent.close(r))
    }
  })
})

describe('around a stopped open', () => {
  // Second review of the open's stop (minor 4): a test under way dialled on during shutdown.
  it('stops a connection test under way when the app closes', async () => {
    const { m } = managerOf({
      load: () => undefined,
      openTunnel: (_ssh, _target, opts) =>
        new Promise<Tunnel>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new ConnectionError('ssh', 'SSH connection failed')), 15_000)
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new ConnectionError('ssh', 'SSH connection failed: ended'))
          })
        }),
    })
    const testing = m.test(viaSsh())
    await wait(20)
    await m.closeAll()
    expect(await testing).toMatchObject({ ok: false, error: SHUTTING_DOWN })
  })

  it('tests no connection once the app closed', async () => {
    const { m, made } = managerOf({ load: () => undefined })
    await m.closeAll()
    expect(await m.test(unreachable)).toMatchObject({ ok: false, error: SHUTTING_DOWN })
    expect(made).toEqual([])
  })

  // Second review of the open's stop (nit 6): the server could not serve it now; nothing failed.
  it('answers a stopped open as unavailable', () => {
    expect(toAppError(new ConnectionError('closed', CHANGED.message))).toMatchObject({
      code: 'MONGO_ERROR',
      statusCode: 503,
      details: { kind: 'closed' },
    })
    expect(toAppError(new ConnectionError('network', 'x'))).toMatchObject({ statusCode: 502 })
  })

  // Third review (minor 1): what routes answer, as they get their client (clientFor).
  it(
    'answers a request waiting on an open its connection’s edit stopped as unavailable',
    async () => {
      const t = await makeApp()
      apps.push(t)
      const headers = { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }
      const dto = (
        await t.app.inject({
          method: 'POST',
          url: '/api/connections',
          headers,
          payload: { name: 'X', settings: unreachable },
        })
      ).json()
      const waiting = t.app.inject({ method: 'GET', url: `/api/connections/${dto.id}/databases`, headers })
      // Fourth review (nit 3): the open has begun (it is registered as it begins), however slow the run.
      await vi.waitFor(() => expect(t.app.ctx.manager.isOpen(dto.id)).toBe(true), { timeout: 10_000 })
      const moved = { ...dto.settings, hosts: [{ host: '127.0.0.1', port: 2 }] }
      const edited = await t.app.inject({
        method: 'PATCH',
        url: `/api/connections/${dto.id}`,
        headers,
        payload: { settings: moved },
      })
      expect(edited.statusCode).toBe(200)
      const res = await waiting
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'MONGO_ERROR', details: { kind: 'closed' } })
    },
    slow(45_000),
  )

  // Fourth review (minor 1): one mapping of a connection's failure, wherever a client is asked for.
  it('names a connection’s failure the same wherever its client is asked for', () => {
    expect(
      connectionAppError(new ConnectionError('unsupported', 'MongoDB 5.0.26 is not supported.')),
    ).toMatchObject({ code: 'UNSUPPORTED_SERVER', statusCode: 422 })
    const refused = new MongoServerError({ message: 'Authentication failed.', code: 18 })
    expect(connectionAppError(refused)).toMatchObject({
      code: 'MONGO_ERROR',
      statusCode: 502,
      details: { kind: 'auth' },
    })
    const signIn = connectionAppError(new ConnectionError('oidc', 'Sign in'))
    expect(signIn).toMatchObject({ statusCode: 502, details: { kind: 'oidc', reason: 'oidc_sign_in' } })
    // Fifth review (minor 1): work with no person behind it on a per-person connection: a sign-in
    // cannot help, so no sign-in is asked for.
    expect(connectionAppError(new ConnectionError('oidc', OIDC_PER_PERSON))).toMatchObject({
      statusCode: 502,
      details: { kind: 'oidc', reason: 'oidc_per_person' },
    })
    // Fifth review (nit 5): an answer already made is kept as it is.
    const made = new AppError('NOT_FOUND', 'Connection not found', 404)
    expect(connectionAppError(made)).toBe(made)
  })

  // Fourth review (minor 2): a live sync's plan asked for its source's client bare, and a failure
  // to open it answered 500, an error of ours.
  it('answers a live sync planned on a connection that cannot open as the connection’s failure', async () => {
    // Fifth review (nit 4): a stall longer than the selection would answer a timeout instead.
    const down = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=4000'
    const h = await liveSyncHarness(down, down)
    harnesses.push(h)
    const admin = h.user()
    const res = await admin.call(
      'POST',
      `/api/connections/${h.ids.A}/live-syncs/plan`,
      syncBody(h.ids, 'A', 'B', { db: 'live', coll: 'x' }),
    )
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json()).toMatchObject({ code: 'MONGO_ERROR', details: { kind: 'network' } })
  })

  // Sixth review of the open's stop (minor 2): a sync runs on its own, with no person behind it; a
  // per-person target was planned and made, and then could never open. Refused at the plan, before
  // either side is dialled.
  it('refuses a live sync onto a connection that signs each person in', async () => {
    const down = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=4000'
    const h = await liveSyncHarness(down, down)
    harnesses.push(h)
    const oidc = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'localhost', port: 27017 }],
      auth: { mechanism: 'MONGODB-OIDC' },
    })
    h.ctx.connections.update(h.ids.B, { settings: oidc })
    const dialled = vi.spyOn(h.ctx.manager, 'getClient')
    const res = await h
      .user()
      .call(
        'POST',
        `/api/connections/${h.ids.A}/live-syncs/plan`,
        syncBody(h.ids, 'A', 'B', { db: 'live', coll: 'x' }),
      )
    expect(res.statusCode, res.body).toBe(502)
    expect(res.json()).toMatchObject({ details: { kind: 'oidc', reason: 'oidc_per_person' } })
    expect(dialled).not.toHaveBeenCalled()
    // Seventh review (minor 1): to someone who may not see the target, it is not there at all, as
    // any other connection they may not see (no word of how it signs in).
    const outsider = h.user({ role: 'editor', on: { A: 'admin', B: 'none' } })
    const hidden = await outsider.call(
      'POST',
      `/api/connections/${h.ids.A}/live-syncs/plan`,
      syncBody(h.ids, 'A', 'B', { db: 'live', coll: 'x' }),
    )
    expect(hidden.statusCode, hidden.body).toBe(404)
    expect(hidden.body).not.toMatch(/oidc/)
  })

  // Seventh review (nit): an edit making a connection per-person is read as such at once, not only
  // once what runs before its clients close has run.
  it('reads how a connection signs in afresh as soon as its settings are saved', async () => {
    const down = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=4000'
    const h = await liveSyncHarness(down, down)
    harnesses.push(h)
    expect(h.ctx.manager.perPerson(h.ids.B)).toBe(false)
    let during: boolean | undefined
    vi.spyOn(h.ctx.oidc, 'forgetConnection').mockImplementation(async () => {
      during = h.ctx.manager.perPerson(h.ids.B)
    })
    const res = await h.user().call('PATCH', `/api/connections/${h.ids.B}`, {
      settings: { hosts: [{ host: 'localhost', port: 27017 }], auth: { mechanism: 'MONGODB-OIDC' } },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(during).toBe(true)
  })

  // Fifth review (minor 2): the other requests of a live sync that ask for a client.
  it(
    'answers finishing a live sync, or taking its new options, on a source that cannot open',
    async () => {
      const down = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=4000'
      const h = await liveSyncHarness(down, down)
      harnesses.push(h)
      const admin = h.user()
      const { ctx } = h
      // Sixth review (nit 5): what the manager answers, whatever a socket's timing.
      vi.spyOn(ctx.manager, 'getClient').mockRejectedValue(
        new ConnectionError('network', 'Could not reach the server'),
      )
      const sync = () =>
        ctx.liveSync.repo.create({
          owner: admin.id,
          name: 'live.orders ⇄ orders',
          source: { connectionId: h.ids.A, db: 'live', coll: 'orders', collections: null },
          target: { connectionId: h.ids.B, db: 'copy', coll: 'orders' },
          options: {
            startMode: 'from_now',
            errorPolicy: 'pause',
            followNew: false,
            anonymous: false,
            masked: false,
            pairs: [['orders', 'orders']],
          },
          stamps: {
            versions: {
              source: ctx.personalFields.get(h.ids.A).version,
              target: ctx.personalFields.get(h.ids.B).version,
            },
            settings: {
              source: settingsStamp(ctx.connections.get(h.ids.A)!.settings),
              target: settingsStamp(ctx.connections.get(h.ids.B)!.settings),
            },
            deployments: {
              source: { kind: 'replicaSet', setName: 'a', hosts: ['a:1'] },
              target: { kind: 'replicaSet', setName: 'b', hosts: ['b:1'] },
            },
          },
          state: 'live',
          startAt: '1000.0',
          copyJobId: null,
        })
      const live = sync()
      const finished = await admin.call('POST', `/api/live-syncs/${live.id}/finish`, {})
      expect(finished.statusCode, finished.body).toBe(502)
      expect(finished.json()).toMatchObject({ code: 'MONGO_ERROR', details: { kind: 'network' } })
      const waiting = sync()
      ctx.liveSync.repo.update(waiting.id, {
        skip: { id: SCHEMA_SKIP, at: '1000.1', armed: false, ns: 'orders' },
      })
      ctx.liveSync.repo.setState(waiting.id, 'attention', 'schema_changed', 'live.orders')
      const applied = await admin.call('POST', `/api/live-syncs/${waiting.id}/apply-schema`, {
        ignore: false,
      })
      expect(applied.statusCode, applied.body).toBe(502)
      expect(applied.json()).toMatchObject({ code: 'MONGO_ERROR', details: { kind: 'network' } })
    },
    slow(45_000),
  )

  // A check whose open was stopped says nothing of the server: the next look checks again.
  it('keeps no health of a check whose open was stopped', async () => {
    let opens = 0
    const manager = {
      hold: () => () => undefined,
      isOpen: () => true,
      version: async () => null,
      getClient: async () => {
        opens++
        throw new ConnectionError('closed', CHANGED.message)
      },
    } as unknown as ConnectionManager
    const health = new HealthCache({ manager, now: () => 0 })
    // Not down either (second review, minor 2): nothing was learnt of the server.
    expect(await health.get('c1', true)).toMatchObject({ state: 'idle' })
    await health.get('c1', true)
    expect(opens).toBe(2)
  })

  // Review of the open's stop (minor 3): a name, a colour, a star is no change of the connection:
  // its client, its feeds and its health stay.
  it('closes nothing for an edit that leaves the settings as they are', async () => {
    const t = await makeApp()
    apps.push(t)
    const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      t.app.inject({ method, url, headers: { ...H, 'x-csrf-token': t.app.ctx.localCsrfToken }, payload })
    const settings = {
      hosts: [{ host: 'h' }],
      auth: { mechanism: 'DEFAULT', username: 'u', password: 'secret-pw' },
    }
    const dto = (await call('POST', '/api/connections', { name: 'X', settings })).json()
    expect(dto.settings.auth.password).not.toBe('secret-pw')
    const invalidate = vi.spyOn(t.app.ctx.manager, 'invalidate')
    const closeFor = vi.spyOn(t.app.ctx.watch, 'closeFor')
    const forget = vi.spyOn(t.app.ctx.health, 'forget')
    const shells = vi.spyOn(t.app.ctx.shell, 'closeFor')
    const signIns = vi.spyOn(t.app.ctx.oidc, 'forgetConnection')
    const previews = vi.spyOn(t.app.ctx.aggregation.cache, 'bump')
    // The connection dialog sends the name with the settings as they came, secrets masked.
    const asSent = { name: 'Z', settings: dto.settings }
    for (const patch of [asSent, { name: 'Y' }, { favorite: true }, { color: 'red' }, { group: 'G' }]) {
      expect((await call('PATCH', `/api/connections/${dto.id}`, patch)).statusCode).toBe(200)
    }
    expect(t.app.ctx.connections.get(dto.id)).toMatchObject({ name: 'Y', favorite: true, color: 'red' })
    expect(invalidate).not.toHaveBeenCalled()
    expect(closeFor).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(shells).not.toHaveBeenCalled()
    expect(signIns).not.toHaveBeenCalled()
    expect(previews).not.toHaveBeenCalled()
    // Read-only now: a shell opened under the old rules closes; the client stays.
    expect((await call('PATCH', `/api/connections/${dto.id}`, { readOnly: true })).statusCode).toBe(200)
    expect(shells).toHaveBeenCalledWith({ connectionId: dto.id }, 'access')
    expect(invalidate).not.toHaveBeenCalled()
    // Fourth review (nit 4): properties the form gives back in its own spacing are the same ones.
    const aws = (
      await call('POST', '/api/connections', {
        name: 'AWS',
        settings: {
          hosts: [{ host: 'h' }],
          auth: {
            mechanism: 'MONGODB-AWS',
            username: 'AKIA-key',
            password: 'aws-secret',
            mechanismProperties: 'AWS_SESSION_TOKEN:t, SERVICE_NAME:y',
          },
        },
      })
    ).json()
    expect(aws.id, JSON.stringify(aws)).toEqual(expect.any(String))
    expect(t.app.ctx.connections.get(aws.id)?.settings.auth.mechanismProperties).toContain(', ')
    expect((await call('PATCH', `/api/connections/${aws.id}`, { settings: aws.settings })).statusCode).toBe(
      200,
    )
    // Stored before a setting had a default (TLS's two allowances): saved as it is, not moved either.
    const stored = t.app.ctx.connections.get(dto.id)!.settings
    t.app.ctx.connections.update(dto.id, { settings: { ...stored, tls: { enabled: false } } as never })
    expect(t.app.ctx.connections.get(dto.id)?.settings.tls).toEqual({ enabled: false })
    expect((await call('PATCH', `/api/connections/${dto.id}`, { settings: dto.settings })).statusCode).toBe(
      200,
    )
    expect(invalidate).not.toHaveBeenCalled()
    // Fifth review (minor 3): a pinned SSH record stored before the port had its default, saved from
    // the form (the port filled in, no pin, the password masked), keeps its pin.
    const tunnelled = (
      await call('POST', '/api/connections', {
        name: 'T',
        settings: {
          hosts: [{ host: 'db' }],
          ssh: { enabled: true, host: 'bastion', username: 'u', method: 'password', password: 'ssh-pw' },
        },
      })
    ).json()
    const kept = t.app.ctx.connections.get(tunnelled.id)!.settings
    const { port: _port, ...portless } = { ...kept.ssh!, hostFingerprint: 'SHA256:pinned' }
    void _port
    t.app.ctx.connections.update(tunnelled.id, { settings: { ...kept, ssh: portless } as never })
    const { hostFingerprint: _pin, ...fromForm } = tunnelled.settings.ssh
    void _pin
    const resaved = await call('PATCH', `/api/connections/${tunnelled.id}`, {
      settings: { ...tunnelled.settings, ssh: fromForm },
    })
    expect(resaved.statusCode, resaved.body).toBe(200)
    expect(t.app.ctx.connections.get(tunnelled.id)?.settings.ssh?.hostFingerprint).toBe('SHA256:pinned')
    // The stored secret was kept for the masked one.
    expect(t.app.ctx.connections.get(dto.id)?.settings.auth.password).toBe('secret-pw')
    // Another server: its secret is given again (a masked one is not sent to another host).
    const moved = {
      ...dto.settings,
      hosts: [{ host: 'other', port: 27017 }],
      auth: { ...dto.settings.auth, password: 'secret-pw' },
    }
    expect((await call('PATCH', `/api/connections/${dto.id}`, { settings: moved })).statusCode).toBe(200)
    expect(invalidate).toHaveBeenCalledWith(dto.id)
    expect(closeFor).toHaveBeenCalledWith(dto.id, 'connection')
    expect(forget).toHaveBeenCalledWith(dto.id)
    expect(signIns).toHaveBeenCalledWith(dto.id)
    expect(previews).toHaveBeenCalled()
  })
})
