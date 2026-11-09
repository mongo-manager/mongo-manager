// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema, type ConnectionSettings } from '@mongo-manager/shared'
import { buildUpstreamPlan } from '../src/shell/plan'

const base = (over: Record<string, unknown> = {}): ConnectionSettings =>
  ConnectionSettingsSchema.parse({ hosts: [{ host: 'db1', port: 27017 }], ...over }) as ConnectionSettings

describe('buildUpstreamPlan (phase 3a-1 §5)', () => {
  it('refuses GSSAPI, AWS and OIDC connections', async () => {
    for (const mechanism of ['GSSAPI', 'MONGODB-AWS', 'MONGODB-OIDC']) {
      await expect(
        buildUpstreamPlan({
          // As stored: a Kerberos connection saved before the input schema refused it.
          settings: { ...base(), auth: { mechanism, username: 'u', password: 'p' } } as ConnectionSettings,
          readOnly: false,
          admin: true,
        }),
      ).rejects.toMatchObject({ code: 'SHELL_UNSUPPORTED_AUTH' })
    }
  })

  it('allows the declared hosts and the discovered topology, and nothing else', async () => {
    const client = {
      topology: {
        description: {
          servers: new Map([
            ['db2:27017', {}],
            ['db3:27017', {}],
          ]),
        },
      },
    }
    const plan = await buildUpstreamPlan({
      settings: base(),
      readOnly: false,
      admin: true,
      client: client as never,
    })
    expect(plan.allowHost('db1', 27017)).toBe(true)
    expect(plan.allowHost('db2', 27017)).toBe(true)
    expect(plan.allowHost('db3', 27017)).toBe(true)
    expect(plan.allowHost('evil.example.com', 27017)).toBe(false)
    expect(plan.allowHost('db1', 9999)).toBe(false)
  })

  it('reads the topology live, so a member added after the shell opened becomes reachable (review I4)', async () => {
    const servers = new Map<string, unknown>([['db1:27017', {}]])
    const client = { topology: { description: { servers } } }
    const plan = await buildUpstreamPlan({
      settings: base(),
      readOnly: false,
      admin: true,
      client: client as never,
    })
    // A replica-set member not yet known is refused...
    expect(plan.allowHost('db4', 27017)).toBe(false)
    // ...until the driver's topology discovers it (a failover or a reconfig adds a member).
    servers.set('db4:27017', {})
    expect(plan.allowHost('db4', 27017)).toBe(true)
    // An unrelated host is still refused.
    expect(plan.allowHost('evil.example.com', 27017)).toBe(false)
  })

  it('passes TLS material for a TLS connection and none otherwise', async () => {
    const plain = await buildUpstreamPlan({ settings: base(), readOnly: false, admin: true })
    expect(plain.tls).toBeNull()
    const tls = await buildUpstreamPlan({
      settings: base({
        tls: { enabled: true, caPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----' },
      }),
      readOnly: false,
      admin: true,
    })
    expect(tls.tls).not.toBeNull()
    expect(tls.tls?.servername).toBe('db1')
  })

  it('carries the caller read-only and admin flags', async () => {
    const plan = await buildUpstreamPlan({ settings: base(), readOnly: true, admin: false })
    expect(plan.readOnly).toBe(true)
    expect(plan.admin).toBe(false)
  })

  const ssh = (over: Record<string, unknown> = {}): ConnectionSettings =>
    base({
      ssh: { enabled: true, host: 'bastion', port: 22, username: 'jump', method: 'password', password: 'p' },
      ...over,
    })

  it('dials the per-session SSH tunnel and releases it, while the allow-list stays the declared host', async () => {
    let closed = 0
    const opened: Array<{ host: string; port: number }> = []
    const openTunnel = async (_s: unknown, target: { host: string; port: number }) => {
      opened.push(target)
      return {
        localPort: 51820,
        credentials: { username: 'mm-u', password: 'p' },
        fingerprint: 'SHA256:x',
        onClose: () => undefined,
        close: async () => {
          closed++
        },
      }
    }
    const plan = await buildUpstreamPlan({
      settings: ssh(),
      readOnly: false,
      admin: true,
      openTunnel: openTunnel as never,
    })
    // The tunnel is opened for the declared MongoDB host, not the bastion.
    expect(opened).toEqual([{ host: 'db1', port: 27017 }])
    // Every dial goes to the local tunnel endpoint; DNS never resolves the real host in the worker.
    expect(plan.dial?.('db1', 27017)).toEqual({
      host: '127.0.0.1',
      port: 51820,
      socks: { username: 'mm-u', password: 'p' },
    })
    // The worker still names the real host (the proxy maps it), and no other host is reachable.
    expect(plan.allowHost('db1', 27017)).toBe(true)
    expect(plan.allowHost('bastion', 22)).toBe(false)
    expect(plan.allowHost('127.0.0.1', 51820)).toBe(false)
    plan.release?.()
    expect(closed).toBe(1)
  })

  it('refuses the shell for an SSH connection when no tunnel opener is available', async () => {
    await expect(buildUpstreamPlan({ settings: ssh(), readOnly: false, admin: true })).rejects.toMatchObject({
      code: 'SHELL_UNSUPPORTED_AUTH',
    })
  })
})
