import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditAction } from '@mongo-manager/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openStore, type Store } from '../src/store/db'
import { AuditRepo } from '../src/audit/audit'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey, verifyKeyCheck } from '../src/crypto/rotate'
import { appKey } from '../src/crypto/app-keys'
import { H, makeApp, type TestApp } from './helpers'

/**
 * Security audit 2026-10-16 (minor): the audit log's append-only triggers stop the app, not someone
 * with the database file. Each entry now carries an HMAC over the one before it and itself (a key
 * the file does not hold in the clear), so a changed, removed or added entry breaks the chain; the
 * log, its export and the audit page say where.
 */
const dirs: string[] = []
const stores: Store[] = []
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const DAY = 86_400_000

/** A log, with `legacy` entries written before the chain existed (the key made with the chain). */
async function repo(legacy = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-chain-'))
  dirs.push(dir)
  const store = await openStore(dir)
  stores.push(store)
  const clock = { now: Date.UTC(2026, 0, 1) }
  const key = randomBytes(32)
  const old = store.db.prepare(
    "INSERT INTO audit_log (at, action, outcome) VALUES (?, 'old.entry', 'success')",
  )
  for (let i = 1; i <= legacy; i++) old.run(i)
  const audit = new AuditRepo(store.db, () => clock.now, key, { keyCreated: true })
  const add = (action: AuditAction = 'x.y' as AuditAction, details: unknown = { n: 1 }) => {
    clock.now += 1000
    audit.append({ action, outcome: 'success', userId: 'u1', username: 'ada', ip: '10.0.0.1', details })
  }
  const ids = () =>
    (store.db.prepare('SELECT id FROM audit_log ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
  return { dir, store, db: store.db, clock, key, audit, add, ids }
}

/** What someone with the file can do: the triggers are the app's, not theirs. */
function tamper(db: DatabaseSync, sql: string, ...params: Array<string | number | null>) {
  db.exec('DROP TRIGGER IF EXISTS audit_log_no_update; DROP TRIGGER IF EXISTS audit_log_no_delete')
  db.prepare(sql).run(...params)
}

describe('the audit chain', () => {
  it('chains every entry and finds the log whole', async () => {
    const r = await repo()
    for (let i = 0; i < 5; i++) r.add()
    expect(await r.audit.verify()).toMatchObject({ ok: true, brokenAt: null, legacy: 0 })
    expect(await r.audit.verifyAll()).toMatchObject({ ok: true, checked: 5 })
  })

  it('says where an entry was changed', async () => {
    const r = await repo()
    for (let i = 0; i < 5; i++) r.add()
    const [, , third] = r.ids()
    tamper(r.db, "UPDATE audit_log SET username = 'mallory' WHERE id = ?", third!)
    expect(await r.audit.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: third } })
  })

  it('says where an entry was removed or one was added', async () => {
    const r = await repo()
    for (let i = 0; i < 5; i++) r.add()
    const [, second, third] = r.ids()
    tamper(r.db, 'DELETE FROM audit_log WHERE id = ?', second!)
    expect(await r.audit.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: third } })

    const s = await repo()
    for (let i = 0; i < 3; i++) s.add()
    tamper(
      s.db,
      "INSERT INTO audit_log (at, action, outcome, chain) VALUES (?, 'users.create', 'success', ?)",
      s.clock.now + 1,
      'f'.repeat(43),
    )
    s.add()
    expect(await s.audit.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: s.ids()[3] } })
  })

  it('takes the entries of before the chain as they are, but not an unchained one after it', async () => {
    const r = await repo(2)
    r.add()
    r.add()
    expect(await r.audit.verifyAll()).toMatchObject({ ok: true, legacy: 2 })
    tamper(
      r.db,
      "INSERT INTO audit_log (at, action, outcome) VALUES (?, 'sneaked.in', 'success')",
      r.clock.now,
    )
    expect(await r.audit.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: r.ids().at(-1) } })
  })

  it('stays whole through the retention purge, even of every entry', async () => {
    const r = await repo()
    for (let i = 0; i < 4; i++) r.add()
    r.audit.setRetention(30)
    r.clock.now += 40 * DAY
    expect(await r.audit.sweep()).toBe(4)
    // The purge's own entry follows the ones it removed.
    expect(await r.audit.verifyAll()).toMatchObject({ ok: true, checked: 1 })
    r.add()
    r.clock.now += 40 * DAY
    await r.audit.sweep()
    r.add()
    expect(await r.audit.verifyAll()).toMatchObject({ ok: true })
  })

  // Review of the audit fixes (important 4): every chain value set to NULL made every entry look like
  // one from before the chain, and a forged entry passed.
  it('does not take entries made unchained after the chain began as old ones', async () => {
    const r = await repo(2)
    for (let i = 0; i < 5; i++) r.add()
    tamper(r.db, "UPDATE audit_log SET chain = NULL, username = 'forged'")
    expect(await r.audit.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: r.ids()[2] }, legacy: 2 })
  })

  it('takes a changed record of where the chain began as a break', async () => {
    const r = await repo(2)
    for (let i = 0; i < 3; i++) r.add()
    tamper(r.db, "UPDATE settings SET value = '999.x' WHERE key = 'audit_chain_start'")
    expect(await r.audit.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: r.ids()[0] } })
  })

  // Review of the audit fixes (important 5): 200 000 entries held the server for 5 s. CI 2026-10-22
  // and 2026-10-23: told by the turns other work gets between its pages, not by the clock, which a
  // runner's own pause (113 ms, then 77 ms against a walk of some 150 ms) moved twice.
  it('lets other work run while it checks a long log', async ({ onTestFinished }) => {
    const r = await repo()
    r.db.exec('BEGIN')
    for (let i = 0; i < 20_000; i++) r.audit.append({ action: 'bulk' as AuditAction, outcome: 'success' })
    r.db.exec('COMMIT')
    // Other work: one turn each time the event loop comes round; stopped with the test, though the
    // walk never ended (review of the walk's turns, nit 2).
    let turns = 0
    let running = true
    onTestFinished(() => {
      running = false
    })
    const other = () => {
      turns++
      if (running) setImmediate(other)
    }
    setImmediate(other)
    // Each page the walk reads: how many turns other work had had by then, how many it asks for, and
    // how many it gets. An export with no filter reads by the same words; none runs here (nit 1).
    const pages: Array<{ turns: number; limit: number; rows: number }> = []
    const prepare = r.db.prepare.bind(r.db)
    const spy = vi.spyOn(r.db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      if (/^SELECT \* FROM audit_log WHERE id > \? ORDER BY id LIMIT \?$/.test(sql)) {
        const all = statement.all.bind(statement)
        statement.all = ((...args: Parameters<typeof all>) => {
          const read = all(...args)
          pages.push({ turns, limit: Number(args[1]), rows: read.length })
          return read
        }) as typeof statement.all
      }
      return statement
    })
    try {
      const result = await r.audit.verifyAll()
      expect(result).toMatchObject({ ok: true, checked: 20_000 })
    } finally {
      running = false
      spy.mockRestore()
    }
    // 20 000 entries in pages of at most 500 (CHAIN_PAGE), each read once (nit 4)…
    expect(
      pages.length,
      'the walk reads its pages through db.prepare(that SELECT).all',
    ).toBeGreaterThanOrEqual(40)
    expect(Math.max(...pages.map((page) => page.limit))).toBeLessThanOrEqual(500)
    expect(pages.reduce((sum, page) => sum + page.rows, 0)).toBe(20_000)
    // …and other work ran between every two of them: never two pages, nor most of the walk, at once.
    const held = pages.filter((page, k) => k > 0 && page.turns <= pages[k - 1]!.turns)
    expect(held).toEqual([])
  }, 120_000)

  // Second review (N1): a full look and the purge running together reported "broken at 5001" (the
  // look followed an entry the purge had just removed) — and an export kept that for good.
  it('is not fooled by the purge removing entries while it looks', async () => {
    const r = await repo()
    r.db.exec('BEGIN')
    for (let i = 0; i < 20_000; i++) r.audit.append({ action: 'x.y' as AuditAction, outcome: 'success', ip: '1.2.3.4' })
    r.db.exec('COMMIT')
    r.clock.now += 40 * DAY
    r.audit.setRetention(30)
    r.clock.now += 2 * DAY
    for (let i = 0; i < 10; i++) r.add('x.new' as AuditAction)
    expect(await r.audit.verify()).toMatchObject({ ok: true })
    r.clock.now += 2 * 3600_000
    const [looked, removed] = await Promise.all([r.audit.verify(), r.audit.sweep()])
    expect(removed).toBe(20_000)
    expect(looked).toMatchObject({ ok: true, brokenAt: null })
    expect(await r.audit.verify()).toMatchObject({ ok: true })
    r.clock.now += 2 * 3600_000
    expect(await r.audit.verify()).toMatchObject({ ok: true })
  }, 120_000)

  // Second review (minor 1): a log whose key was made by a build before the record of where the chain
  // began gets the record once, where the chain does begin, and says so in the log.
  it('records where an older build began the chain, once', async () => {
    const r = await repo(2)
    for (let i = 0; i < 3; i++) r.add()
    tamper(r.db, "DELETE FROM settings WHERE key = 'audit_chain_start'")
    const again = new AuditRepo(r.db, () => r.clock.now, r.key)
    expect(await again.verifyAll()).toMatchObject({ ok: true, legacy: 2 })
    expect(again.list({ action: 'audit.chain.started' })).toHaveLength(1)
    // Unchained entries after it are still a break.
    tamper(r.db, 'UPDATE audit_log SET chain = NULL WHERE id = ?', r.ids()[3]!)
    expect(await again.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: r.ids()[3] } })
  })

  // Review of the audit fixes (minor 4): an entry written while the purge runs stays.
  it('keeps an entry written while the purge removes everything older', async () => {
    const r = await repo()
    r.db.exec('BEGIN')
    for (let i = 0; i < 6_000; i++) r.audit.append({ action: 'old.one' as AuditAction, outcome: 'success' })
    r.db.exec('COMMIT')
    r.audit.setRetention(30)
    r.clock.now += 40 * DAY
    setImmediate(() => r.audit.append({ action: 'during.purge' as AuditAction, outcome: 'success' }))
    await r.audit.sweep()
    expect(r.audit.list({ action: 'during.purge' })).toHaveLength(1)
    expect(await r.audit.verifyAll()).toMatchObject({ ok: true })
  })

  // Review of the audit fixes (minor 5): a break the purge removed is not shown for ever.
  it('looks again once the purge removed the entries it found broken', async () => {
    const r = await repo()
    r.audit.setRetention(30)
    for (let i = 0; i < 4; i++) r.add()
    tamper(r.db, "UPDATE audit_log SET action = 'z' WHERE id = ?", r.ids()[1]!)
    r.clock.now += 40 * DAY
    expect(await r.audit.verify()).toMatchObject({ ok: false })
    // Within the hour of that look (no full look of its own yet).
    expect(await r.audit.sweep()).toBe(4)
    expect(await r.audit.verify()).toMatchObject({ ok: true })
  })

  it('stays whole when the purge removes the older part of the log', async () => {
    const r = await repo()
    for (let i = 0; i < 3; i++) r.add('old.one' as AuditAction)
    r.audit.setRetention(30)
    r.clock.now += 40 * DAY
    for (let i = 0; i < 2; i++) r.add('new.one' as AuditAction)
    expect(await r.audit.sweep()).toBe(3)
    // The first entry kept followed one now gone: the anchor stands for it.
    expect(await r.audit.verifyAll()).toMatchObject({ ok: true, checked: 3 })
  })

  it('checks only what is new on a second look, and keeps a break once found', async () => {
    const r = await repo()
    for (let i = 0; i < 6; i++) r.add()
    expect(await r.audit.verify()).toMatchObject({ ok: true, checked: 6 })
    r.add()
    expect(await r.audit.verify()).toMatchObject({ ok: true, checked: 1 })
    const last = r.ids().at(-1)!
    r.add()
    tamper(r.db, "UPDATE audit_log SET action = 'z' WHERE id = ?", last + 1)
    expect(await r.audit.verify()).toMatchObject({ ok: false, brokenAt: { id: last + 1 } })
    r.add()
    expect(await r.audit.verify()).toMatchObject({ ok: false, brokenAt: { id: last + 1 } })
  })

  it('looks at the whole chain again an hour after it last did', async () => {
    const r = await repo()
    for (let i = 0; i < 4; i++) r.add()
    expect(await r.audit.verify()).toMatchObject({ ok: true, checked: 4 })
    // Changed behind the last look: the next looks see only what is new...
    tamper(r.db, "UPDATE audit_log SET action = 'z' WHERE id = ?", r.ids()[1]!)
    expect(await r.audit.verify()).toMatchObject({ ok: true, checked: 0 })
    // ...until the hourly look at all of it.
    r.clock.now += 3600_000
    expect(await r.audit.verify()).toMatchObject({ ok: false, brokenAt: { id: r.ids()[1] }, checked: 4 })
  })

  it('does not take another key’s chain', async () => {
    const r = await repo()
    for (let i = 0; i < 3; i++) r.add()
    const other = new AuditRepo(r.db, () => r.clock.now, randomBytes(32))
    expect(await other.verifyAll()).toMatchObject({ ok: false, brokenAt: { id: r.ids()[0] } })
  })

  it('stays whole after a key rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-chain-rotate-'))
    dirs.push(dir)
    const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    let store = await openStore(dir)
    verifyKeyCheck(store.db, box)
    const audit = new AuditRepo(store.db, Date.now, appKey(store.db, box, 'audit-chain'))
    for (let i = 0; i < 3; i++) audit.append({ action: 'x' as AuditAction, outcome: 'success' })
    store.close()
    await rotateSecretKey({ dataDir: dir })
    const rotated = createSecretBox(loadOrCreateKey({ dataDir: dir }))
    store = await openStore(dir)
    stores.push(store)
    const after = new AuditRepo(store.db, Date.now, appKey(store.db, rotated, 'audit-chain'))
    expect(await after.verifyAll()).toMatchObject({ ok: true, checked: 3 })
  })
})

