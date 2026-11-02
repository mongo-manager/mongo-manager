import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/store/db'
import { UserRepo } from '../src/auth/users'
import {
  ChallengeStore,
  MfaTickets,
  RecoveryCodeRepo,
  TICKET_MAX_ATTEMPTS,
  TICKET_TTL_MS,
} from '../src/auth/mfa'
import { PasskeyRepo } from '../src/auth/passkeys'

let dir: string
let store: Store
const clock = { now: 1_000_000 }
const now = () => clock.now
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-mfa-'))
  store = await openStore(dir)
  clock.now = 1_000_000
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MfaTickets', () => {
  it('issues opaque tickets that expire and die after too many failures', () => {
    const tickets = new MfaTickets(now)
    const id = tickets.issue('u1', 'hash-1')
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(tickets.peek(id)?.userId).toBe('u1')
    for (let i = 0; i < TICKET_MAX_ATTEMPTS - 1; i++) tickets.fail(id)
    expect(tickets.peek(id)).toBeDefined()
    tickets.fail(id)
    expect(tickets.peek(id)).toBeUndefined()

    const other = tickets.issue('u1', 'hash-1')
    clock.now += TICKET_TTL_MS
    expect(tickets.peek(other)).toBeUndefined()
  })

  it('stores a single-use challenge per ticket', () => {
    const tickets = new MfaTickets(now)
    const id = tickets.issue('u1', 'hash-1')
    tickets.setChallenge(id, 'abc')
    expect(tickets.takeChallenge(id)).toBe('abc')
    expect(tickets.takeChallenge(id)).toBeUndefined()
    tickets.consume(id)
    expect(tickets.peek(id)).toBeUndefined()
  })
})

describe('ChallengeStore', () => {
  it('returns a challenge once and forgets it after 5 minutes', () => {
    const challenges = new ChallengeStore(now)
    challenges.set('k', 'c1')
    expect(challenges.take('k')).toBe('c1')
    expect(challenges.take('k')).toBeUndefined()
    challenges.set('k', 'c2')
    clock.now += 5 * 60_000
    expect(challenges.take('k')).toBeUndefined()
  })
})

describe('RecoveryCodeRepo', () => {
  it('stores hashes only, consumes each code once and replaces the whole set', () => {
    const user = new UserRepo(store.db, now).create({ username: 'alice', passwordHash: 'h', role: 'admin' })
    const repo = new RecoveryCodeRepo(store.db, now, randomBytes(32))
    const codes = repo.replace(user.id)
    expect(codes).toHaveLength(10)
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/)
    expect(new Set(codes).size).toBe(10)
    const stored = store.db.prepare('SELECT code_hash FROM recovery_codes').all() as { code_hash: string }[]
    expect(stored.some((r) => codes.includes(r.code_hash))).toBe(false)

    expect(repo.consume(user.id, codes[0]!.toUpperCase().replace('-', ' '))).toBe(true)
    expect(repo.consume(user.id, codes[0]!)).toBe(false)
    expect(repo.consume(user.id, 'aaaaa-aaaaa')).toBe(false)
    expect(repo.remaining(user.id)).toBe(9)

    const fresh = repo.replace(user.id)
    expect(repo.consume(user.id, codes[1]!)).toBe(false)
    expect(repo.consume(user.id, fresh[0]!)).toBe(true)
    repo.clear(user.id)
    expect(repo.remaining(user.id)).toBe(0)
  })
})

describe('PasskeyRepo', () => {
  it('adds, lists, renames, updates usage and deletes only the owner’s passkeys', () => {
    const users = new UserRepo(store.db, now)
    const alice = users.create({ username: 'alice', passwordHash: 'h', role: 'admin' })
    const bob = users.create({ username: 'bob', passwordHash: 'h', role: 'viewer' })
    const repo = new PasskeyRepo(store.db, now)
    const key = new Uint8Array([1, 2, 3])
    const p = repo.add({
      id: 'cred-1',
      userId: alice.id,
      name: 'Laptop',
      publicKey: key,
      counter: 0,
      transports: ['internal'],
    })
    expect(p).toMatchObject({
      id: 'cred-1',
      name: 'Laptop',
      counter: 0,
      transports: ['internal'],
      lastUsedAt: null,
    })
    expect([...repo.find('cred-1')!.publicKey]).toEqual([1, 2, 3])
    expect(repo.countForUser(alice.id)).toBe(1)
    expect(repo.rename('cred-1', bob.id, 'stolen')).toBe(false)
    expect(repo.rename('cred-1', alice.id, 'Work laptop')).toBe(true)
    clock.now += 5
    repo.updateUsage('cred-1', 7)
    expect(repo.find('cred-1')).toMatchObject({ name: 'Work laptop', counter: 7, lastUsedAt: clock.now })
    expect(repo.delete('cred-1', bob.id)).toBe(false)
    expect(repo.delete('cred-1', alice.id)).toBe(true)
    repo.add({ id: 'cred-2', userId: alice.id, name: 'Key', publicKey: key, counter: 0, transports: [] })
    repo.deleteAllForUser(alice.id)
    expect(repo.listForUser(alice.id)).toEqual([])
  })
})
