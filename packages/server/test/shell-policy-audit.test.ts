// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { BSON } from 'bson'
import { commandPolicy, type Command } from '../src/shell/proxy/policy'
import { relay } from '../src/shell/proxy/proxy'
import { EventEmitter } from 'node:events'
import {
  FrameSplitter,
  OP_MSG,
  OP_QUERY,
  encodeFrame,
  legacyHello,
  parseOpMsg,
  MAX_FRAME_BYTES,
} from '../src/shell/proxy/wire'

/**
 * Security review 2026-10-13 (H1, H2, M5, M6, M7): what the shell's proxy let a non-admin do — read
 * credential collections through a pipeline or usersInfo, read the oplog, write to another
 * database or to system collections, run cluster commands the deny-list missed — and how a crafted
 * message could be judged as another command than the one MongoDB runs.
 */
const nonAdmin = commandPolicy({ readOnly: false, admin: false })
const admin = commandPolicy({ readOnly: false, admin: true })
const run = (body: Record<string, unknown>, db = 'shop'): Command => ({
  name: Object.keys(body)[0]!,
  db,
  body,
})
const refused = (c: Command) => !nonAdmin(c).allow
/** mapReduce always runs server JavaScript: its namespace rules are judged with that allowed. */
const nonAdminJs = commandPolicy({ readOnly: false, admin: false, allowServerJs: true })
const refusedJs = (c: Command) => !nonAdminJs(c).allow

describe('credential collections through pipelines and user commands (H1)', () => {
  it.each([
    [{ $lookup: { from: 'system.users', localField: 'a', foreignField: 'b', as: 'c' } }],
    [{ $lookup: { from: { db: 'admin', coll: 'system.users' }, pipeline: [], as: 'c' } }],
    [{ $unionWith: 'system.keys' }],
    [{ $unionWith: { coll: 'system.users', pipeline: [] } }],
    [
      {
        $graphLookup: {
          from: 'system.users',
          startWith: '$a',
          connectFromField: 'a',
          connectToField: 'b',
          as: 'c',
        },
      },
    ],
    [{ $facet: { x: [{ $lookup: { from: 'system.users', pipeline: [], as: 'c' } }] } }],
    [{ $lookup: { from: 'orders', pipeline: [{ $unionWith: { coll: 'system.users' } }], as: 'c' } }],
  ])('refuses %j', (stage) => {
    expect(refused(run({ aggregate: 'orders', pipeline: [stage], cursor: {} }, 'admin'))).toBe(true)
    expect(admin(run({ aggregate: 'orders', pipeline: [stage], cursor: {} }, 'admin')).allow).toBe(true)
  })

  it('refuses usersInfo and rolesInfo that show credentials or privileges', () => {
    expect(refused(run({ usersInfo: 1, showCredentials: true }, 'admin'))).toBe(true)
    expect(refused(run({ usersInfo: 1, showPrivileges: true }, 'admin'))).toBe(true)
    expect(refused(run({ rolesInfo: 1, showPrivileges: true }, 'admin'))).toBe(true)
    expect(refused(run({ usersInfo: 1 }, 'admin'))).toBe(false)
    expect(refused(run({ countDocuments: 'x' }))).toBe(false)
    expect(refused(run({ count: 'system.users' }, 'admin'))).toBe(true)
    expect(refused(run({ distinct: 'system.users', key: 'user' }, 'admin'))).toBe(true)
  })
})

describe('the local database (M1)', () => {
  it('refuses a non-admin any command there: the oplog holds every write', () => {
    expect(refused(run({ find: 'oplog.rs', filter: { ns: 'admin.system.users' } }, 'local'))).toBe(true)
    expect(refused(run({ aggregate: 'oplog.rs', pipeline: [], cursor: {} }, 'local'))).toBe(true)
    expect(refused(run({ listCollections: 1 }, 'local'))).toBe(true)
    expect(admin(run({ find: 'oplog.rs' }, 'local')).allow).toBe(true)
  })
})

describe('writes elsewhere, to system collections, and profiling (M5)', () => {
  it.each([
    [{ aggregate: 'orders', pipeline: [{ $merge: { into: { db: 'admin', coll: 'x' } } }], cursor: {} }],
    [{ aggregate: 'orders', pipeline: [{ $out: { db: 'config', coll: 'x' } }], cursor: {} }],
    [{ aggregate: 'orders', pipeline: [{ $out: { db: 'local', coll: 'x' } }], cursor: {} }],
    [{ mapReduce: 'orders', map: 'f', reduce: 'g', out: { replace: 'x', db: 'admin' } }],
    [{ insert: 'system.js', documents: [] }],
    [{ drop: 'system.profile' }],
    [{ update: 'system.views', updates: [] }],
    [{ profile: 2 }],
    [{ profile: 0, slowms: 1 }],
    [{ aggregate: 'orders', pipeline: [{ $merge: { into: 'system.js' } }], cursor: {} }],
  ])('refuses %j', (body) => {
    expect(refusedJs(run(body))).toBe(true)
  })

  it('still lets an editor work in their own collections and read the profiling level', () => {
    expect(
      refused(run({ aggregate: 'orders', pipeline: [{ $merge: { into: 'summary' } }], cursor: {} })),
    ).toBe(false)
    expect(refused(run({ aggregate: 'orders', pipeline: [{ $out: 'summary' }], cursor: {} }))).toBe(false)
    expect(refused(run({ insert: 'orders', documents: [] }))).toBe(false)
    expect(refused(run({ profile: -1 }))).toBe(false)
  })
})

