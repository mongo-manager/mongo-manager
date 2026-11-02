import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, transaction, type Store } from '../src/store/db'
import { MIGRATIONS } from '../src/store/migrations'
import { createSecretBox, loadOrCreateKey } from '../src/crypto/secret-box'
import { rotateSecretKey } from '../src/crypto/rotate'
import { ConnectionRepo } from '../src/connections/repo'
import { QueryHistoryRepo, MAX_HISTORY_PER_COLLECTION, MAX_HISTORY_PER_OWNER } from '../src/queries/history'
import { recentContext } from '../src/queries/recent'
import { randomUUID } from 'node:crypto'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(migrations = MIGRATIONS) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-history-'))
  dirs.push(dir)
  const box = createSecretBox(loadOrCreateKey({ dataDir: dir }))
  const store = await openStore(dir, migrations)
  stores.push(store)
  const conn = new ConnectionRepo(store.db, box, Date.now).create(
    { name: 'P', settings: { hosts: [{ host: 'h' }] } } as never,
    null,
  )
  let t = 1_000
  return { dir, store, box, conn, repo: new QueryHistoryRepo(store.db, box, () => ++t) }
}

const count = (store: Store, table = 'query_history') =>
  (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('query history (phase 2c spec §2.1)', () => {
  it('keeps finds and aggregations newest first, counting repeats', async () => {
    const { conn, repo } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    repo.record(null, conn.id, 'shop', 'items', 'aggregate', { stages: [{ $match: {} }] })
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    const list = repo.list({ owner: null, connectionId: conn.id, limit: 10 })
    expect(list.map((e) => [e.kind, e.count])).toEqual([
      ['find', 2],
      ['aggregate', 1],
    ])
    expect(list[0]!.body).toEqual({ filter: { a: 1 } })
    expect(repo.list({ owner: null, connectionId: conn.id, kind: 'aggregate', limit: 10 })).toHaveLength(1)
    expect(repo.list({ owner: null, connectionId: conn.id, coll: 'other', limit: 10 })).toEqual([])
  })

  it('keeps 200 per collection and 2 000 per owner, the oldest dropped; big bodies are not kept', async () => {
    const { store, conn, repo } = await setup()
    // Thousands of records, each its own commit, wait on the disk under a loaded machine: one
    // transaction around them keeps the test quick (each record's savepoint and pruning run as ever).
    const inOneCommit = (fill: () => void) => transaction(store.db, fill)
    inOneCommit(() => {
      for (let i = 0; i < MAX_HISTORY_PER_COLLECTION + 5; i++)
        repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { i } })
    })
    expect(repo.list({ owner: null, connectionId: conn.id, coll: 'items', limit: 500 })).toHaveLength(
      MAX_HISTORY_PER_COLLECTION,
    )
    inOneCommit(() => {
      for (let i = 0; i < MAX_HISTORY_PER_OWNER; i++)
        repo.record(null, conn.id, 'shop', `c${i % 20}`, 'find', { filter: { j: i } })
    })
    expect(count(store)).toBe(MAX_HISTORY_PER_OWNER)
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { big: 'x'.repeat(70 * 1024) } })
    expect(JSON.stringify(repo.list({ owner: null, connectionId: conn.id, limit: 1 }))).not.toContain('xxxx')
  })

  it('belongs to its owner only', async () => {
    const { conn, repo, store } = await setup()
    const ada = randomUUID()
    store.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES (?, 'ada', 'x', 'editor', 0, 0)",
      )
      .run(ada)
    repo.record(ada, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 })).toEqual([])
    expect(repo.list({ owner: ada, connectionId: conn.id, limit: 10 })).toHaveLength(1)
  })

  it('finds repeats by a keyed hash, not a plain one, and not across owners', async () => {
    const { conn, repo, store } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    const row = store.db.prepare('SELECT body_hash, body FROM query_history').get() as {
      body_hash: string
      body: string
    }
    const plain = createHash('sha256')
      .update(JSON.stringify({ filter: { a: 1 } }))
      .digest('hex')
    expect(row.body_hash).not.toBe(plain)
    expect(row.body).toMatch(/^v1\./)
    expect(row.body).not.toContain('"a"')
  })

  it('removes one entry, or all of a connection, for its owner only', async () => {
    const { conn, repo } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { b: 1 } })
    const [first] = repo.list({ owner: null, connectionId: conn.id, limit: 10 })
    expect(repo.remove('someone-else', first!.id)).toBe(false)
    expect(repo.remove(null, first!.id)).toBe(true)
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 })).toHaveLength(1)
    repo.clear(null, conn.id)
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 })).toEqual([])
  })
})

