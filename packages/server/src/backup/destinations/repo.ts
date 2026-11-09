// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  permissionsFor,
  type BackupFormat,
  type DestinationPolicy,
  type DestinationStatus,
  type DestinationType,
  type GrantLevel,
} from '@mongo-manager/shared'
import type { SecretBox } from '../../crypto/secret-box'
import type { Principal } from '../../http/context'
import { Errors } from '../../errors'
import { transaction } from '../../store/db'
import type { BackupMeta } from '../store'
import type { ResumeState } from './types'

export const destinationContext = (id: string) => `backup-destination:${id}`
export const copyContext = (id: string) => `backup-copy:${id}`

/**
 * Phase 3d-3b final review: a CA certificate decides which servers are trusted, so one added or
 * changed could send the stored credentials (a WebDAV password in Basic auth) to another server.
 * It is part of the identity, as a digest.
 */
const caOf = (c: Record<string, unknown>) =>
  typeof c.caPem === 'string' && c.caPem ? createHash('sha256').update(c.caPem).digest('hex') : ''

/** Plan ruling 9: what the stored secrets are bound to; a change needs them all again. */
export function identityOf(type: DestinationType, c: Record<string, unknown>): string {
  switch (type) {
    case 'folder':
      return `folder|${String(c.path)}`
    case 's3':
      return `s3|${String(c.endpoint)}|${String(c.bucket)}|${caOf(c)}`
    case 'webdav':
      return `webdav|${String(c.url)}|${String(c.username)}|${caOf(c)}`
    case 'gdrive':
      return `gdrive|${String(c.auth)}|${String(c.clientId ?? '')}|${String(c.sharedDriveId ?? '')}`
    // W4.5: a service account's key is bound to its bucket.
    case 'gcs':
      return `gcs|${String(c.bucket)}`
    // W4.5: a key or a SAS token is bound to its account, container, way of signing and endpoint.
    case 'azure':
      return `azure|${String(c.endpoint ?? '')}|${String(c.account)}|${String(c.container)}|${String(c.auth)}|${caOf(c)}`
    // W4.5: a new host key may be another server: the password or key is asked for again.
    case 'sftp':
      return `sftp|${String(c.host)}|${String(c.port)}|${String(c.username)}|${String(c.auth)}|${String(c.hostFingerprint ?? '')}`
  }
}

export function requiredSecrets(type: DestinationType, c: Record<string, unknown>): string[] {
  if (type === 's3') return ['accessKeyId', 'secretAccessKey']
  if (type === 'webdav') return ['password']
  if (type === 'gcs') return ['serviceAccountKey']
  if (type === 'azure') return c.auth === 'sas' ? ['sasToken'] : ['accountKey']
  if (type === 'sftp') return c.auth === 'password' ? ['password'] : ['privateKey']
  if (type === 'gdrive') return c.auth === 'oauth' ? ['clientSecret', 'refreshToken'] : ['serviceAccountKey']
  return []
}

/**
 * W4.5: an Azure or SFTP destination keeps only the credentials its way of signing uses — an account key
 * given along with a SAS token (or the reverse) is not stored where nothing needs it.
 */
