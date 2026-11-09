// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSettingsSchema, maskSecrets } from '@mongo-manager/shared'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Security audit 2026-10-16 (minor): connection tests share eight slots on the server; one user (a
 * viewer may test a connection) runs one at a time, so no one user can hold them all.
 */
const apps: TestApp[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp({ auth: true })
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'C',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const as = (role: 'viewer' | 'admin') => {
    const u = ctx.users.create({ username: `u-${role}-${Math.random()}`, passwordHash: 'x', role })
    if (role === 'viewer') ctx.grants.set(connectionId, u.id, 'viewer')
    const { sessionId, session } = ctx.sessions.create(u.id, {})
    return () =>
      t.app.inject({
        method: 'POST',
        url: `/api/connections/${connectionId}/test`,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
      })
  }
  return { t, ctx, as }
}

describe('security audit 2026-10-16: connection tests, one at a time per user', () => {
  it('runs one test of a user at a time; the others answer busy at once, and another user still tests', async () => {
    const { ctx, as } = await setup()
    let finish!: () => void
    const pending = new Promise<void>((r) => (finish = r))
    const test = vi.spyOn(ctx.manager, 'test').mockImplementation(async () => {
      await pending
      return { ok: true } as never
    })
    const viewer = as('viewer')
    const first = viewer()
    await new Promise((r) => setTimeout(r, 50))
    const more = await Promise.all([viewer(), viewer(), viewer()])
    for (const res of more) expect(res.json()).toMatchObject({ ok: false, error: { kind: 'busy' } })
    expect(test).toHaveBeenCalledTimes(1)
    // Someone else is not held back by the viewer.
    const other = as('admin')()
    await new Promise((r) => setTimeout(r, 50))
    expect(test).toHaveBeenCalledTimes(2)
    finish()
    expect((await first).json()).toMatchObject({ ok: true })
    expect((await other).json()).toMatchObject({ ok: true })
    // Its slot is back once its test answered.
    expect((await viewer()).json()).toMatchObject({ ok: true })
  })

  // Independent review of the security pass (I4): trust on first use of an SSH host key. A test fills
  // the form's pin before the record has one, and a form loaded before the first connect has none
  // while the record was pinned since: neither is another server, both keep the stored password.
  it('keeps the stored password across the first pin of an SSH host key, both ways', async () => {
    const { t, ctx } = await setup()
    const ssh = {
      enabled: true,
      host: 'bastion',
      port: 22,
      username: 'u',
      method: 'password',
      password: 'ssh-pw',
    }
    const make = (hostFingerprint?: string) =>
      ctx.connections.create(
        {
          name: 'S',
          favorite: false,
          readOnly: false,
          settings: ConnectionSettingsSchema.parse({
            hosts: [{ host: 'db.internal', port: 27017 }],
            auth: { mechanism: 'DEFAULT', username: 'app', password: 'db-pw' },
            ssh: { ...ssh, ...(hostFingerprint ? { hostFingerprint } : {}) },
          }),
        },
        null,
      )
    const u = ctx.users.create({ username: 'adm2', passwordHash: 'x', role: 'admin' })
    const { sessionId, session } = ctx.sessions.create(u.id, {})
    const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      t.app.inject({
        method,
        url,
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload,
      })
    const test = vi.spyOn(ctx.manager, 'test').mockResolvedValue({ ok: true } as never)
    // (a) Unpinned: the test dialog learned the pin; the next test and save keep the password.
    const unpinned = make()
    const learned = maskSecrets(unpinned.settings)
    learned.ssh = { ...learned.ssh!, hostFingerprint: 'SHA256:learned' }
    const tested = await call('POST', '/api/connections/test', {
      connectionId: unpinned.id,
      settings: learned,
    })
    expect(tested.statusCode, tested.body).toBe(200)
    const saved = await call('PATCH', `/api/connections/${unpinned.id}`, { settings: learned })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(ctx.connections.get(unpinned.id)!.settings).toMatchObject({
      auth: { password: 'db-pw' },
      ssh: { password: 'ssh-pw', hostFingerprint: 'SHA256:learned' },
    })
    // (b) A form loaded before the first connect pinned the record: saved, the pin kept.
    const pinned = make('SHA256:pinned')
    const stale = maskSecrets(pinned.settings)
    stale.ssh = { ...stale.ssh!, hostFingerprint: undefined }
    const kept = await call('PATCH', `/api/connections/${pinned.id}`, {
      settings: { ...stale, appName: 'x' },
    })
    expect(kept.statusCode, kept.body).toBe(200)
    expect(ctx.connections.get(pinned.id)!.settings).toMatchObject({
      auth: { password: 'db-pw' },
      ssh: { hostFingerprint: 'SHA256:pinned' },
    })
    // Second review (minor): a test of the pinned record from a form without the pin still checks the
    // host key it pinned — never the stored SSH key and passwords with no host-key check.
    const testedStale = await call('POST', '/api/connections/test', {
      connectionId: pinned.id,
      settings: stale,
    })
    expect(testedStale.statusCode, testedStale.body).toBe(200)
    expect(test.mock.calls.at(-1)![0]).toMatchObject({
      auth: { password: 'db-pw' },
      ssh: { password: 'ssh-pw', hostFingerprint: 'SHA256:pinned' },
    })
    // Another host key: the password must be typed again.
    const other = maskSecrets(pinned.settings)
    other.ssh = { ...other.ssh!, hostFingerprint: 'SHA256:other' }
    const refused = await call('PATCH', `/api/connections/${pinned.id}`, { settings: other })
    expect(refused.json()).toMatchObject({ details: { reason: 'masked_secret_reuse' } })
  })

  // Security audit 2026-10-16 (minor): an administrator's session cannot test the stored password over
  // a transport it loosened (TLS off, its own CA) without typing the password again.
  it('refuses a stored password for a test whose TLS settings changed', async () => {
    const { t, ctx } = await setup()
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: 'ldap.example', port: 27017 }],
      auth: { mechanism: 'PLAIN', username: 'app', password: 'ldap-secret', authSource: '$external' },
      tls: { enabled: true },
    })
    const id = ctx.connections.create({ name: 'L', favorite: false, readOnly: false, settings }, null).id
    const u = ctx.users.create({ username: 'adm', passwordHash: 'x', role: 'admin' })
    const { sessionId, session } = ctx.sessions.create(u.id, {})
    const test = vi.spyOn(ctx.manager, 'test').mockResolvedValue({ ok: true } as never)
    const masked = maskSecrets(settings)
    const call = (s: object) =>
      t.app.inject({
        method: 'POST',
        url: '/api/connections/test',
        headers: { ...H, 'x-csrf-token': session.csrfToken },
        cookies: { mm_sid: sessionId },
        payload: { connectionId: id, settings: s },
      })
    for (const tls of [
      { enabled: false },
      { enabled: true, caPem: 'x' },
      { enabled: true, allowInvalidCertificates: true },
    ]) {
      const res = await call({ ...masked, tls })
      expect(res.statusCode).toBe(400)
      expect(res.json().details).toMatchObject({ reason: 'masked_secret_reuse' })
    }
    expect(test).not.toHaveBeenCalled()
    expect((await call(masked)).statusCode).toBe(200)
    expect(test.mock.calls[0]![0]).toMatchObject({ auth: { password: 'ldap-secret' } })
  })
})
