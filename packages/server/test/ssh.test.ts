import net from 'node:net'
import { BSON } from 'bson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { ConnectionManager } from '../src/connections/manager'
import { openSshTunnel } from '../src/connections/ssh'
import { openUpstream } from '../src/shell/proxy/upstream'
import { startMongo, type TestMongo } from './support/mongo'
import { sshKeyPair, startSshServer, type TestSshServer } from './support/ssh-server'

const clientKey = sshKeyPair()
let mongo: TestMongo
let sshd: TestSshServer
beforeAll(async () => {
  mongo = await startMongo()
  sshd = await startSshServer({ password: 'tunnel-pass', publicKey: clientKey.public })
})
afterAll(async () => {
  await sshd?.close()
  await mongo?.stop()
})

const viaSsh = (ssh: object) =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: '127.0.0.1', port: mongo.port }],
    serverSelectionTimeoutMS: 3_000,
    ssh: { enabled: true, host: '127.0.0.1', port: sshd.port, username: 'tunnel', ...ssh },
  })

describe('SSH tunnel', () => {
  // A loaded parallel coverage run can pass the 6 s product deadline; this suite tests the tunnel.
  const manager = new ConnectionManager({
    load: () => undefined,
    openTunnel: openSshTunnel,
    testTimeoutMs: 20_000,
  })

  it('connects through the tunnel with a password and reports the host fingerprint', async () => {
    const result = await manager.test(viaSsh({ method: 'password', password: 'tunnel-pass' }))
    expect(result).toMatchObject({ ok: true, sshFingerprint: sshd.fingerprint })
  })

  it('connects with a private key', async () => {
    const result = await manager.test(viaSsh({ method: 'privateKey', privateKey: clientKey.private }))
    expect(result.ok).toBe(true)
  })

  it('reports a wrong password as an ssh error', async () => {
    expect(await manager.test(viaSsh({ method: 'password', password: 'wrong' }))).toMatchObject({
      ok: false,
      error: { kind: 'ssh' },
    })
  })

  it('refuses a changed host key and names the new fingerprint (Review Focus 4)', async () => {
    const result = await manager.test(
      viaSsh({ method: 'password', password: 'tunnel-pass', hostFingerprint: 'SHA256:somethingElse' }),
    )
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'ssh-host-key', sshFingerprint: sshd.fingerprint },
    })
    if (!result.ok) expect(result.error.message).toContain(sshd.fingerprint)
  })

  it('pins the fingerprint on first use of a saved connection', async () => {
    const pinned: string[] = []
    const saved = new ConnectionManager({
      load: () => ({ settings: viaSsh({ method: 'password', password: 'tunnel-pass' }) }),
      openTunnel: openSshTunnel,
      pinFingerprint: (_id, fp) => pinned.push(fp),
    })
    const client = await saved.getClient('c1')
    expect((await client.db('admin').command({ ping: 1 })).ok).toBe(1)
    expect(pinned).toEqual([sshd.fingerprint])
    await saved.closeAll()
  })

  // Plan 1c deferred minor: the tunnel's local port forwarded anyone on the machine to the database,
  // which behind a bastion often has no sign-in of its own. It now answers only to its own
  // credentials, made for each tunnel.
  describe('the local endpoint, reached by another program on the machine', () => {
    const settings = {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      username: 'tunnel',
      method: 'password' as const,
      password: 'tunnel-pass',
    }
    /** Sends bytes to the tunnel's port and collects all it answers until it closes the socket. */
    const knock = (port: number, bytes: Buffer, later?: Buffer) =>
      new Promise<Buffer>((resolve) => {
        const got: Buffer[] = []
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(bytes)
          if (later) setTimeout(() => socket.write(later), 50)
        })
        socket.on('data', (d: Buffer) => got.push(d))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve(Buffer.concat(got)))
        setTimeout(() => socket.destroy(), 3_000)
      })
    // A MongoDB hello, as a client that knows nothing of the tunnel would send it.
    const hello = () => {
      const body = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), BSON.serialize({ hello: 1, $db: 'admin' })])
      const header = Buffer.alloc(16)
      header.writeInt32LE(16 + body.length, 0)
      header.writeInt32LE(1, 4)
      header.writeInt32LE(2013, 12)
      return Buffer.concat([header, body])
    }

    it('forwards nothing to a plain MongoDB client', async () => {
      const tunnel = await openSshTunnel(
        { ...settings, port: sshd.port },
        { host: '127.0.0.1', port: mongo.port },
      )
      try {
        const answer = await knock(tunnel.localPort, hello())
        expect(answer.length).toBe(0)
      } finally {
        await tunnel.close()
      }
    })

    it('refuses a proxy client without credentials, or with wrong ones', async () => {
      const tunnel = await openSshTunnel(
        { ...settings, port: sshd.port },
        { host: '127.0.0.1', port: mongo.port },
      )
      try {
        // Offers "no authentication" only: no acceptable method.
        expect([...(await knock(tunnel.localPort, Buffer.from([5, 1, 0]), hello()))]).toEqual([5, 0xff])
        const user = Buffer.from(tunnel.credentials.username)
        const wrong = Buffer.from('not-the-password')
        const auth = Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([wrong.length]), wrong])
        const answer = await knock(tunnel.localPort, Buffer.concat([Buffer.from([5, 1, 2]), auth]), hello())
        expect([...answer]).toEqual([5, 2, 1, 1])
      } finally {
        await tunnel.close()
      }
    })

    it('lets the shell proxy through with the tunnel’s credentials', async () => {
      const tunnel = await openSshTunnel(
        { ...settings, port: sshd.port },
        { host: '127.0.0.1', port: mongo.port },
      )
      try {
        const sshSettings = viaSsh({ method: 'password', password: 'tunnel-pass' })
        const up = await openUpstream(sshSettings, '127.0.0.1', tunnel.localPort, {
          appName: 'mm-shell:test',
          tls: null,
          socks: tunnel.credentials,
        })
        expect(up.hello.isWritablePrimary ?? up.hello.ismaster).toBe(true)
        up.socket.destroy()
      } finally {
        await tunnel.close()
      }
    })

    // Review of the deferred fixes (M3): any program may connect, so only so many may be half-way.
    it('refuses handshakes beyond its limit while others are under way', async () => {
      const tunnel = await openSshTunnel(
        { ...settings, port: sshd.port },
        { host: '127.0.0.1', port: mongo.port },
      )
      const idle: net.Socket[] = []
      try {
        for (let i = 0; i < 32; i++) {
          const s = net.connect(tunnel.localPort, '127.0.0.1')
          s.on('error', () => undefined)
          await new Promise((r) => s.once('connect', r))
          idle.push(s)
        }
        await new Promise((r) => setTimeout(r, 100))
        const closedAt = await new Promise<number>((resolve) => {
          const start = Date.now()
          const s = net.connect(tunnel.localPort, '127.0.0.1')
          s.on('error', () => undefined)
          s.on('close', () => resolve(Date.now() - start))
        })
        expect(closedAt).toBeLessThan(1_000)
        expect(idle.every((s) => !s.destroyed)).toBe(true)
      } finally {
        for (const s of idle) s.destroy()
        await tunnel.close()
      }
    })

    // Review of the deferred fixes (M4): a client gone while its channel opened left the channel open.
    it('closes a channel whose client left before it opened', async () => {
      const tunnel = await openSshTunnel(
        { ...settings, port: sshd.port },
        { host: '127.0.0.1', port: mongo.port },
      )
      sshd.forwarding.delayMs = 300
      try {
        const user = Buffer.from(tunnel.credentials.username)
        const pass = Buffer.from(tunnel.credentials.password)
        const s = net.connect(tunnel.localPort, '127.0.0.1', () =>
          s.write(
            Buffer.concat([
              Buffer.from([5, 1, 2, 1, user.length]),
              user,
              Buffer.from([pass.length]),
              pass,
              Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 1]),
            ]),
          ),
        )
        s.on('error', () => undefined)
        await new Promise((r) => setTimeout(r, 100))
        s.destroy()
        await new Promise((r) => setTimeout(r, 900))
        expect(sshd.channels).toBe(0)
      } finally {
        sshd.forwarding.delayMs = 0
        await tunnel.close()
      }
    })

    it('makes new credentials for every tunnel', async () => {
      const a = await openSshTunnel({ ...settings, port: sshd.port }, { host: '127.0.0.1', port: mongo.port })
      const b = await openSshTunnel({ ...settings, port: sshd.port }, { host: '127.0.0.1', port: mongo.port })
      try {
        expect(a.credentials.password).toMatch(/^[A-Za-z0-9_-]{32,}$/)
        expect(a.credentials.password).not.toBe(b.credentials.password)
        expect(a.credentials.username).not.toBe(b.credentials.username)
      } finally {
        await a.close()
        await b.close()
      }
    })
  })

  it('closes cleanly with no stray socket errors', async () => {
    const tunnel = await openSshTunnel(
      {
        enabled: true,
        host: '127.0.0.1',
        port: sshd.port,
        username: 'tunnel',
        method: 'password',
        password: 'tunnel-pass',
      },
      { host: '127.0.0.1', port: mongo.port },
    )
    await tunnel.close()
    await tunnel.close()
  })
})
