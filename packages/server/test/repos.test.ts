import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuditAction } from '@mongo-manager/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/store/db'
import { UserRepo, toPublicUser } from '../src/auth/users'
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SessionRepo,
  TOUCH_INTERVAL_MS,
  hashSessionId,
} from '../src/auth/sessions'
import { AuditRepo, redactSecrets } from '../src/audit/audit'
import { AppError } from '../src/errors'

let dir: string
let store: Store
const clock = { now: 1_000_000 }
const now = () => clock.now

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mm-repo-'))
  store = await openStore(dir)
  clock.now = 1_000_000
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('UserRepo', () => {
  it('creates, finds case-insensitively and hides secrets in the public view', () => {
    const users = new UserRepo(store.db, now)
    const u = users.create({ username: 'Alice', passwordHash: 'h', role: 'admin' })
    expect(u).toEqual({
      id: expect.any(String),
      username: 'Alice',
      role: 'admin',
      totpEnabled: false,
      requireTwoFactor: false,
      disabled: false,
      createdAt: 1_000_000,
      passwordChangedAt: 1_000_000,
    })
    expect(users.findByUsername('alice')?.id).toBe(u.id)
    expect(users.findById(u.id)?.passwordHash).toBe('h')
    expect(Object.keys(toPublicUser(users.findById(u.id)!))).not.toContain('passwordHash')
    expect(users.count()).toBe(1)
  })

  it('rejects duplicate usernames regardless of case', () => {
    const users = new UserRepo(store.db, now)
    users.create({ username: 'alice', passwordHash: 'h', role: 'viewer' })
    try {
      users.create({ username: 'ALICE', passwordHash: 'h', role: 'viewer' })
      expect.unreachable()
    } catch (e) {
      expect((e as AppError).code).toBe('CONFLICT')
    }
  })

  it('updates password, role, disabled flag and TOTP state; counts active admins', () => {
    const users = new UserRepo(store.db, now)
    const a = users.create({ username: 'a1', passwordHash: 'h', role: 'admin' })
    const b = users.create({ username: 'b1', passwordHash: 'h', role: 'admin' })
    expect(users.countActiveAdmins()).toBe(2)
    users.setDisabled(b.id, true)
    expect(users.countActiveAdmins()).toBe(1)
    clock.now = 2_000_000
    users.setPassword(a.id, 'h2')
    users.setRole(a.id, 'editor')
    users.setTotp(a.id, 'sealed', true)
    users.setTotpLastStep(a.id, 42)
    expect(users.findById(a.id)).toMatchObject({
      passwordHash: 'h2',
      passwordChangedAt: 2_000_000,
      role: 'editor',
      totpEnabled: true,
      totpSecretSealed: 'sealed',
      totpLastStep: 42,
    })
    users.setTotp(a.id, null, false)
    expect(users.findById(a.id)).toMatchObject({
      totpEnabled: false,
      totpSecretSealed: null,
      totpLastStep: null,
    })
    expect(users.list().map((u) => u.username)).toEqual(['a1', 'b1'])
    users.delete(b.id)
    expect(users.findById(b.id)).toBeUndefined()
  })
})

describe('SessionRepo', () => {
  function setup() {
    const users = new UserRepo(store.db, now)
    const user = users.create({ username: 'alice', passwordHash: 'h', role: 'viewer' })
    return { users, user, sessions: new SessionRepo(store.db, now) }
  }

  it('stores only the hash of the session id', () => {
    const { user, sessions } = setup()
    const { sessionId, session } = sessions.create(user.id, { ip: '1.2.3.4', userAgent: 'test' })
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.idHash).toBe(hashSessionId(sessionId))
    const raw = store.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[]
    expect(raw).toEqual([{ id_hash: hashSessionId(sessionId) }])
    expect(sessions.get(sessionId)?.csrfToken).toBe(session.csrfToken)
    expect(sessions.get('forged')).toBeUndefined()
  })

  it('expires after idle and absolute timeouts, touching at most once per interval', () => {
    const { user, sessions } = setup()
    const { sessionId } = sessions.create(user.id, {})
    clock.now += TOUCH_INTERVAL_MS / 2
    expect(sessions.get(sessionId)?.lastSeenAt).toBe(1_000_000)
    clock.now += TOUCH_INTERVAL_MS
    expect(sessions.get(sessionId)?.lastSeenAt).toBe(clock.now)
    clock.now += SESSION_IDLE_MS + 1
    expect(sessions.get(sessionId)).toBeUndefined()

    const second = sessions.create(user.id, {})
    for (let t = 0; t < SESSION_ABSOLUTE_MS; t += SESSION_IDLE_MS / 2) {
      clock.now += SESSION_IDLE_MS / 2
      sessions.get(second.sessionId)
    }
    clock.now += 1
    expect(sessions.get(second.sessionId)).toBeUndefined()
  })

  it('revokes one, all for a user, cascades on user delete and prunes expired', () => {
    const { users, user, sessions } = setup()
    const s1 = sessions.create(user.id, {})
    const s2 = sessions.create(user.id, {})
    sessions.revoke(s1.sessionId)
    expect(sessions.get(s1.sessionId)).toBeUndefined()
    expect(sessions.get(s2.sessionId)).toBeDefined()
    sessions.revokeAllForUser(user.id)
    expect(sessions.get(s2.sessionId)).toBeUndefined()
    const s3 = sessions.create(user.id, {})
    users.delete(user.id)
    expect(sessions.get(s3.sessionId)).toBeUndefined()

    const other = users.create({ username: 'bob', passwordHash: 'h', role: 'viewer' })
    sessions.create(other.id, {})
    clock.now += SESSION_IDLE_MS + 1
    expect(sessions.pruneExpired()).toBe(1)
  })
})

describe('AuditRepo', () => {
  it('appends and lists newest first with filters and a limit cap', () => {
    const audit = new AuditRepo(store.db, now, randomBytes(32))
    for (let i = 0; i < 5; i++) {
      clock.now += 1
      audit.append({
        action: i % 2 ? 'auth.login' : 'users.create',
        outcome: 'success',
        userId: `u${i}`,
        username: `user${i}`,
      })
    }
    const all = audit.list({})
    expect(all.map((e) => e.userId)).toEqual(['u4', 'u3', 'u2', 'u1', 'u0'])
    expect(audit.list({ action: 'auth.login' }).map((e) => e.userId)).toEqual(['u3', 'u1'])
    expect(audit.list({ userId: 'u2' })).toHaveLength(1)
    expect(audit.list({ beforeId: all[1]!.id }).map((e) => e.userId)).toEqual(['u2', 'u1', 'u0'])
    expect(audit.list({ limit: 2 })).toHaveLength(2)
    expect(audit.list({ limit: 100_000 })).toHaveLength(5)
  })

  it('redacts secrets in details, recursively', () => {
    const audit = new AuditRepo(store.db, now, randomBytes(32))
    audit.append({
      action: 'x' as AuditAction,
      outcome: 'failure',
      details: {
        password: 'p',
        nested: { apiKey: 'k', uri: 'mongodb://u:p@h', list: [{ token: 't' }] },
        safe: 'ok',
      },
    })
    expect(audit.list({})[0]!.details).toEqual({
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', uri: '[REDACTED]', list: [{ token: '[REDACTED]' }] },
      safe: 'ok',
    })
    expect(redactSecrets('plain')).toBe('plain')
  })
})
