// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { KeyState } from '@mongo-manager/shared'
import type { SecretBox } from '../../crypto/secret-box'
import { Errors } from '../../errors'
import { safeEqual } from '../../http/security'
import { transaction } from '../../store/db'
import { KEY_BYTES, backupKeyFingerprint, kitCheckGroup, normaliseKitChars } from './kit'

/** Spec §3.1: the secret box context of a key's sealed column. */
/** Final review minor 17: sealed to its owner and its id; a row moved to another owner opens nothing. */
export const keyContext = (owner: string, id: string) => `backup-key:${owner}:${id}`
/** Spec §1.1: a key whose kit was never confirmed is removed after an hour. */
export const PENDING_TTL_MS = 3_600_000
/** Plan ruling 25. */
export const MAX_KEYS_PER_USER = 20

export interface BackupKeyRecord {
  id: string
  owner: string
  name: string
  fingerprint: string
  state: KeyState
  createdAt: number
  confirmedAt: number | null
  retiredAt: number | null
}

interface Row {
  id: string
  owner: string
  name: string
  fingerprint: string
  state: KeyState
  sealed_key: string
  created_at: number
  confirmed_at: number | null
  retired_at: number | null
}

const toRecord = (r: Row): BackupKeyRecord => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  fingerprint: r.fingerprint,
  state: r.state,
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
  retiredAt: r.retired_at,
})
const notFound = () => Errors.notFound('Backup key not found')
const wrongState = (message: string) => Errors.conflict(message, { reason: 'key_state' })

/**
 * Phase 3d-3c spec §1.1, §3.1, D1: per-user backup keys, sealed at rest. A key leaves its column only
 * through open() for its owner. Schedules follow the active key (plan ruling 9): the transitions
 * here move them in the same transaction.
 */
