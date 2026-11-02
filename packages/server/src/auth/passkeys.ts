import type { DatabaseSync } from 'node:sqlite'

export interface Passkey {
  id: string
  userId: string
  name: string
  publicKey: Uint8Array<ArrayBuffer>
  counter: number
  transports: string[]
  createdAt: number
  lastUsedAt: number | null
}

interface Row {
  id: string
  user_id: string
  name: string
  public_key: Uint8Array
  counter: number
  transports: string
  created_at: number
  last_used_at: number | null
}

const toPasskey = (r: Row): Passkey => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  publicKey: new Uint8Array(r.public_key),
  counter: r.counter,
  transports: JSON.parse(r.transports) as string[],
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
})

export class PasskeyRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  add(input: {
    id: string
    userId: string
    name: string
    publicKey: Uint8Array
    counter: number
    transports: string[]
  }): Passkey {
    this.db
      .prepare(
        'INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.id,
        input.userId,
        input.name,
        input.publicKey,
        input.counter,
        JSON.stringify(input.transports),
        this.now(),
      )
    return this.find(input.id)!
  }

  find(id: string): Passkey | undefined {
    const row = this.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id) as unknown as Row | undefined
    return row && toPasskey(row)
  }

  listForUser(userId: string): Passkey[] {
    const rows = this.db
      .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at')
      .all(userId) as unknown as Row[]
    return rows.map(toPasskey)
  }

  countForUser(userId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId) as { n: number }
    ).n
  }

  updateUsage(id: string, counter: number): void {
    this.db
      .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(counter, this.now(), id)
  }

  rename(id: string, userId: string, name: string): boolean {
    return (
      Number(
        this.db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId)
          .changes,
      ) === 1
    )
  }

  delete(id: string, userId: string): boolean {
    return (
      Number(this.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes) ===
      1
    )
  }

  deleteAllForUser(userId: string): void {
    this.db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId)
  }
}
