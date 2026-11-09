// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { openSshTunnel } from '../src/connections/ssh'
import { openUpstream } from '../src/shell/proxy/upstream'
import { startTlsMongo } from './support/tls'
import { startSshServer, type TestSshServer } from './support/ssh-server'
import type { TestMongo } from './support/mongo'
import { slow } from './support/slowness'

// Review of the deferred fixes (I1): the shell proxy reaches an SSH connection's MongoDB through the
// tunnel's SOCKS5 endpoint, then TLS over that socket. TLS must still check the real host's
// certificate, and the connected socket must keep no timeout (an idle shell is not cut).
let mongo: TestMongo & { caPem: string }
let sshd: TestSshServer
beforeAll(async () => {
  mongo = await startTlsMongo()
  sshd = await startSshServer({ password: 'tunnel-pass' })
}, slow(120_000))
afterAll(async () => {
  await sshd?.close()
  await mongo?.stop()
})

const ssh = () => ({
  enabled: true,
  host: '127.0.0.1',
  port: sshd.port,
  username: 'tunnel',
  method: 'password' as const,
  password: 'tunnel-pass',
})
const settings = () =>
  ConnectionSettingsSchema.parse({
    hosts: [{ host: 'localhost', port: mongo.port }],
    tls: { enabled: true },
    ssh: ssh(),
  })

describe('the shell proxy over an SSH tunnel with TLS', () => {
  it('checks the real host’s certificate and keeps no timeout once connected', async () => {
    const tunnel = await openSshTunnel(ssh(), { host: 'localhost', port: mongo.port })
    try {
      const up = await openUpstream(settings(), '127.0.0.1', tunnel.localPort, {
        appName: 'mm-shell:test',
        tls: { ca: mongo.caPem, servername: 'localhost' },
        socks: tunnel.credentials,
      })
      expect(up.hello.isWritablePrimary ?? up.hello.ismaster).toBe(true)
      expect(up.socket.timeout ?? 0).toBe(0)
      up.socket.destroy()

      await expect(
        openUpstream(settings(), '127.0.0.1', tunnel.localPort, {
          appName: 'mm-shell:test',
          tls: { ca: mongo.caPem, servername: 'not-the-server.example' },
          socks: tunnel.credentials,
          connectTimeoutMs: 5_000,
        }),
      ).rejects.toThrow(/altnames|certificate|not-the-server/i)
    } finally {
      await tunnel.close()
    }
  })
})