export class BackupKeyRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private row(owner: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM backup_keys WHERE id = ? AND owner = ?').get(id, owner) as
      Row | undefined
  }

  /** The owner's keys, newest first; unconfirmed ones past their hour are gone first. */
  list(owner: string): BackupKeyRecord[] {
    this.sweepPending()
    return (
      this.db
        .prepare('SELECT * FROM backup_keys WHERE owner = ? ORDER BY created_at DESC, name')
        .all(owner) as unknown as Row[]
    ).map(toRecord)
  }

  get(owner: string, id: string): BackupKeyRecord | undefined {
    const r = this.row(owner, id)
    return r && toRecord(r)
  }

  active(owner: string): BackupKeyRecord | undefined {
    const r = this.db.prepare("SELECT * FROM backup_keys WHERE owner = ? AND state = 'active'").get(owner) as
      Row | undefined
    return r && toRecord(r)
  }

  /** Final review minor 16: the first "Key N" the owner does not have (a delete never repeats a name). */
  private nextName(owner: string): string {
    const taken = new Set(
      (
        this.db.prepare('SELECT name FROM backup_keys WHERE owner = ?').all(owner) as Array<{ name: string }>
      ).map((r) => r.name),
    )
    let n = 1
    while (taken.has(`Key ${n}`)) n++
    return `Key ${n}`
  }

  private insert(owner: string, key: Buffer, name: string, state: KeyState): BackupKeyRecord {
    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM backup_keys WHERE owner = ?').get(owner) as { n: number }
    ).n
    if (count >= MAX_KEYS_PER_USER)
      throw Errors.conflict('This account holds the most backup keys it may; delete an unused one first', {
        reason: 'key_limit',
      })
    const fingerprint = backupKeyFingerprint(key)
    const dup = this.db
      .prepare('SELECT name FROM backup_keys WHERE owner = ? AND fingerprint = ?')
      .get(owner, fingerprint) as { name: string } | undefined
    if (dup)
      throw Errors.conflict(`This key is already here, as "${dup.name}"`, {
        reason: 'key_exists',
        name: dup.name,
      })
    const id = randomUUID()
    const t = this.now()
    this.db
      .prepare(
        `INSERT INTO backup_keys (id, owner, name, fingerprint, state, sealed_key, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        owner,
        name,
        fingerprint,
        state,
        this.box.seal(key.toString('base64'), keyContext(owner, id)),
        t,
        state === 'pending' ? null : t,
      )
    return this.get(owner, id)!
  }

  /** Spec §1.1: a new key, pending until its kit is confirmed. The caller shows the kit once. */
  create(owner: string, name?: string): { record: BackupKeyRecord; key: Buffer } {
    this.sweepPending()
    const key = randomBytes(KEY_BYTES)
    return { record: this.insert(owner, key, name ?? this.nextName(owner), 'pending'), key }
  }

  /** Spec §1.1: a key from a recovery kit: it opens backups, and is used for new ones only once activated. */
  importKey(owner: string, key: Buffer, name?: string): BackupKeyRecord {
    return this.insert(owner, key, name ?? this.nextName(owner), 'imported')
  }

  private unseal(r: Row): Buffer | null {
    try {
      const key = Buffer.from(this.box.open(r.sealed_key, keyContext(r.owner, r.id)), 'base64')
      return key.length === KEY_BYTES ? key : null
    } catch {
      return null
    }
  }

  /** The owner's key, for opening or writing a backup; never a pending one, never another user's (D3). */
  open(owner: string, id: string): Buffer | null {
    const r = this.row(owner, id)
    return r && r.state !== 'pending' ? this.unseal(r) : null
  }

  /** Makes `id` the active key: the previous one retires, the owner's schedules follow (ruling 9). */
  private makeActive(owner: string, id: string, extra: { confirmedAt?: number }): string[] {
    const t = this.now()
    this.db
      .prepare(
        "UPDATE backup_keys SET state = 'retired', retired_at = ? WHERE owner = ? AND state = 'active'",
      )
      .run(t, owner)
    this.db
      .prepare(
        'UPDATE backup_keys SET state = ?, retired_at = NULL, confirmed_at = COALESCE(?, confirmed_at) WHERE id = ?',
      )
      .run('active', extra.confirmedAt ?? null, id)
    this.db
      .prepare("UPDATE backup_schedules SET key_id = ?, updated_at = ? WHERE owner = ? AND format = 'mmbak'")
      .run(id, t, owner)
    const resumed = (
      this.db
        .prepare(
          "SELECT id FROM backup_schedules WHERE owner = ? AND state = 'paused' AND pause_reason = 'key_inactive' AND paused_by = 'system' ORDER BY created_at",
        )
        .all(owner) as Array<{ id: string }>
    ).map((r) => r.id)
    // Active again; the scheduler's next tick computes their next run.
    this.db
      .prepare(
        "UPDATE backup_schedules SET state = 'active', pause_reason = NULL, paused_by = NULL, next_run_at = NULL WHERE owner = ? AND state = 'paused' AND pause_reason = 'key_inactive' AND paused_by = 'system'",
      )
      .run(owner)
    return resumed
  }

  /** Spec §1.1: the kit's last group, typed back (compared in constant time, D1). */
  confirm(owner: string, id: string, check: string): { record: BackupKeyRecord; resumed: string[] } {
    this.sweepPending()
    const r = this.row(owner, id)
    if (!r || r.state !== 'pending') throw notFound()
    const key = this.unseal(r)
    if (!key) throw notFound()
    const expected = kitCheckGroup(key)
    key.fill(0)
    if (!safeEqual(normaliseKitChars(check), expected))
      throw Errors.validation('That is not the last group of this key’s kit', { reason: 'key_check' })
    const resumed = transaction(this.db, () => this.makeActive(owner, id, { confirmedAt: this.now() }))
    return { record: this.get(owner, id)!, resumed }
  }

  /** Spec §1.1: a retired or imported key becomes the active one. */
  activate(owner: string, id: string): { record: BackupKeyRecord; resumed: string[] } {
    const r = this.row(owner, id)
    if (!r) throw notFound()
    if (r.state === 'pending') throw wrongState('Confirm this key’s kit first')
    if (r.state === 'active') return { record: toRecord(r), resumed: [] }
    const resumed = transaction(this.db, () => this.makeActive(owner, id, {}))
    return { record: this.get(owner, id)!, resumed }
  }

  /** Spec §1.1: a key that opens older backups and is used by nothing new; its schedules pause. */
  retire(owner: string, id: string): { record: BackupKeyRecord; paused: string[] } {
    const r = this.row(owner, id)
    if (!r) throw notFound()
    if (r.state !== 'active' && r.state !== 'imported')
      throw wrongState('Only an active or imported key retires')
    const paused = transaction(this.db, () => {
      this.db
        .prepare("UPDATE backup_keys SET state = 'retired', retired_at = ? WHERE id = ?")
        .run(this.now(), id)
      const ids = (
        this.db
          .prepare(
            "SELECT id FROM backup_schedules WHERE owner = ? AND key_id = ? AND state = 'active' ORDER BY created_at",
          )
          .all(owner, id) as Array<{ id: string }>
      ).map((x) => x.id)
      this.db
        .prepare(
          "UPDATE backup_schedules SET state = 'paused', pause_reason = 'key_inactive', paused_by = 'system', next_run_at = NULL, updated_at = ? WHERE owner = ? AND key_id = ? AND state = 'active'",
        )
        .run(this.now(), owner, id)
      return ids
    })
    return { record: this.get(owner, id)!, paused }
  }

  /** What still needs a key: schedules, and backups or copies made with it (spec §3.4 DELETE). */
  uses(id: string): { schedules: number; backups: number } {
    const n = (sql: string) => (this.db.prepare(sql).get(id) as { n: number }).n
    return {
      schedules: n('SELECT COUNT(*) AS n FROM backup_schedules WHERE key_id = ?'),
      backups:
        n("SELECT COUNT(*) AS n FROM backups WHERE kind = 'backup' AND json_extract(meta, '$.keyId') = ?") +
        n("SELECT COUNT(*) AS n FROM backup_remote_copies WHERE json_extract(meta, '$.keyId') = ?"),
    }
  }

  remove(owner: string, id: string): BackupKeyRecord {
    const r = this.row(owner, id)
    if (!r) throw notFound()
    const uses = this.uses(id)
    if (uses.schedules || uses.backups)
      throw Errors.conflict('A schedule or a backup still needs this key', { reason: 'key_in_use', ...uses })
    // Final review minor 9: a run in progress may hold this key before its file records it.
    const running = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM backup_schedule_runs r JOIN backup_schedules s ON s.id = r.schedule_id
            WHERE s.owner = ? AND r.started_at IS NOT NULL AND r.outcome IS NULL`,
        )
        .get(owner) as { n: number }
    ).n
    if (running)
      throw Errors.conflict('A scheduled backup is running; delete this key once it ends', {
        reason: 'key_in_use',
        ...uses,
      })
    this.db.prepare('DELETE FROM backup_keys WHERE id = ?').run(id)
    return toRecord(r)
  }

  sweepPending(): number {
    return Number(
      this.db
        .prepare("DELETE FROM backup_keys WHERE state = 'pending' AND created_at < ?")
        .run(this.now() - PENDING_TTL_MS).changes,
    )
  }

  /** A deleted user's keys (their schedules are deleted first: a schedule's key_id restricts). */
  deleteAllFor(owner: string): void {
    this.db.prepare('DELETE FROM backup_keys WHERE owner = ?').run(owner)
  }
}
