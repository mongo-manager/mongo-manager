import { describe, expect, it } from 'vitest'
import { commandPolicy, commandName, type Command } from '../src/shell/proxy/policy'

const cmd = (name: string, body: Record<string, unknown> = {}, db = 'shop'): Command => ({
  name,
  db,
  body: { [name]: body[name] ?? 1, ...body },
})

describe('read-only command policy (phase 3a-1 §5.3)', () => {
  const check = commandPolicy({ readOnly: true, admin: true })
  const allowed = (c: Command) => check(c).allow

  it('allows the read commands', () => {
    for (const name of [
      'find',
      'getMore',
      'count',
      'distinct',
      'listCollections',
      'listDatabases',
      'listIndexes',
      'dbStats',
      'collStats',
      'serverStatus',
      'hello',
      'buildInfo',
      'connectionStatus',
      'killCursors',
      'endSessions',
      'ping',
    ]) {
      expect(allowed(cmd(name)), name).toBe(true)
    }
  })

  it('allows a read aggregate but refuses one that writes, even nested', () => {
    expect(
      allowed({ name: 'aggregate', db: 'shop', body: { aggregate: 'c', pipeline: [{ $match: {} }] } }),
    ).toBe(true)
    expect(
      allowed({ name: 'aggregate', db: 'shop', body: { aggregate: 'c', pipeline: [{ $out: 'x' }] } }),
    ).toBe(false)
    expect(
      allowed({ name: 'aggregate', db: 'shop', body: { aggregate: 'c', pipeline: [{ $merge: 'x' }] } }),
    ).toBe(false)
    expect(
      allowed({
        name: 'aggregate',
        db: 'shop',
        body: { aggregate: 'c', pipeline: [{ $facet: { a: [{ $out: 'x' }] } }] },
      }),
    ).toBe(false)
    expect(
      allowed({
        name: 'aggregate',
        db: 'shop',
        body: { aggregate: 'c', pipeline: [{ $unionWith: { coll: 'y', pipeline: [{ $merge: 'z' }] } }] },
      }),
    ).toBe(false)
  })

  it('refuses writes and DDL', () => {
    for (const name of [
      'insert',
      'update',
      'delete',
      'findAndModify',
      'create',
      'drop',
      'dropDatabase',
      'createIndexes',
      'dropIndexes',
      'renameCollection',
      'collMod',
      'mapReduce',
      'bulkWrite',
    ]) {
      expect(allowed(cmd(name)), name).toBe(false)
    }
  })

  it('refuses an unknown command', () => {
    expect(allowed(cmd('somethingNew'))).toBe(false)
  })

  it('judges explain by what it explains', () => {
    expect(allowed({ name: 'explain', db: 'shop', body: { explain: { find: 'c' } } })).toBe(true)
    expect(allowed({ name: 'explain', db: 'shop', body: { explain: { insert: 'c' } } })).toBe(false)
  })
})