describe('cluster and session commands the deny-list missed (M6)', () => {
  it.each([
    'replSetFreeze',
    'replSetMaintenance',
    'replSetSyncFrom',
    'setClusterParameter',
    'setUserWriteBlockMode',
    'killSessions',
    'getLog',
    'getCmdLineOpts',
    'configureFailPoint',
    'saslStart',
    'saslContinue',
    'authenticate',
    'logout',
    'moveChunk',
    'splitChunk',
    'mergeChunks',
    'movePrimary',
    'balancerStart',
    'balancerStop',
    'reshardCollection',
    'refineCollectionShardKey',
    'currentOp',
  ])('refuses %s', (name) => {
    expect(refused(run({ [name]: 1 }, 'admin'))).toBe(true)
  })

  it('refuses the stages that list other users’ operations and sessions', () => {
    for (const stage of [{ $currentOp: {} }, { $listSessions: {} }, { $listLocalSessions: {} }])
      expect(refused(run({ aggregate: 1, pipeline: [stage], cursor: {} }, 'admin'))).toBe(true)
  })
})

describe('a command judged as the one MongoDB runs (H2)', () => {
  it('refuses a command with a number-like top-level field, also inside explain', () => {
    expect(refused(run({ createUser: 'x', roles: ['root'], '0': 1 }, 'admin'))).toBe(true)
    expect(refused(run({ explain: { find: 'system.users', '0': 1 } }, 'admin'))).toBe(true)
  })

  /** A BSON document whose fields are written in this order, values all int32 1 or strings. */
  function raw(fields: Array<[string, string | number]>): Buffer {
    const parts: Buffer[] = []
    for (const [key, value] of fields) {
      const name = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0])])
      if (typeof value === 'number') {
        const v = Buffer.alloc(4)
        v.writeInt32LE(value)
        parts.push(Buffer.from([0x10]), name, v)
      } else {
        const s = Buffer.from(`${value}\0`, 'utf8')
        const len = Buffer.alloc(4)
        len.writeInt32LE(s.length)
        parts.push(Buffer.from([0x02]), name, len, s)
      }
    }
    const body = Buffer.concat([...parts, Buffer.from([0])])
    const size = Buffer.alloc(4)
    size.writeInt32LE(body.length + 4)
    return Buffer.concat([size, body])
  }
  const opMsg = (doc: Buffer) => Buffer.concat([Buffer.alloc(4), Buffer.from([0]), doc])

  it('names the command by the first field on the wire, never by the order JavaScript gives', () => {
    const msg = parseOpMsg(
      opMsg(
        raw([
          ['createUser', 'x'],
          ['0', 1],
          ['$db', 'admin'],
        ]),
      ),
    )
    expect(msg.name).toBe('createUser')
  })

  it('refuses a document with a field twice, at any depth', () => {
    expect(() =>
      parseOpMsg(
        opMsg(
          raw([
            ['find', 'system.users'],
            ['find', 'a'],
            ['$db', 'admin'],
          ]),
        ),
      ),
    ).toThrow()
    const nested = BSON.serialize({ aggregate: 'o', pipeline: [{ $lookup: { from: 'x' } }], $db: 'shop' })
    // Rewrite the inner "from" into a second "from" field by hand: a duplicate deep inside.
    const text = Buffer.from(nested)
    expect(() => parseOpMsg(opMsg(text))).not.toThrow()
    const dup = Buffer.from(BSON.serialize({ find: 'a', filter: { a: 1, b: 2 }, $db: 'shop' }))
    const at = dup.indexOf(Buffer.from('b\0'))
    dup[at] = 'a'.charCodeAt(0)
    expect(() => parseOpMsg(opMsg(Buffer.from(dup)))).toThrow()
  })

  it('takes a legacy OP_QUERY only for the opening hello', () => {
    const query = (collection: string, doc: Record<string, unknown>) => {
      const name = Buffer.from(`${collection}\0`)
      return {
        requestID: 1,
        responseTo: 0,
        opCode: OP_QUERY,
        body: Buffer.concat([Buffer.alloc(4), name, Buffer.alloc(8), Buffer.from(BSON.serialize(doc))]),
      }
    }
    expect(() => legacyHello(query('admin.$cmd', { isMaster: 1 }))).not.toThrow()
    expect(() => legacyHello(query('admin.$cmd', { hello: 1, client: { a: 1 } }))).not.toThrow()
    expect(() => legacyHello(query('admin.$cmd', { createUser: 'x', pwd: 'y', roles: ['root'] }))).toThrow()
    expect(() => legacyHello(query('admin.system.users', { isMaster: 1 }))).toThrow()
    expect(() => legacyHello(query('admin.$cmd', { createUser: 'x', isMaster: 1 }))).toThrow()
  })
})