describe('moving recent queries into history (Review Focus 1)', () => {
  /** A v6 store with recent queries, as phase 1g-1 wrote them. */
  async function withRecent() {
    const env = await setup(MIGRATIONS.filter((m) => m.version <= 6))
    const insert = env.store.db.prepare(
      'INSERT INTO recent_queries (id, user_id, connection_id, db, coll, query, used_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 3; i++) {
      const row = { id: randomUUID(), user_id: null, connection_id: env.conn.id, db: 'shop', coll: 'items' }
      insert.run(
        row.id,
        env.conn.id,
        'shop',
        'items',
        env.box.seal(JSON.stringify({ filter: { i } }), recentContext(row)),
        100 + i,
      )
    }
    // One sealed for another row: it cannot be opened.
    insert.run(randomUUID(), env.conn.id, 'shop', 'items', env.box.seal('{}', 'recent:elsewhere'), 50)
    env.store.close()
    stores.splice(stores.indexOf(env.store), 1)
    const store = await openStore(env.dir)
    stores.push(store)
    return { ...env, store, repo: new QueryHistoryRepo(store.db, env.box, Date.now) }
  }

  it('moves the rows it can open, drops the others, and then the old table', async () => {
    const { store, conn, repo } = await withRecent()
    expect(repo.moveRecent()).toEqual({ moved: 3, dropped: 1 })
    const list = repo.list({ owner: null, connectionId: conn.id, limit: 10 })
    expect(list.map((e) => e.body)).toEqual([
      { filter: { i: 2 } },
      { filter: { i: 1 } },
      { filter: { i: 0 } },
    ])
    expect(list.map((e) => e.kind)).toEqual(['find', 'find', 'find'])
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_queries'")
      .all()
    expect(tables).toEqual([])
    expect(repo.moveRecent()).toEqual({ moved: 0, dropped: 0 })
  })

  it('leaves the old table in place when the move fails half way', async () => {
    const { store, repo } = await withRecent()
    const original = repo.record.bind(repo)
    let n = 0
    repo.record = (...args: Parameters<typeof repo.record>) => {
      if (++n === 2) throw new Error('disk full')
      original(...args)
    }
    expect(() => repo.moveRecent()).toThrow('disk full')
    expect(count(store, 'recent_queries')).toBe(4)
    expect(count(store)).toBe(0)
  })
})

describe('the move at startup (Review Focus 1)', () => {
  it('runs when the app starts on a store with recent queries', async () => {
    const env = await setup(MIGRATIONS.filter((m) => m.version <= 6))
    const row = { id: randomUUID(), user_id: null, connection_id: env.conn.id, db: 'shop', coll: 'items' }
    env.store.db
      .prepare(
        'INSERT INTO recent_queries (id, user_id, connection_id, db, coll, query, used_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        env.conn.id,
        'shop',
        'items',
        env.box.seal(JSON.stringify({ filter: { kept: true } }), recentContext(row)),
        1,
      )
    env.store.close()
    stores.splice(stores.indexOf(env.store), 1)
    const { resolveConfig } = await import('../src/config')
    const { buildApp } = await import('../src/http/app')
    const store = await openStore(env.dir)
    stores.push(store)
    const app = await buildApp({
      config: resolveConfig({ cli: { dataDir: env.dir, logLevel: 'silent' } }),
      store,
      secretBox: env.box,
    })
    const list = app.ctx.history.list({ owner: null, connectionId: env.conn.id, limit: 10 })
    await app.close()
    expect(list.map((e) => e.body)).toEqual([{ filter: { kept: true } }])
  })
})

describe('history and rotate-key (Review Focus 2)', () => {
  it('re-seals bodies and re-keys their hashes, so repeats are still found', async () => {
    const { dir, store, conn, repo } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result.history).toBe(1)
    const reopened = await openStore(dir)
    stores.push(reopened)
    const fresh = new QueryHistoryRepo(
      reopened.db,
      createSecretBox(loadOrCreateKey({ dataDir: dir })),
      Date.now,
    )
    fresh.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    expect(fresh.list({ owner: null, connectionId: conn.id, limit: 10 }).map((e) => e.count)).toEqual([2])
  })
})

