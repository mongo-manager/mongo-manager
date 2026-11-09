// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { kitLine } from '../src/backup/keys/kit'
import { confirmedKey, teamApp } from './support/schedules'

describe('backup key routes (phase 3d-3c spec §3.4, §3.5, D1)', () => {
  it('creates a key with its kit once, confirms it with the last group, and lists it without key material', async () => {
    const { t, ctx, user } = await teamApp()
    try {
      const u = user()
      const res = await u.call('POST', '/api/backup-keys', { name: 'Laptop key' })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.headers['cache-control']).toBe('no-store')
      const created = res.json()
      expect(created.key).toMatchObject({
        name: 'Laptop key',
        state: 'pending',
        uses: { schedules: 0, backups: 0 },
      })
      expect(created.fileName).toBe(`mongo-manager-backup-key-${created.key.fingerprint}.txt`)
      expect(created.kit).toContain(`User:         ${u.username}`)
      expect(created.kit).toContain('Installation: localhost')
      const line = created.kit.match(/MMKEY1-\S+/)![0] as string
      const wrong = await u.call('POST', `/api/backup-keys/${created.key.id}/confirm`, { check: 'ZZZZ' })
      expect(wrong.statusCode).toBe(400)
      expect(wrong.json().details.reason).toBe('key_check')
      const ok = await u.call('POST', `/api/backup-keys/${created.key.id}/confirm`, { check: line.slice(-4) })
      expect(ok.json().state).toBe('active')
      const listed = await u.get('/api/backup-keys')
      expect(listed.json()).toEqual([expect.objectContaining({ id: created.key.id, state: 'active' })])
      expect(listed.body).not.toContain(line.slice(7, 30))
      const audit = ctx.store.db
        .prepare(
          "SELECT action, outcome, details FROM audit_log WHERE action LIKE 'backup.key.%' ORDER BY id",
        )
        .all() as Array<{ action: string; outcome: string; details: string }>
      expect(audit.map((a) => `${a.action}:${a.outcome}`)).toEqual([
        'backup.key.create:success',
        'backup.key.confirm:failure',
        'backup.key.confirm:success',
      ])
      for (const a of audit) expect(a.details).not.toContain(line.slice(7, 30))
      for (const a of audit.filter((x) => x.outcome === 'success'))
        expect(JSON.parse(a.details)).toMatchObject({
          name: 'Laptop key',
          fingerprint: created.key.fingerprint,
        })
    } finally {
      await t.close()
    }
  })

  it('lets only the owner see, use and change a key — administrators included (D3)', async () => {
    const { t, user } = await teamApp()
    try {
      const owner = user()
      const admin = user('admin')
      const k = await confirmedKey(owner)
      expect((await admin.get('/api/backup-keys')).json()).toEqual([])
      for (const [method, url] of [
        ['POST', `/api/backup-keys/${k.id}/retire`],
        ['POST', `/api/backup-keys/${k.id}/activate`],
        ['DELETE', `/api/backup-keys/${k.id}`],
      ] as const)
        expect((await admin.call(method, url)).statusCode, url).toBe(404)
      expect(
        (await admin.call('POST', `/api/backup-keys/${k.id}/confirm`, { check: 'AAAA' })).statusCode,
      ).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('rotates, retires, activates, imports and deletes', async () => {
    const { t, user } = await teamApp()
    try {
      const u = user()
      const first = await confirmedKey(u)
      const second = await confirmedKey(u)
      const states = async () =>
        Object.fromEntries(
          ((await u.get('/api/backup-keys')).json() as Array<{ id: string; state: string }>).map((k) => [
            k.id,
            k.state,
          ]),
        )
      expect(await states()).toEqual({ [first.id]: 'retired', [second.id]: 'active' })
      expect((await u.call('POST', `/api/backup-keys/${first.id}/activate`)).json().state).toBe('active')
      expect(await states()).toEqual({ [first.id]: 'active', [second.id]: 'retired' })
      const dup = await u.call('POST', '/api/backup-keys/import', { kit: second.kit })
      expect(dup.statusCode).toBe(409)
      expect(dup.json().details).toMatchObject({ reason: 'key_exists', name: 'Key 2' })
      const bad = await u.call('POST', '/api/backup-keys/import', { kit: 'MMKEY1-AAAA-BBBB' })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().details.reason).toBe('kit_format')
      const imported = await u.call('POST', '/api/backup-keys/import', {
        kit: kitLine(randomBytes(32)),
        name: 'Old server',
      })
      expect(imported.statusCode, imported.body).toBe(201)
      expect(imported.json()).toMatchObject({ name: 'Old server', state: 'imported' })
      expect((await u.call('POST', `/api/backup-keys/${first.id}/retire`)).json().state).toBe('retired')
      expect((await u.call('DELETE', `/api/backup-keys/${imported.json().id}`)).statusCode).toBe(204)
      expect(Object.keys(await states())).toHaveLength(2)
    } finally {
      await t.close()
    }
  })

  it('limits key creation and import to ten an hour per user (spec §3.4)', async () => {
    const { t, user } = await teamApp()
    try {
      const u = user()
      for (let i = 0; i < 5; i++) expect((await u.call('POST', '/api/backup-keys', {})).statusCode).toBe(201)
      for (let i = 0; i < 5; i++)
        expect(
          (await u.call('POST', '/api/backup-keys/import', { kit: kitLine(randomBytes(32)) })).statusCode,
        ).toBe(201)
      expect((await u.call('POST', '/api/backup-keys', {})).statusCode).toBe(429)
      expect((await user().call('POST', '/api/backup-keys', {})).statusCode).toBe(201)
      // An hour later the window has moved; the session is kept alive (15 minutes idle) by reading the list.
      for (let i = 0; i < 6; i++) {
        t.clock.now += 600_000
        expect((await u.get('/api/backup-keys')).statusCode).toBe(200)
      }
      t.clock.now += 1
      expect((await u.call('POST', '/api/backup-keys', {})).statusCode).toBe(201)
    } finally {
      await t.close()
    }
  })
})