describe('frames reassembled in linear time (M7)', () => {
  it('splits a frame near the size limit, arriving in small chunks, quickly', () => {
    const size = MAX_FRAME_BYTES - 1024
    const frame = encodeFrame({ requestID: 1, responseTo: 0, opCode: OP_MSG, body: Buffer.alloc(size - 16) })
    const splitter = new FrameSplitter()
    const started = Date.now()
    let out: unknown[] = []
    for (let at = 0; at < frame.length; at += 16 * 1024)
      out = splitter.push(frame.subarray(at, at + 16 * 1024))
    expect(out).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('a side that cannot keep up holds the other back (M7)', () => {
  it('pauses the sender while the receiver is full, and resumes it once drained', () => {
    const from = {
      paused: 0,
      resumed: 0,
      pause() {
        this.paused++
      },
      resume() {
        this.resumed++
      },
    }
    const to = Object.assign(new EventEmitter(), {
      full: false,
      write(_: Buffer) {
        return !this.full
      },
    })
    const send = relay(from, to)
    send(Buffer.from('a'))
    expect(from.paused).toBe(0)
    to.full = true
    send(Buffer.from('b'))
    expect(from.paused).toBe(1)
    expect(from.resumed).toBe(0)
    to.emit('drain')
    expect(from.resumed).toBe(1)
  })
})

// Review 2026-10-13 of the policy: what it still let through, and what it closed too widely.
describe('the policy, second look', () => {
  it('refuses a change stream to a non-admin: it tails every write, like the oplog', () => {
    expect(
      refused(
        run(
          { aggregate: 1, pipeline: [{ $changeStream: { allChangesForCluster: true } }], cursor: {} },
          'admin',
        ),
      ),
    ).toBe(true)
    expect(refused(run({ aggregate: 'orders', pipeline: [{ $changeStream: {} }], cursor: {} }))).toBe(true)
  })

  it('refuses mapReduce into a system collection named as a string', () => {
    expect(refusedJs(run({ mapReduce: 'orders', map: 'f', reduce: 'g', out: 'system.js' }))).toBe(true)
    expect(refusedJs(run({ mapReduce: 'orders', map: 'f', reduce: 'g', out: 'totals' }))).toBe(false)
    expect(refusedJs(run({ mapReduce: 'orders', map: 'f', reduce: 'g', out: { inline: 1 } }))).toBe(false)
  })

  it('refuses credential namespaces written whole (db.coll) and in lists', () => {
    expect(refused(run({ dataSize: 'admin.system.users' }, 'admin'))).toBe(true)
    expect(refused(run({ dbHash: 1, collections: ['system.users'] }, 'admin'))).toBe(true)
    expect(refused(run({ dataSize: 'shop.orders' }))).toBe(false)
  })

  it('lets an editor rename within a database of theirs and bulk-write their own collections', () => {
    expect(refused(run({ renameCollection: 'shop.a', to: 'shop.b' }, 'admin'))).toBe(false)
    expect(refused(run({ renameCollection: 'shop.a', to: 'admin.b' }, 'admin'))).toBe(true)
    expect(refused(run({ renameCollection: 'shop.a', to: 'shop.system.js' }, 'admin'))).toBe(true)
    expect(refused(run({ renameCollection: 'admin.system.users', to: 'shop.u' }, 'admin'))).toBe(true)
    const bulk = (ns: string[]) => run({ bulkWrite: 1, ops: [], nsInfo: ns.map((n) => ({ ns: n })) }, 'admin')
    expect(refused(bulk(['shop.orders', 'shop.items']))).toBe(false)
    expect(refused(bulk(['shop.orders', 'admin.system.users']))).toBe(true)
    expect(refused(bulk(['local.x']))).toBe(true)
    expect(refused(bulk(['shop.system.js']))).toBe(true)
    expect(refused(run({ insert: 'x' }, 'admin'))).toBe(true)
  })

  it('splits frames whose header comes in pieces, and several frames in one chunk', () => {
    const one = encodeFrame({
      requestID: 1,
      responseTo: 0,
      opCode: OP_MSG,
      body: Buffer.from([1, 2, 3, 4, 5]),
    })
    const two = encodeFrame({ requestID: 2, responseTo: 0, opCode: OP_MSG, body: Buffer.from([6]) })
    const s = new FrameSplitter()
    expect(s.push(one.subarray(0, 3))).toEqual([])
    expect(s.push(Buffer.alloc(0))).toEqual([])
    expect(s.push(one.subarray(3, 7))).toEqual([])
    expect(s.push(one.subarray(7, 12))).toEqual([])
    const out = s.push(Buffer.concat([one.subarray(12), two, one]))
    expect(out.map((f) => [f.requestID, [...f.body]])).toEqual([
      [1, [1, 2, 3, 4, 5]],
      [2, [6]],
      [1, [1, 2, 3, 4, 5]],
    ])
  })
})

describe('security audit 2026-10-16 (minors): what a non-admin may still read', () => {
  // The profiler records every client's commands with their literal values, as currentOp shows them
  // (which is connection admins' only, like the app's server:operations).
  it.each([
    [{ find: 'system.profile', filter: {} }],
    [{ aggregate: 'system.profile', pipeline: [{ $match: {} }], cursor: {} }],
    [{ count: 'system.profile' }],
    [{ distinct: 'system.profile', key: 'command' }],
    [
      {
        aggregate: 'orders',
        pipeline: [{ $lookup: { from: 'system.profile', pipeline: [], as: 'p' } }],
        cursor: {},
      },
    ],
    [{ aggregate: 'orders', pipeline: [{ $unionWith: 'system.profile' }], cursor: {} }],
    [
      {
        aggregate: 'orders',
        pipeline: [{ $unionWith: { coll: 'system.profile', pipeline: [] } }],
        cursor: {},
      },
    ],
    [
      {
        aggregate: 'orders',
        pipeline: [
          {
            $graphLookup: {
              from: 'system.profile',
              startWith: 1,
              connectFromField: 'a',
              connectToField: 'b',
              as: 'p',
            },
          },
        ],
        cursor: {},
      },
    ],
    [{ dataSize: 'shop.system.profile' }],
    [{ explain: { find: 'system.profile', filter: {} } }],
  ])('refuses reading the profiler: %j', (body) => {
    expect(refused(run(body))).toBe(true)
    expect(admin(run(body)).allow).toBe(true)
  })

  it('refuses the MongoDB user’s privileges and the users and roles of every database', () => {
    expect(refused(run({ connectionStatus: 1, showPrivileges: true }))).toBe(true)
    expect(refused(run({ connectionStatus: 1, showPrivileges: 1 }))).toBe(true)
    expect(refused(run({ usersInfo: 1, forAllDBs: true }, 'admin'))).toBe(true)
    expect(refused(run({ usersInfo: { forAllDBs: true } }, 'admin'))).toBe(true)
    expect(refused(run({ rolesInfo: 1, forAllDBs: true }, 'admin'))).toBe(true)
    expect(refused(run({ usersInfo: 1, showAuthenticationRestrictions: true }))).toBe(true)
    expect(refused(run({ rolesInfo: 1, showAuthenticationRestrictions: true }))).toBe(true)
    // What the shell itself and its helpers ask stays open.
    expect(refused(run({ connectionStatus: 1 }))).toBe(false)
    expect(refused(run({ connectionStatus: 1, showPrivileges: false }))).toBe(false)
    expect(refused(run({ usersInfo: { user: 'ada', db: 'shop' } }))).toBe(false)
    for (const body of [
      { connectionStatus: 1, showPrivileges: true },
      { usersInfo: 1, forAllDBs: true },
      { rolesInfo: 1, forAllDBs: true },
    ])
      expect(admin(run(body, 'admin')).allow).toBe(true)
  })

  it.each([
    'setProfilingFilterGlobally',
    'getDiagnosticData',
    'lockInfo',
    'setAuditConfig',
    'logApplicationMessage',
    'clearLog',
    'rotateFTDC',
    'setFreeMonitoring',
    'invalidateUserCache',
    'configureQueryAnalyzer',
    'setQuerySettings',
    'removeQuerySettings',
  ])('refuses %s to a non-admin', (name) => {
    expect(refused(run({ [name]: 1 }, 'admin'))).toBe(true)
    expect(admin(run({ [name]: 1 }, 'admin')).allow).toBe(true)
  })

  it('leaves the server status and host info to editors, as the app’s server:monitor does', () => {
    expect(refused(run({ serverStatus: 1 }, 'admin'))).toBe(false)
    expect(refused(run({ hostInfo: 1 }, 'admin'))).toBe(false)
    expect(refused(run({ buildInfo: 1 }, 'admin'))).toBe(false)
  })
})