function addUserTo(store: Store, name: string): string {
  const id = randomUUID()
  store.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, password_changed_at, created_at) VALUES (?, ?, 'x', 'editor', 0, 0)",
    )
    .run(id, name)
  return id
}

describe('final review 2c: history store', () => {
  it('finds a repeat per owner: the same query of two owners is two entries (Minor 4)', async () => {
    const { conn, repo, store } = await setup()
    const ada = addUserTo(store, 'ada')
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    repo.record(ada, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    const hashes = store.db.prepare('SELECT body_hash FROM query_history').all() as Array<{
      body_hash: string
    }>
    expect(new Set(hashes.map((h) => h.body_hash)).size).toBe(2)
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 }).map((e) => e.count)).toEqual([1])
    expect(repo.list({ owner: ada, connectionId: conn.id, limit: 10 }).map((e) => e.count)).toEqual([1])
  })

  it('never loses a repeated entry when recording it fails half way (Minor 1)', async () => {
    const { conn, repo, box } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    const seal = box.seal.bind(box)
    box.seal = () => {
      throw new Error('disk full')
    }
    expect(() => repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })).toThrow(
      'disk full',
    )
    box.seal = seal
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 }).map((e) => e.count)).toEqual([1])
  })

  it('clears by db, coll and kind only (Minor 24)', async () => {
    const { conn, repo } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    expect(() => repo.clear(null, conn.id, { 'db = db OR 1': 'x' } as never)).toThrow()
    expect(repo.list({ owner: null, connectionId: conn.id, limit: 10 })).toHaveLength(1)
  })
})

