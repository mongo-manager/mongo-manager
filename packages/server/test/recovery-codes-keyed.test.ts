import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/store/db'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey, verifyKeyCheck } from '../src/crypto/rotate'
import { appKey } from '../src/crypto/app-keys'
import { RecoveryCodeRepo } from '../src/auth/mfa'
import { UserRepo } from '../src/auth/users'

/**
 * Security audit 2026-10-16 (minor): recovery codes were kept as plain SHA-256 of a 50-bit code,
 * unsalted — a copy of the database alone (a backup, a stolen file) let every code be found by
 * trying them all. They are now an HMAC under a key the database does not hold in the clear (a
 * random key sealed with the secret key, so a key rotation keeps them working), and the rows of
 * before are re-keyed at start-up without anyone needing to use them first.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const now = () => Date.UTC(2026, 9, 16)
const sha = (code: string) => createHash('sha256').update(code.replace('-', '')).digest('base64url')

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-recovery-'))
  dirs.push(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir)
  verifyKeyCheck(store.db, box)
  const user = new UserRepo(store.db, now).create({ username: 'ada', passwordHash: 'x', role: 'admin' })
  const repo = () => new RecoveryCodeRepo(store.db, now, appKey(store.db, box, 'recovery-codes'))
  const stored = () =>
    (store.db.prepare('SELECT code_hash FROM recovery_codes').all() as Array<{ code_hash: string }>).map(
      (r) => r.code_hash,
    )
  return { dir, box, store, user, repo, stored }
}

describe('recovery codes, keyed', () => {
  it('are kept as a keyed hash a copy of the database alone cannot test a guess against', async () => {
    const s = await seeded()
    const codes = s.repo().replace(s.user.id)
    const stored = s.stored()
    expect(stored).toHaveLength(10)
    for (const code of codes) expect(stored).not.toContain(sha(code))
    // Another installation's key (another key of the same shape) recognises none of them.
    const elsewhere = new RecoveryCodeRepo(s.store.db, now, randomBytes(32))
    expect(elsewhere.consume(s.user.id, codes[0]!)).toBe(false)
    expect(s.repo().consume(s.user.id, codes[0]!)).toBe(true)
    expect(s.repo().consume(s.user.id, codes[0]!)).toBe(false)
    s.store.close()
  })

  it('re-keys the unsalted hashes of before at start-up; each old code still works once', async () => {
    const s = await seeded()
    const old = ['abcde-fghij', 'klmno-pqrst']
    const insert = s.store.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')
    for (const code of old) insert.run(s.user.id, sha(code))
    const repo = s.repo()
    // No unsalted hash is left behind.
    for (const code of old) expect(s.stored()).not.toContain(sha(code))
    expect(repo.remaining(s.user.id)).toBe(2)
    expect(repo.consume(s.user.id, 'ABCDE FGHIJ')).toBe(true)
    expect(repo.consume(s.user.id, 'abcde-fghij')).toBe(false)
    // A second start changes nothing more.
    const again = s.stored()
    s.repo()
    expect(s.stored()).toEqual(again)
    expect(s.repo().consume(s.user.id, 'klmno-pqrst')).toBe(true)
    s.store.close()
  })

  // Review of the audit fixes (minor 10): nor in the write-ahead log.
  it('leaves no unsalted hash in the database files after re-keying', async () => {
    const s = await seeded()
    const old = 'abcde-fghij'
    s.store.db
      .prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')
      .run(s.user.id, sha(old))
    s.repo()
    const files = [join(s.dir, 'mongo-manager.db'), join(s.dir, 'mongo-manager.db-wal')].filter((f) =>
      existsSync(f),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(f).includes(Buffer.from(sha(old))), f).toBe(false)
    s.store.close()
  })

  it('keep working after a key rotation', async () => {
    const s = await seeded()
    const codes = s.repo().replace(s.user.id)
    s.store.close()
    await rotateSecretKey({ dataDir: s.dir })
    const box = createSecretBox(loadOrCreateKey({ dataDir: s.dir }))
    const store = await openStore(s.dir)
    const repo = new RecoveryCodeRepo(store.db, now, appKey(store.db, box, 'recovery-codes'))
    expect(repo.consume(s.user.id, codes[3]!)).toBe(true)
    store.close()
  })
})
