// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from '../store/db'

export const TICKET_TTL_MS = 5 * 60_000
export const TICKET_MAX_ATTEMPTS = 5
export const CHALLENGE_TTL_MS = 5 * 60_000
export const RECOVERY_CODE_COUNT = 10

export interface MfaTicket {
  userId: string
  /** The password the first step checked, as a digest: a ticket ends with that password (plan 1b). */
  credential: string
  expiresAt: number
  attempts: number
  challenge?: string
}

/** Short-lived proof that the password step succeeded; the second step must present it. */
export class MfaTickets {
  private readonly tickets = new Map<string, MfaTicket>()

  constructor(private readonly now: () => number) {}

  issue(userId: string, passwordHash: string): string {
    this.sweep()
    const id = randomBytes(32).toString('base64url')
    const credential = credentialOf(passwordHash)
    this.tickets.set(id, { userId, credential, expiresAt: this.now() + TICKET_TTL_MS, attempts: 0 })
    return id
  }

  peek(id: string): MfaTicket | undefined {
    const ticket = this.tickets.get(id)
    if (!ticket) return undefined
    if (ticket.expiresAt <= this.now()) {
      this.tickets.delete(id)
      return undefined
    }
    return ticket
  }

  setChallenge(id: string, challenge: string): void {
    const ticket = this.peek(id)
    if (ticket) ticket.challenge = challenge
  }

  takeChallenge(id: string): string | undefined {
    const ticket = this.peek(id)
    const challenge = ticket?.challenge
    if (ticket) delete ticket.challenge
    return challenge
  }

  fail(id: string): void {
    const ticket = this.tickets.get(id)
    if (!ticket) return
    ticket.attempts += 1
    if (ticket.attempts >= TICKET_MAX_ATTEMPTS) this.tickets.delete(id)
  }

  consume(id: string): void {
    this.tickets.delete(id)
  }

  private sweep(): void {
    const t = this.now()
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= t) this.tickets.delete(id)
  }
}

/**
 * What a ticket keeps of the password it was issued for. Every new password hash has a new salt, so
 * a change (even to the same password) gives a new digest; the hash itself is not kept twice.
 */
export const credentialOf = (passwordHash: string): string =>
  createHash('sha256').update(passwordHash).digest('base64url')

/** Whether a ticket was issued for this password hash (compared in constant time, S3). */
export function ticketMatches(ticket: MfaTicket, passwordHash: string): boolean {
  const issued = Buffer.from(ticket.credential)
  const current = Buffer.from(credentialOf(passwordHash))
  return issued.length === current.length && timingSafeEqual(issued, current)
}

/** Single-use WebAuthn challenges keyed by session (registration). */
export class ChallengeStore {
  private readonly values = new Map<string, { challenge: string; expiresAt: number }>()

  constructor(private readonly now: () => number) {}

  set(key: string, challenge: string): void {
    const t = this.now()
    for (const [k, v] of this.values) if (v.expiresAt <= t) this.values.delete(k)
    this.values.set(key, { challenge, expiresAt: t + CHALLENGE_TTL_MS })
  }

  take(key: string): string | undefined {
    const entry = this.values.get(key)
    this.values.delete(key)
    return entry && entry.expiresAt > this.now() ? entry.challenge : undefined
  }
}

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const normalizeCode = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, '')
/** What was kept before the security audit of 2026-10-16: the unsalted SHA-256 of the code. */
const plainHash = (code: string) => createHash('sha256').update(normalizeCode(code)).digest('base64url')
/**
 * Security audit 2026-10-16: an HMAC of that hash under a key the database does not hold in the
 * clear (crypto/app-keys), so a copy of the database alone cannot test guesses. Keyed over the old
 * hash, the rows of before are re-keyed without their codes.
 */
const KEYED = 'h1:'
const keyed = (key: Buffer, plain: string) =>
  KEYED + createHmac('sha256', key).update(plain).digest('base64url')

function generateCode(): string {
  let raw = ''
  for (let i = 0; i < 10; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
  return `${raw.slice(0, 5)}-${raw.slice(5)}`
}

export class RecoveryCodeRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    /** The recovery-codes key (crypto/app-keys). */
    private readonly key: Buffer,
  ) {
    this.rekeyPlainRows()
  }

  private hashCode(code: string): string {
    return keyed(this.key, plainHash(code))
  }

  /** Rows kept unsalted before the audit of 2026-10-16 are re-keyed in place, once. */
  private rekeyPlainRows(): void {
    const plain = this.db
      .prepare(`SELECT user_id, code_hash FROM recovery_codes WHERE code_hash NOT LIKE '${KEYED}%'`)
      .all() as Array<{ user_id: string; code_hash: string }>
    if (plain.length === 0) return
    // The old hashes must not stay readable in freed pages.
    const before = (this.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete
    this.db.exec('PRAGMA secure_delete = ON')
    try {
      transaction(this.db, () => {
        const update = this.db.prepare(
          'UPDATE recovery_codes SET code_hash = ? WHERE user_id = ? AND code_hash = ?',
        )
        for (const row of plain) update.run(keyed(this.key, row.code_hash), row.user_id, row.code_hash)
      })
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${before ? 'ON' : 'OFF'}`)
    }
    // Review of the audit fixes (minor 10): nor in the write-ahead log's older frames.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  replace(userId: string): string[] {
    const codes = new Set<string>()
    while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateCode())
    this.clear(userId)
    const insert = this.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')
    for (const code of codes) insert.run(userId, this.hashCode(code))
    return [...codes]
  }

  consume(userId: string, code: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      )
      .run(this.now(), userId, this.hashCode(code))
    return Number(result.changes) === 1
  }

  remaining(userId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
        .get(userId) as {
        n: number
      }
    ).n
  }

  clear(userId: string): void {
    this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)
  }
}