describe('final review 2c: rotate-key and the move (C1, Minor 3)', () => {
  it('rotates after the move has dropped recent_queries, and repeats are still found', async () => {
    const { dir, store, conn, repo } = await setup()
    repo.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    repo.moveRecent()
    expect(
      store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recent_queries'").get(),
    ).toBeUndefined()
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const result = await rotateSecretKey({ dataDir: dir })
    expect(result).toMatchObject({ history: 1, movedRecent: 0, droppedRecent: 0 })
    const reopened = await openStore(dir)
    stores.push(reopened)
    const fresh = new QueryHistoryRepo(
      reopened.db,
      createSecretBox(loadOrCreateKey({ dataDir: dir })),
      Date.now,
    )
    fresh.record(null, conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    expect(fresh.list({ owner: null, connectionId: conn.id, limit: 10 }).map((e) => e.count)).toEqual([2])
  })

  it('moves recent queries first when rotating before the first start, even with one that does not open', async () => {
    const env = await setup(MIGRATIONS.filter((m) => m.version <= 6))
    const insert = env.store.db.prepare(
      'INSERT INTO recent_queries (id, user_id, connection_id, db, coll, query, used_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    )
    const row = { id: randomUUID(), user_id: null, connection_id: env.conn.id, db: 'shop', coll: 'items' }
    insert.run(
      row.id,
      env.conn.id,
      'shop',
      'items',
      env.box.seal('{"filter":{"k":1}}', recentContext(row)),
      5,
    )
    insert.run(randomUUID(), env.conn.id, 'shop', 'items', env.box.seal('{}', 'recent:elsewhere'), 6)
    env.store.close()
    stores.splice(stores.indexOf(env.store), 1)
    // Migration 7 runs as the rotation opens the store.
    const result = await rotateSecretKey({ dataDir: env.dir })
    expect(result).toMatchObject({ history: 1, movedRecent: 1, droppedRecent: 1 })
    const reopened = await openStore(env.dir)
    stores.push(reopened)
    const fresh = new QueryHistoryRepo(
      reopened.db,
      createSecretBox(loadOrCreateKey({ dataDir: env.dir })),
      Date.now,
    )
    expect(fresh.list({ owner: null, connectionId: env.conn.id, limit: 10 }).map((e) => e.body)).toEqual([
      { filter: { k: 1 } },
    ])
  })
})

describe('final review 2c: the move at scale and at startup (I6, Minor 2, I4)', () => {
  it('moves thousands of rows of several owners, dropping only those that do not open', async () => {
    const env = await setup(MIGRATIONS.filter((m) => m.version <= 6))
    const owners = [null, addUserTo(env.store, 'ada'), addUserTo(env.store, 'bob')]
    const insert = env.store.db.prepare(
      'INSERT INTO recent_queries (id, user_id, connection_id, db, coll, query, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const unreadable = (i: number) => i % 97 === 0
    env.store.db.exec('BEGIN')
    for (let i = 0; i < 3000; i++) {
      const owner = owners[i % 3]!
      const row = {
        id: randomUUID(),
        user_id: owner,
        connection_id: env.conn.id,
        db: 'shop',
        coll: `c${i % 30}`,
      }
      insert.run(
        row.id,
        owner,
        env.conn.id,
        'shop',
        row.coll,
        env.box.seal(JSON.stringify({ filter: { i } }), unreadable(i) ? 'recent:lost' : recentContext(row)),
        i,
      )
    }
    env.store.db.exec('COMMIT')
    env.store.close()
    stores.splice(stores.indexOf(env.store), 1)
    const store = await openStore(env.dir)
    stores.push(store)
    const repo = new QueryHistoryRepo(store.db, env.box, Date.now)
    const indexes = Array.from({ length: 3000 }, (_, i) => i)
    const bad = indexes.filter(unreadable).length
    expect(repo.moveRecent()).toEqual({ moved: 3000 - bad, dropped: bad })
    for (const [n, owner] of owners.entries()) {
      const list = repo.list({ owner, connectionId: env.conn.id, limit: 2000 })
      expect(list.length).toBe(indexes.filter((i) => i % 3 === n && !unreadable(i)).length)
      expect(list[0]!.usedAt).toBeGreaterThan(list.at(-1)!.usedAt)
    }
  })

  it('starts when the move fails, logs it, keeps the rows for the next start, and warns about dropped rows', async () => {
    const env = await setup(MIGRATIONS.filter((m) => m.version <= 6))
    const insert = env.store.db.prepare(
      'INSERT INTO recent_queries (id, user_id, connection_id, db, coll, query, used_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    )
    const row = { id: randomUUID(), user_id: null, connection_id: env.conn.id, db: 'shop', coll: 'items' }
    insert.run(row.id, env.conn.id, 'shop', 'items', env.box.seal('{"filter":{}}', recentContext(row)), 5)
    insert.run(randomUUID(), env.conn.id, 'shop', 'items', env.box.seal('{}', 'recent:elsewhere'), 6)
    env.store.close()
    stores.splice(stores.indexOf(env.store), 1)
    const { resolveConfig } = await import('../src/config')
    const { buildApp } = await import('../src/http/app')
    const logFile = join(env.dir, 'mm.log')
    const config = resolveConfig({ cli: { dataDir: env.dir, logLevel: 'info', logFile } })
    const store = await openStore(env.dir)
    stores.push(store)
    store.db.exec(
      "CREATE TRIGGER no_history BEFORE INSERT ON query_history BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    )
    const failing = await buildApp({ config, store, secretBox: env.box, logger: true })
    await failing.close()
    expect(count(store, 'recent_queries')).toBe(2)
    store.db.exec('DROP TRIGGER no_history')
    const app = await buildApp({ config, store, secretBox: env.box, logger: true })
    await app.close()
    const lines = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { level: number; msg: string; moved?: number; dropped?: number })
    expect(lines.find((l) => l.msg.startsWith('could not move recent queries'))?.level).toBe(50)
    expect(lines.find((l) => l.msg.startsWith('recent queries moved'))).toMatchObject({
      level: 40,
      moved: 1,
      dropped: 1,
    })
  })

  it("removes the local user's history when team mode starts, and logs how many rows went (I4)", async () => {
    const env = await setup()
    env.repo.record(null, env.conn.id, 'shop', 'items', 'find', { filter: { a: 1 } })
    env.repo.record(null, env.conn.id, 'shop', 'items', 'find', { filter: { b: 1 } })
    const { resolveConfig } = await import('../src/config')
    const { buildApp } = await import('../src/http/app')
    const logFile = join(env.dir, 'team.log')
    const team = await buildApp({
      config: resolveConfig({ cli: { dataDir: env.dir, logLevel: 'info', logFile, auth: true } }),
      store: env.store,
      secretBox: env.box,
      logger: true,
    })
    await team.close()
    expect(env.repo.list({ owner: null, connectionId: env.conn.id, limit: 10 })).toEqual([])
    const lines = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { level: number; msg: string; removed?: number })
    expect(lines.find((l) => l.msg.startsWith('local mode query history removed'))).toMatchObject({
      level: 40,
      removed: 2,
    })
  })
})
