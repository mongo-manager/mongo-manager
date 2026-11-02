import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Role } from '@mongo-manager/shared'
import { Errors } from '../errors'

export interface User {
  id: string
  username: string
  role: Role
  totpEnabled: boolean
  /** Required 2FA (2026-10-28): an administrator requires two-factor authentication of this user. */
  requireTwoFactor: boolean
  disabled: boolean
  createdAt: number
  passwordChangedAt: number
}

export interface UserRecord extends User {
  passwordHash: string
  totpSecretSealed: string | null
  totpLastStep: number | null
}

interface Row {
  id: string
  username: string
  password_hash: string
  role: string
  totp_secret: string | null
  totp_enabled: number
  totp_last_step: number | null
  require_2fa: number
  password_changed_at: number
  created_at: number
  disabled: number
}

function toRecord(r: Row): UserRecord {
  return {
    id: r.id,
    username: r.username,
    role: r.role as Role,
    totpEnabled: r.totp_enabled === 1,
    requireTwoFactor: r.require_2fa === 1,
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    passwordChangedAt: r.password_changed_at,
    passwordHash: r.password_hash,
    totpSecretSealed: r.totp_secret,
    totpLastStep: r.totp_last_step,
  }
}

export function toPublicUser(r: UserRecord): User {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    totpEnabled: r.totpEnabled,
    requireTwoFactor: r.requireTwoFactor,
    disabled: r.disabled,
    createdAt: r.createdAt,
    passwordChangedAt: r.passwordChangedAt,
  }
}

export class UserRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  }

  /** Users who may sign in: sharing needs another one (user review 2026-10-09). */
  countActive(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled = 0').get() as { n: number }).n
  }

  countActiveAdmins(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as {
        n: number
      }
    ).n
  }

  create(input: { username: string; passwordHash: string; role: Role; requireTwoFactor?: boolean }): User {
    const id = randomUUID()
    const t = this.now()
    try {
      this.db
        .prepare(
          'INSERT INTO users (id, username, password_hash, role, require_2fa, password_changed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.username, input.passwordHash, input.role, input.requireTwoFactor ? 1 : 0, t, t)
    } catch (e) {
      if (/UNIQUE constraint failed/.test((e as Error).message))
        throw Errors.conflict('Username already exists', { reason: 'username_taken' })
      throw e
    }
    return toPublicUser(this.findById(id)!)
  }

  findByUsername(username: string): UserRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as
      Row | undefined
    return row && toRecord(row)
  }

  findById(id: string): UserRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as Row | undefined
    return row && toRecord(row)
  }

  list(): User[] {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE')
      .all() as unknown as Row[]
    return rows.map((r) => toPublicUser(toRecord(r)))
  }

  setPassword(id: string, passwordHash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
      .run(passwordHash, this.now(), id)
  }

  setRole(id: string, role: Role): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
  }

  setRequireTwoFactor(id: string, required: boolean): void {
    this.db.prepare('UPDATE users SET require_2fa = ? WHERE id = ?').run(required ? 1 : 0, id)
  }

  setDisabled(id: string, disabled: boolean): void {
    this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id)
  }

  setTotp(id: string, sealedSecret: string | null, enabled: boolean): void {
    this.db
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = ?, totp_last_step = NULL WHERE id = ?')
      .run(sealedSecret, enabled ? 1 : 0, id)
  }

  setTotpLastStep(id: string, step: number): void {
    this.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id)
  }
}