describe('non-admin command policy (phase 3a-1 §5.3)', () => {
  const check = commandPolicy({ readOnly: false, admin: false })
  const allowed = (c: Command) => check(c).allow

  it('refuses cluster and user administration', () => {
    for (const name of [
      'createUser',
      'dropUser',
      'grantRolesToUser',
      'shutdown',
      'fsync',
      'fsyncUnlock',
      'setParameter',
      'setFeatureCompatibilityVersion',
      'replSetReconfig',
      'replSetStepDown',
      'addShard',
      'removeShard',
      'logRotate',
      'killAllSessions',
      'killOp',
    ]) {
      expect(allowed(cmd(name, {}, 'admin')), name).toBe(false)
    }
  })

  it('refuses privilege-bearing and low-level DDL commands (review I1)', () => {
    // applyOps can write to admin.system.users directly, sidestepping createUser: it must be admin-only.
    expect(
      allowed({ name: 'applyOps', db: 'admin', body: { applyOps: [{ op: 'i', ns: 'admin.system.users' }] } }),
    ).toBe(false)
    for (const name of ['applyOps', 'reIndex', 'cloneCollectionAsCapped', 'godinsert']) {
      expect(allowed(cmd(name, {}, 'shop')), name).toBe(false)
    }
  })

  it('refuses credential collections and writes to system databases', () => {
    expect(allowed({ name: 'find', db: 'admin', body: { find: 'system.users' } })).toBe(false)
    expect(allowed({ name: 'find', db: 'admin', body: { find: 'system.keys' } })).toBe(false)
    expect(allowed({ name: 'insert', db: 'admin', body: { insert: 'x' } })).toBe(false)
    expect(allowed({ name: 'dropDatabase', db: 'config', body: { dropDatabase: 1 } })).toBe(false)
  })

  // Data review 2026-10-13 (M6): the local database named whole from another one, and the stages
  // that read other users' queries or the whole catalog.
  it("refuses the local database named whole, and the stages that read others' queries", () => {
    expect(allowed({ name: 'dataSize', db: 'shop', body: { dataSize: 'local.oplog.rs' } })).toBe(false)
    expect(allowed({ name: 'dataSize', db: 'shop', body: { dataSize: 'shop.orders' } })).toBe(true)
    for (const stage of [
      '$listSampledQueries',
      '$queryStats',
      '$listCatalog',
      '$querySettings',
      '$listClusterCatalog',
    ]) {
      const aggregate = {
        name: 'aggregate',
        db: 'admin',
        body: { aggregate: 1, pipeline: [{ [stage]: {} }] },
      }
      expect(allowed(aggregate), stage).toBe(false)
      expect(commandPolicy({ readOnly: false, admin: true })(aggregate).allow, stage).toBe(true)
      const nested = {
        name: 'aggregate',
        db: 'shop',
        body: { aggregate: 'orders', pipeline: [{ $unionWith: { coll: 'x', pipeline: [{ [stage]: {} }] } }] },
      }
      expect(allowed(nested), stage).toBe(false)
    }
  })

  // Round 2 (Minor 8): a pipeline nested past what is looked at is refused, not let through unread.
  it('refuses a pipeline nested deeper than it reads', () => {
    let pipeline: unknown[] = [{ $currentOp: {} }]
    for (let i = 0; i < 25; i++) pipeline = [{ $facet: { a: pipeline } }]
    expect(allowed({ name: 'aggregate', db: 'shop', body: { aggregate: 'orders', pipeline } })).toBe(false)
    let fine: unknown[] = [{ $match: {} }]
    for (let i = 0; i < 5; i++) fine = [{ $facet: { a: fine } }]
    expect(allowed({ name: 'aggregate', db: 'shop', body: { aggregate: 'orders', pipeline: fine } })).toBe(
      true,
    )
  })

  it('allows ordinary reads and writes for a non-admin editor', () => {
    expect(allowed({ name: 'find', db: 'shop', body: { find: 'orders' } })).toBe(true)
    expect(allowed({ name: 'insert', db: 'shop', body: { insert: 'orders' } })).toBe(true)
    expect(allowed({ name: 'find', db: 'shop', body: { find: 'system.views' } })).toBe(true)
  })
})

describe('admin, read-write session allows everything listed', () => {
  const check = commandPolicy({ readOnly: false, admin: true })
  it('lets an admin run cluster commands and writes', () => {
    expect(check(cmd('createUser', {}, 'admin')).allow).toBe(true)
    expect(check({ name: 'insert', db: 'admin', body: { insert: 'x' } }).allow).toBe(true)
    expect(check(cmd('shutdown', {}, 'admin')).allow).toBe(true)
  })
})

describe('commandName', () => {
  it('reads the first non-$ field', () => {
    expect(commandName({ $db: 'x', find: 'c', filter: {} })).toBe(
      '$db' === Object.keys({ $db: 1, find: 1 })[0] ? 'find' : 'find',
    )
    expect(commandName({ aggregate: 'c', pipeline: [], $db: 'x' })).toBe('aggregate')
  })
})

describe('the completer sample query and the policy (phase 3a-2 A7)', () => {
  const check = commandPolicy({ readOnly: true, admin: false })
  const sample = (db: string, coll: string): Command => ({
    name: 'aggregate',
    db,
    body: { aggregate: coll, pipeline: [{ $sample: { size: 10 } }] },
  })

  it('lets a read-only user sample an ordinary collection for field names', () => {
    expect(check(sample('shop', 'orders')).allow).toBe(true)
  })

  it('does not let a non-admin sample the credential collections', () => {
    expect(check(sample('admin', 'system.users')).allow).toBe(false)
  })
})
