// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey } from '../src/crypto/rotate'
import { ConnectionRepo } from '../src/connections/repo'
import { BackupKeyRepo, MAX_KEYS_PER_USER, PENDING_TTL_MS } from '../src/backup/keys/repo'
import { backupKeyFingerprint, kitCheckGroup } from '../src/backup/keys/kit'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const failure = (fn: () => unknown): { status?: number; reason?: string; name?: string } => {
  try {
    fn()
  } catch (e) {
    const err = e as { statusCode?: number; details?: { reason?: string; name?: string } }
    return { status: err.statusCode, reason: err.details?.reason, name: err.details?.name }
  }
  return {}
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-keys-'))
  dirs.push(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir)
  const clock = { now: Date.UTC(2026, 9, 4) }
  const keys = new BackupKeyRepo(store.db, box, () => clock.now)
  const connection = new ConnectionRepo(store.db, box, () => clock.now).create(
    {
      name: 'A',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  )
  const schedule = (owner: string, keyId: string | null, state = 'active', reason: string | null = null) => {
    const id = randomUUID()
    store.db
      .prepare(
        `INSERT INTO backup_schedules (id, owner, connection_id, name, request, format, key_id, cadence, time_zone,
          destinations, keep_on_server, retention, state, pause_reason, paused_by, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, 'S', '{}', 'mmbak', ?, '{"kind":"daily","times":["02:00"]}', 'UTC', '[]', 0, '{}', ?, ?, ?, ?, 1, 1)`,
      )
      .run(
        id,
        owner,
        connection.id,
        keyId,
        state,
        reason,
        reason === 'owner' ? 'owner' : reason ? 'system' : null,
        state === 'active' ? 5 : null,
      )
    return id
  }
  const row = (id: string) =>
    store.db
      .prepare(
        'SELECT key_id, state, pause_reason, paused_by, next_run_at FROM backup_schedules WHERE id = ?',
      )
      .get(id) as {
      key_id: string | null
      state: string
      pause_reason: string | null
      paused_by: string | null
      next_run_at: number | null
    }
  const confirmed = (owner: string) => {
    const { record, key } = keys.create(owner)
    keys.confirm(owner, record.id, kitCheckGroup(key))
    return { id: record.id, key }
  }
  return { dir, store, keys, clock, schedule, row, confirmed }
}

describe('backup keys (phase 3d-3c spec §1.1, §3.1)', () => {
  it('creates a pending key that nothing can use until its kit is confirmed', async () => {
    const { store, keys } = await setup()
    try {
      const { record, key } = keys.create('u1')
      expect(record).toMatchObject({
        name: 'Key 1',
        state: 'pending',
        fingerprint: backupKeyFingerprint(key),
        confirmedAt: null,
      })
      expect(keys.open('u1', record.id)).toBeNull()
      expect(keys.active('u1')).toBeUndefined()
      expect(failure(() => keys.confirm('u1', record.id, 'WRONG'))).toMatchObject({
        status: 400,
        reason: 'key_check',
      })
      const done = keys.confirm('u1', record.id, ` ${kitCheckGroup(key).toLowerCase()} `)
      expect(done.record).toMatchObject({ state: 'active', confirmedAt: Date.UTC(2026, 9, 4) })
      expect(keys.open('u1', record.id)).toEqual(key)
      const sealed = (
        store.db.prepare('SELECT sealed_key FROM backup_keys WHERE id = ?').get(record.id) as {
          sealed_key: string
        }
      ).sealed_key
      expect(sealed).not.toContain(key.toString('base64'))
      expect(sealed).not.toContain(key.toString('hex'))
    } finally {
      store.close()
    }
  })

  it('opens a key for its owner only (D3)', async () => {
    const { store, keys, confirmed } = await setup()
    try {
      const { id } = confirmed('u1')
      expect(keys.open('u2', id)).toBeNull()
      expect(keys.get('u2', id)).toBeUndefined()
      expect(failure(() => keys.retire('u2', id))).toMatchObject({ status: 404 })
    } finally {
      store.close()
    }
  })

  it('moves the owner’s schedules to a confirmed new key, retiring the old one (plan ruling 9)', async () => {
    const { store, keys, schedule, row, confirmed } = await setup()
    try {
      const first = confirmed('u1')
      const mine = schedule('u1', first.id)
      const other = confirmed('u2')
      const theirs = schedule('u2', other.id)
      const second = keys.create('u1')
      keys.confirm('u1', second.record.id, kitCheckGroup(second.key))
      expect(keys.get('u1', first.id)).toMatchObject({ state: 'retired', retiredAt: Date.UTC(2026, 9, 4) })
      expect(keys.active('u1')?.id).toBe(second.record.id)
      expect(row(mine).key_id).toBe(second.record.id)
      expect(row(theirs).key_id).toBe(other.id)
      // A retired key still opens older backups on this server.
      expect(keys.open('u1', first.id)).toEqual(first.key)
    } finally {
      store.close()
    }
  })

  it('pauses schedules when the active key is retired, and resumes them when a key is activated', async () => {
    const { store, keys, schedule, row, confirmed } = await setup()
    try {
      const k = confirmed('u1')
      const s1 = schedule('u1', k.id)
      const byOwner = schedule('u1', k.id, 'paused', 'owner')
      expect(keys.retire('u1', k.id).paused).toEqual([s1])
      expect(row(s1)).toMatchObject({
        state: 'paused',
        pause_reason: 'key_inactive',
        paused_by: 'system',
        next_run_at: null,
      })
      expect(failure(() => keys.retire('u1', k.id))).toMatchObject({ status: 409, reason: 'key_state' })
      const { resumed } = keys.activate('u1', k.id)
      expect(resumed).toEqual([s1])
      // Active again; its next run is computed by the scheduler's next tick.
      expect(row(s1)).toMatchObject({ state: 'active', pause_reason: null, next_run_at: null })
      expect(row(byOwner)).toMatchObject({ state: 'paused', pause_reason: 'owner' })
    } finally {
      store.close()
    }
  })

  it('imports a key once, refusing a duplicate with its existing name', async () => {
    const { store, keys, confirmed } = await setup()
    try {
      const k = confirmed('u1')
      expect(failure(() => keys.importKey('u1', Buffer.from(k.key)))).toMatchObject({
        status: 409,
        reason: 'key_exists',
        name: 'Key 1',
      })
      // Another user may hold the same key (an imported kit of someone else's backups).
      expect(keys.importKey('u2', Buffer.from(k.key)).state).toBe('imported')
      const imported = keys.importKey('u1', randomBytes(32), 'From the old server')
      expect(imported).toMatchObject({ state: 'imported', name: 'From the old server' })
      expect(keys.active('u1')?.id).toBe(k.id)
      keys.activate('u1', imported.id)
      expect(keys.get('u1', k.id)?.state).toBe('retired')
      expect(keys.active('u1')?.id).toBe(imported.id)
    } finally {
      store.close()
    }
  })

  it('deletes only a key no schedule or backup uses', async () => {
    const { store, keys, schedule, confirmed } = await setup()
    try {
      const used = confirmed('u1')
      schedule('u1', used.id)
      expect(keys.uses(used.id)).toEqual({ schedules: 1, backups: 0 })
      expect(failure(() => keys.remove('u1', used.id))).toMatchObject({ status: 409, reason: 'key_in_use' })
      const byBackup = keys.importKey('u1', randomBytes(32))
      store.db
        .prepare(
          "INSERT INTO backups (id, owner, kind, name, size, complete, meta, created_at, expires_at) VALUES (?, 'u1', 'backup', 'b', 1, 1, ?, 1, 2)",
        )
        .run(randomUUID(), JSON.stringify({ format: 'mmbak', keyId: byBackup.id }))
      expect(keys.uses(byBackup.id)).toEqual({ schedules: 0, backups: 1 })
      expect(failure(() => keys.remove('u1', byBackup.id))).toMatchObject({ reason: 'key_in_use' })
      const free = keys.importKey('u1', randomBytes(32))
      keys.remove('u1', free.id)
      expect(keys.get('u1', free.id)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  // Final review minor 9: between a run opening the key and its file recording the key id, a rotation
  // then a delete left a backup no key here opens.
  it('deletes no key of an owner while one of their scheduled runs is in progress', async () => {
    const { store, keys, schedule, confirmed } = await setup()
    try {
      const old = confirmed('u1')
      const s = schedule('u1', old.id)
      const run = randomUUID()
      store.db
        .prepare(
          "INSERT INTO backup_schedule_runs (id, schedule_id, due_at, kind, started_at) VALUES (?, ?, 1, 'manual', 2)",
        )
        .run(run, s)
      confirmed('u1') // the rotation: the schedule follows the new key; the old one is used by nothing
      expect(keys.uses(old.id)).toEqual({ schedules: 0, backups: 0 })
      expect(failure(() => keys.remove('u1', old.id))).toMatchObject({ status: 409, reason: 'key_in_use' })
      store.db.prepare("UPDATE backup_schedule_runs SET outcome = 'succeeded' WHERE id = ?").run(run)
      keys.remove('u1', old.id)
      expect(keys.get('u1', old.id)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  // Final review minor 16: "Key {count+1}" repeated a name after a delete.
  it('names a new key with the first number no key of the owner has', async () => {
    const { store, keys } = await setup()
    try {
      const one = keys.importKey('u1', randomBytes(32))
      const two = keys.importKey('u1', randomBytes(32))
      expect([one.name, two.name]).toEqual(['Key 1', 'Key 2'])
      keys.remove('u1', one.id)
      expect(keys.importKey('u1', randomBytes(32)).name).toBe('Key 1')
      expect(keys.importKey('u1', randomBytes(32)).name).toBe('Key 3')
    } finally {
      store.close()
    }
  })

  // Final review minor 17: sealed to its id alone, a key moved to another owner by a database write
  // (no secret.key needed) opened for that owner — "the database alone opens nothing" did not hold.
  it('opens a key only for the owner it was sealed for, even when the row names another', async () => {
    const { store, keys, confirmed } = await setup()
    try {
      const victim = confirmed('victim')
      store.db.prepare("UPDATE backup_keys SET owner = 'attacker' WHERE id = ?").run(victim.id)
      expect(keys.open('attacker', victim.id)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('removes unconfirmed keys after an hour, and bounds keys per user (D4)', async () => {
    const { store, keys, clock } = await setup()
    try {
      const { record, key } = keys.create('u1')
      clock.now += PENDING_TTL_MS + 1
      expect(keys.list('u1')).toEqual([])
      expect(failure(() => keys.confirm('u1', record.id, kitCheckGroup(key)))).toMatchObject({ status: 404 })
      for (let i = 0; i < MAX_KEYS_PER_USER; i++) keys.importKey('u1', randomBytes(32))
      expect(failure(() => keys.create('u1'))).toMatchObject({ status: 409, reason: 'key_limit' })
    } finally {
      store.close()
    }
  })

  it('re-seals backup keys when the server key rotates (spec §3.6)', async () => {
    const { dir, store, confirmed } = await setup()
    const k = confirmed('u1')
    store.close()
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.backupKeys).toBe(1)
    const reopened = await openStore(dir)
    try {
      const box = createSecretBox(Buffer.from(readFileSync(join(dir, 'secret.key'), 'utf8').trim(), 'base64'))
      expect(new BackupKeyRepo(reopened.db, box, Date.now).open('u1', k.id)).toEqual(k.key)
    } finally {
      reopened.close()
    }
  })
})