describe('the audit chain, as the app shows it', () => {
  async function local() {
    const t = await makeApp()
    apps.push(t)
    const call = (url: string) => t.app.inject({ method: 'GET', url, headers: H })
    return { t, call }
  }

  it('answers whether the log is whole, and says where it broke', async () => {
    const { t, call } = await local()
    for (let i = 0; i < 3; i++) t.app.ctx.audit.append({ action: 'x' as AuditAction, outcome: 'success' })
    expect((await call('/api/audit/integrity')).json()).toMatchObject({ ok: true, brokenAt: null })
    const db = (t.app.ctx.audit as unknown as { db: DatabaseSync }).db
    // Changed after the last look: found by the next look at the new entries' link to it.
    t.app.ctx.audit.append({ action: 'x' as AuditAction, outcome: 'success' })
    const id = (db.prepare('SELECT MAX(id) AS id FROM audit_log').get() as { id: number }).id
    tamper(db, "UPDATE audit_log SET action = 'other' WHERE id = ?", id)
    const res = (await call('/api/audit/integrity')).json()
    expect(res).toMatchObject({ ok: false, brokenAt: { id } })
    expect(typeof res.brokenAt.at).toBe('number')
  })

  it('marks an export with the state of the whole chain', async () => {
    const { t, call } = await local()
    t.app.ctx.audit.append({ action: 'x' as AuditAction, outcome: 'success' })
    const whole = await call('/api/audit/export?format=ndjson')
    expect(whole.headers['x-audit-chain']).toBe('ok')
    // Changed after the last look: the next export checks what is new since, so a new entry
    // following a changed one shows it (the whole chain is looked at again hourly).
    const db = (t.app.ctx.audit as unknown as { db: DatabaseSync }).db
    t.app.ctx.audit.append({ action: 'y' as AuditAction, outcome: 'success' })
    const id = (db.prepare('SELECT MAX(id) AS id FROM audit_log').get() as { id: number }).id
    tamper(db, "UPDATE audit_log SET outcome = 'failure' WHERE id = ?", id)
    const broken = await call('/api/audit/export?format=csv')
    expect(broken.headers['x-audit-chain']).toBe(`broken at ${id}`)
  })

  // Review of the audit fixes (important 5): exports share one look, never a full walk each.
  it('never walks the whole chain for every export', async () => {
    const { t, call } = await local()
    for (let i = 0; i < 50; i++) t.app.ctx.audit.append({ action: 'x' as AuditAction, outcome: 'success' })
    const walk = vi.spyOn(t.app.ctx.audit, 'verifyAll')
    const looks = (await Promise.all([1, 2, 3].map(() => call('/api/audit/export?format=ndjson')))).map(
      (r) => r.headers['x-audit-chain'],
    )
    expect(looks).toEqual(['ok', 'ok', 'ok'])
    expect(walk).not.toHaveBeenCalled()
  })

  it('shows the state only to who may read the log', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const user = t.app.ctx.users.create({ username: 'ed', passwordHash: 'x', role: 'editor' })
    const s = t.app.ctx.sessions.create(user.id, {})
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/audit/integrity',
      headers: H,
      cookies: { mm_sid: s.sessionId },
    })
    expect(res.statusCode).toBe(403)
  })
})