function onlyUsed(
  type: DestinationType,
  c: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, string> {
  if (type !== 'azure' && type !== 'sftp') return secrets
  const used = [
    ...requiredSecrets(type, c),
    ...(type === 'sftp' && c.auth === 'privateKey' ? ['passphrase'] : []),
  ]
  return Object.fromEntries(Object.entries(secrets).filter(([k]) => used.includes(k)))
}

export interface DestinationRecord {
  id: string
  name: string
  type: DestinationType
  config: Record<string, unknown>
  policy: DestinationPolicy
  status: DestinationStatus & { folderId?: string }
  createdBy: string | null
  createdAt: number
  updatedAt: number
  /** The names of the stored secret fields (their values leave this class only through secrets()). */
  secretFields: string[]
}

interface Row {
  id: string
  name: string
  type: DestinationType
  config: string
  secrets: string | null
  policy: string
  status: string
  created_by: string | null
  created_at: number
  updated_at: number
}

const secretsRequired = () =>
  Errors.validation('Enter the credentials again: they belong to the previous address', {
    reason: 'secrets_required',
  })

/** Phase 3d-3b spec §4.1, §4.4: destinations with sealed, write-only secrets, and their grants. */
export class DestinationRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private open(row: Row): Record<string, string> {
    return row.secrets
      ? (JSON.parse(this.box.open(row.secrets, destinationContext(row.id))) as Record<string, string>)
      : {}
  }

  /** The stored secrets, or null when the sealed value cannot be opened (corrupt, wrong key). */
  private tryOpen(row: Row): Record<string, string> | null {
    try {
      return this.open(row)
    } catch {
      return null
    }
  }

  private toRecord(row: Row): DestinationRecord {
    // Phase 3d-3b final review: the secrets are opened only when their field names are asked for
    // (an administrator's view), not on every get and list; a corrupt sealed value shows as none
    // stored instead of turning every listing into an error.
    let fields: string[] | null = null
    const names = () => Object.keys(this.tryOpen(row) ?? {}).sort()
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      config: JSON.parse(row.config) as Record<string, unknown>,
      policy: JSON.parse(row.policy) as DestinationPolicy,
      status: JSON.parse(row.status) as DestinationRecord['status'],
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      get secretFields() {
        fields ??= names()
        return fields
      },
    }
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as Row | undefined
  }

  list(): DestinationRecord[] {
    return (this.db.prepare('SELECT * FROM backup_destinations ORDER BY name').all() as unknown as Row[]).map(
      (r) => this.toRecord(r),
    )
  }

  get(id: string): DestinationRecord | undefined {
    const r = this.row(id)
    return r && this.toRecord(r)
  }

  secrets(id: string): Record<string, string> {
    const r = this.row(id)
    if (!r) throw Errors.notFound('Destination not found')
    return this.open(r)
  }

  private sealed(id: string, secrets: Record<string, string>): string | null {
    return Object.keys(secrets).length ? this.box.seal(JSON.stringify(secrets), destinationContext(id)) : null
  }

  private unique<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (/UNIQUE/.test(String((e as Error).message)))
        throw Errors.conflict('A destination with this name already exists', { reason: 'name_taken' })
      throw e
    }
  }

  create(input: {
    name: string
    type: DestinationType
    config: Record<string, unknown>
    secrets: Record<string, string>
    policy: DestinationPolicy
    createdBy: string | null
  }): DestinationRecord {
    if (requiredSecrets(input.type, input.config).some((k) => !input.secrets[k])) throw secretsRequired()
    const id = randomUUID()
    const t = this.now()
    const status: DestinationStatus = { state: 'unknown', checkedAt: null }
    this.unique(() =>
      this.db
        .prepare(
          `INSERT INTO backup_destinations (id, name, type, config, secrets, policy, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.type,
          JSON.stringify(input.config),
          this.sealed(id, onlyUsed(input.type, input.config, input.secrets)),
          JSON.stringify(input.policy),
          JSON.stringify(status),
          input.createdBy,
          t,
          t,
        ),
    )
    return this.get(id)!
  }

  update(
    id: string,
    patch: {
      name?: string
      config?: Record<string, unknown>
      secrets?: Record<string, string>
      policy?: DestinationPolicy
    },
  ): { record: DestinationRecord; identityChanged: boolean } {
    const row = this.row(id)
    if (!row) throw Errors.notFound('Destination not found')
    const before = this.toRecord(row)
    const config = patch.config ?? before.config
    const identityChanged = identityOf(before.type, before.config) !== identityOf(before.type, config)
    const required = requiredSecrets(before.type, config)
    let secrets: Record<string, string>
    if (identityChanged) {
      // Plan ruling 9: the stored secrets stay with the old address; every one must come again.
      if (required.some((k) => !patch.secrets?.[k])) throw secretsRequired()
      secrets = { ...patch.secrets }
    } else {
      // A sealed value that cannot be opened is repaired by entering every secret again.
      secrets = { ...this.tryOpen(row), ...patch.secrets }
      if (required.some((k) => !secrets[k])) throw secretsRequired()
    }
    const status = identityChanged ? { state: 'unknown', checkedAt: null } : before.status
    this.unique(() =>
      this.db
        .prepare(
          'UPDATE backup_destinations SET name = ?, config = ?, secrets = ?, policy = ?, status = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          patch.name ?? before.name,
          JSON.stringify(config),
          this.sealed(id, onlyUsed(before.type, config, secrets)),
          JSON.stringify(patch.policy ?? before.policy),
          JSON.stringify(status),
          this.now(),
          id,
        ),
    )
    return { record: this.get(id)!, identityChanged }
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id).changes > 0
  }

  setStatus(id: string, status: DestinationRecord['status']): void {
    this.db.prepare('UPDATE backup_destinations SET status = ? WHERE id = ?').run(JSON.stringify(status), id)
  }

  grants(id: string): Array<{ userId: string; username: string; level: GrantLevel }> {
    return (
      this.db
        .prepare(
          `SELECT g.user_id AS userId, u.username AS username, g.level AS level FROM backup_destination_grants g
           JOIN users u ON u.id = g.user_id WHERE g.destination_id = ? ORDER BY u.username`,
        )
        .all(id) as Array<{ userId: string; username: string; level: GrantLevel }>
    ).map((g) => ({ userId: g.userId, username: g.username, level: g.level }))
  }

  /** Replaces the grants; `lost` names users who lost access or went from browse to send (D10). */
  setGrants(id: string, grants: Array<{ userId: string; level: GrantLevel }>): { lost: string[] } {
    const before = new Map(this.grants(id).map((g) => [g.userId, g.level]))
    const after = new Map(grants.map((g) => [g.userId, g.level]))
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM backup_destination_grants WHERE destination_id = ?').run(id)
      const insert = this.db.prepare(
        'INSERT INTO backup_destination_grants (destination_id, user_id, level) VALUES (?, ?, ?)',
      )
      for (const g of grants) insert.run(id, g.userId, g.level)
    })
    const lost = [...before]
      .filter(([u, l]) => !after.has(u) || (l === 'browse' && after.get(u) === 'send'))
      .map(([u]) => u)
    return { lost }
  }

  levelOf(id: string, principal: Principal): GrantLevel | 'admin' | null {
    if (!this.row(id)) return null
    if (permissionsFor(principal.role).has('settings:manage')) return 'admin'
    if (principal.kind !== 'user') return null
    const g = this.db
      .prepare('SELECT level FROM backup_destination_grants WHERE destination_id = ? AND user_id = ?')
      .get(id, principal.userId) as { level: GrantLevel } | undefined
    return g?.level ?? null
  }

  usage(id: string): { copies: number; bytes: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM backup_remote_copies WHERE destination_id = ? AND state = 'complete'",
      )
      .get(id) as { n: number; b: number }
    return { copies: r.n, bytes: r.b }
  }
}

export interface CopyRecord {
  id: string
  destinationId: string
  backupId: string | null
  remoteKey: string
  remoteRef: string | null
  owner: string
  connectionId: string | null
  meta: BackupMeta | null
  format: BackupFormat
  size: number
  sha256: string
  md5: string | null
  state: 'sending' | 'complete' | 'failed'
  sent: number
  error: string | null
  createdAt: number
  completedAt: number | null
  /** Final review B14: the send asked to delete the local copy once every destination verified. */
  deleteLocal?: boolean
  /** Final review B25: when the copy was last attempted (the stale sweep ages it from here). */
  attemptAt?: number
  /** Final review B32: why the copy failed, as a reason code; null when it did not. */
  reason?: string | null
  /** Phase 3d-3c: the schedule that sent it (retention's candidates), null for a manual send. */
  scheduleId: string | null
  /** Phase 3d-3c (plan ruling 14): the backup it was sent from, kept when that backup is deleted. */
  origin: string | null
}

/**
 * Final review B14, B25: the send's own facts live beside the backup's meta in the meta column
 * (migration 15 has no column for them); they never reach a view of the meta.
 */
interface SendFacts {
  deleteLocal: boolean
  attemptAt: number
  reason: string | null
  origin: string | null
}

interface CopyRow {
  id: string
  destination_id: string
  backup_id: string | null
  remote_key: string
  remote_ref: string | null
  owner: string
  connection_id: string | null
  meta: string | null
  format: BackupFormat
  size: number
  sha256: string
  md5: string | null
  state: CopyRecord['state']
  sent: number
  resume: string | null
  error: string | null
  created_at: number
  completed_at: number | null
  schedule_id: string | null
}

const splitMeta = (raw: string | null): { meta: BackupMeta | null; send: Partial<SendFacts> } => {
  if (!raw) return { meta: null, send: {} }
  const { send, ...rest } = JSON.parse(raw) as BackupMeta & { send?: Partial<SendFacts> }
  return { meta: 'scope' in rest ? rest : null, send: send ?? {} }
}

const toCopy = (r: CopyRow): CopyRecord => {
  const { meta, send } = splitMeta(r.meta)
  return {
    ...toCopyFields(r, meta),
    deleteLocal: send.deleteLocal === true,
    attemptAt: send.attemptAt ?? r.created_at,
    reason: r.state === 'failed' ? (send.reason ?? null) : null,
    origin: send.origin ?? r.backup_id,
  }
}

const toCopyFields = (r: CopyRow, meta: BackupMeta | null): CopyRecord => ({
  id: r.id,
  destinationId: r.destination_id,
  backupId: r.backup_id,
  remoteKey: r.remote_key,
  remoteRef: r.remote_ref,
  owner: r.owner,
  connectionId: r.connection_id,
  meta,
  format: r.format,
  size: r.size,
  sha256: r.sha256,
  md5: r.md5,
  state: r.state,
  sent: r.sent,
  error: r.error,
  createdAt: r.created_at,
  completedAt: r.completed_at,
  scheduleId: r.schedule_id,
  origin: r.backup_id,
})

/** Phase 3d-3b spec §4.1: the copies sent to destinations, with sealed resume states. */
export class CopyRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private one(sql: string, ...args: Array<string | number | null>): CopyRecord | undefined {
    const r = this.db.prepare(sql).get(...args) as CopyRow | undefined
    return r && toCopy(r)
  }
  private many(sql: string, ...args: Array<string | number | null>): CopyRecord[] {
    return (this.db.prepare(sql).all(...args) as unknown as CopyRow[]).map(toCopy)
  }

  create(
    input: Omit<
      CopyRecord,
      | 'id'
      | 'state'
      | 'sent'
      | 'error'
      | 'createdAt'
      | 'completedAt'
      | 'remoteRef'
      | 'attemptAt'
      | 'reason'
      | 'scheduleId'
      | 'origin'
    > & { scheduleId?: string | null },
  ): CopyRecord {
    const id = randomUUID()
    const send: SendFacts = {
      deleteLocal: input.deleteLocal === true,
      attemptAt: this.now(),
      reason: null,
      origin: input.backupId,
    }
    this.db
      .prepare(
        `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
          size, sha256, md5, state, created_at, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      )
      .run(
        id,
        input.destinationId,
        input.backupId,
        input.remoteKey,
        input.owner,
        input.connectionId,
        JSON.stringify({ ...input.meta, send }),
        input.format,
        input.size,
        input.sha256,
        input.md5,
        this.now(),
        input.scheduleId ?? null,
      )
    return this.get(id)!
  }

  get(id: string) {
    return this.one('SELECT * FROM backup_remote_copies WHERE id = ?', id)
  }
  forBackupOn(backupId: string, destinationId: string) {
    return this.one(
      'SELECT * FROM backup_remote_copies WHERE backup_id = ? AND destination_id = ?',
      backupId,
      destinationId,
    )
  }
  byBackup(backupId: string) {
    return this.many('SELECT * FROM backup_remote_copies WHERE backup_id = ? ORDER BY created_at', backupId)
  }
  byKey(destinationId: string, key: string) {
    return this.one(
      'SELECT * FROM backup_remote_copies WHERE destination_id = ? AND remote_key = ?',
      destinationId,
      key,
    )
  }
  byOwner(owner: string, destinationId: string) {
    return this.many(
      'SELECT * FROM backup_remote_copies WHERE owner = ? AND destination_id = ? ORDER BY created_at DESC',
      owner,
      destinationId,
    )
  }
  byDestination(destinationId: string) {
    return this.many('SELECT * FROM backup_remote_copies WHERE destination_id = ?', destinationId)
  }
  /** Phase 3d-3c: the copies one scheduled run made (plan ruling 14). */
  forRun(scheduleId: string, origin: string) {
    return this.many(
      "SELECT * FROM backup_remote_copies WHERE schedule_id = ? AND json_extract(meta, '$.send.origin') = ? ORDER BY created_at",
      scheduleId,
      origin,
    )
  }
  /** Spec §1.4: a schedule's complete copies at one destination, newest first (retention's candidates). */
  forSchedule(scheduleId: string, destinationId: string) {
    return this.many(
      "SELECT * FROM backup_remote_copies WHERE schedule_id = ? AND destination_id = ? AND state = 'complete' ORDER BY created_at DESC",
      scheduleId,
      destinationId,
    )
  }

  resume(id: string): ResumeState | null {
    const r = this.db.prepare('SELECT resume FROM backup_remote_copies WHERE id = ?').get(id) as
      { resume: string | null } | undefined
    return r?.resume ? (JSON.parse(this.box.open(r.resume, copyContext(id))) as ResumeState) : null
  }
  setResume(id: string, state: ResumeState | null): void {
    this.db
      .prepare('UPDATE backup_remote_copies SET resume = ? WHERE id = ?')
      .run(state ? this.box.seal(JSON.stringify(state), copyContext(id)) : null, id)
  }
  setSent(id: string, sent: number): void {
    this.db.prepare('UPDATE backup_remote_copies SET sent = ? WHERE id = ?').run(sent, id)
  }
  setMd5(id: string, md5: string): void {
    this.db.prepare('UPDATE backup_remote_copies SET md5 = ? WHERE id = ?').run(md5, id)
  }
  private setSend(id: string, change: Partial<SendFacts>): void {
    const r = this.db.prepare('SELECT meta FROM backup_remote_copies WHERE id = ?').get(id) as
      { meta: string | null } | undefined
    if (!r) return
    const { meta, send } = splitMeta(r.meta)
    this.db
      .prepare('UPDATE backup_remote_copies SET meta = ? WHERE id = ?')
      .run(JSON.stringify({ ...meta, send: { ...send, ...change } }), id)
  }
  /** A new attempt: sending again, aged from now (B25), with this send's deleteLocal (B14). */
  restart(id: string, deleteLocal?: boolean): void {
    this.db.prepare("UPDATE backup_remote_copies SET state = 'sending', error = NULL WHERE id = ?").run(id)
    this.setSend(id, {
      attemptAt: this.now(),
      reason: null,
      ...(deleteLocal !== undefined ? { deleteLocal } : {}),
    })
  }
  complete(id: string, ref: string | null): void {
    this.db
      .prepare(
        "UPDATE backup_remote_copies SET state = 'complete', sent = size, resume = NULL, error = NULL, remote_ref = ?, completed_at = ? WHERE id = ?",
      )
      .run(ref, this.now(), id)
  }
  fail(id: string, error: string, reason: string | null = null): void {
    this.db
      .prepare("UPDATE backup_remote_copies SET state = 'failed', error = ? WHERE id = ?")
      .run(error.slice(0, 500), id)
    this.setSend(id, { reason })
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM backup_remote_copies WHERE id = ?').run(id)
  }
  detachBackup(backupId: string): void {
    this.db.prepare('UPDATE backup_remote_copies SET backup_id = NULL WHERE backup_id = ?').run(backupId)
  }
  /** Copies that never completed and were last attempted before `before` (the sweeper abandons them). */
  stale(before: number): CopyRecord[] {
    return this.many("SELECT * FROM backup_remote_copies WHERE state != 'complete'").filter(
      (c) => (c.attemptAt ?? c.createdAt) < before,
    )
  }
  /** Final review B1: copies in a state, oldest first. */
  inState(state: CopyRecord['state']): CopyRecord[] {
    return this.many('SELECT * FROM backup_remote_copies WHERE state = ? ORDER BY created_at', state)
  }
  /**
   * Final review B7: a destination that now points elsewhere holds none of these copies; they are
   * forgotten (the files stay where they were, as with a deleted destination).
   */
  forgetDestination(destinationId: string): number {
    return Number(
      this.db.prepare('DELETE FROM backup_remote_copies WHERE destination_id = ?').run(destinationId).changes,
    )
  }
}
