import { describe, expect, it } from 'vitest'
import { BSON } from 'bson'
import { commandPolicy, type Command } from '../src/shell/proxy/policy'
import { commandWithSequences, encodeOpMsg, parseOpMsg } from '../src/shell/proxy/wire'

/**
 * Security review 2026-10-16 of the shell fixes: what reached the policy other than as MongoDB reads
 * it — a command shaped like a DBRef (I-5) — and the internal arguments that let a command pass for
 * another client's (I-2).
 */
const nonAdmin = commandPolicy({ readOnly: false, admin: false })
const admin = commandPolicy({ readOnly: false, admin: true })

/** A command as the proxy sees it: encoded on the wire, then parsed. */
function onTheWire(command: Record<string, unknown>, sequences: Record<string, unknown[]> = {}): Command {
  const msg = parseOpMsg(
    encodeOpMsg({
      flags: 0,
      command,
      sequences: Object.entries(sequences).map(([identifier, docs]) => ({
        identifier,
        documents: docs.map((d) => Buffer.from(BSON.serialize(d as Record<string, unknown>))),
      })),
    }),
  )
  return { name: msg.name, db: String(msg.command.$db ?? 'admin'), body: commandWithSequences(msg) }
}

describe('a command shaped like a DBRef (I-5)', () => {
  it('reaches the policy as MongoDB reads it, its database included', () => {
    const cmd = onTheWire({ dbHash: 1, $ref: 'x', $id: 1, $db: 'local' })
    expect(cmd.db).toBe('local')
    expect(Object.getPrototypeOf(cmd.body)).toBe(Object.prototype)
    expect(cmd.body.dbHash).toBe(1)
    expect(nonAdmin(cmd).allow).toBe(false)
  })

  it('cannot hide credential collections, the local database or server JavaScript', () => {
    for (const body of [
      { dbHash: 1, collections: ['system.users'], $ref: 'x', $id: 1, $db: 'admin' },
      { validate: 'oplog.rs', full: true, $ref: 'x', $id: 1, $db: 'local' },
    ])
      expect(nonAdmin(onTheWire(body)).allow, JSON.stringify(body)).toBe(false)
    const applyOps = onTheWire({
      applyOps: [{ op: 'n', ns: '', o: {} }],
      preCondition: [{ ns: 'shop.c', q: { $ref: 'a', $id: 1, x: { $or: [{ $where: 'true' }] } }, res: {} }],
      $db: 'admin',
    })
    const verdict = admin(applyOps)
    expect(verdict.allow).toBe(false)
  })

  it('looks inside DBRef-shaped documents of a kind-1 sequence', () => {
    const cmd = onTheWire(
      { update: 'c', $db: 'shop' },
      { updates: [{ q: { $ref: 'a', $id: 1, x: { $or: [{ $where: 'true' }] } }, u: { $set: { a: 1 } } }] },
    )
    expect(admin(cmd).allow).toBe(false)
  })

  it('keeps a real DBRef in a document an ordinary value', () => {
    const cmd = onTheWire({ insert: 'c', $db: 'shop' }, { documents: [{ owner: { $ref: 'users', $id: 7 } }] })
    expect(nonAdmin(cmd).allow).toBe(true)
  })
})

describe('internal command arguments (I-2)', () => {
  const client = { application: { name: 'x' }, driver: { name: 'x', version: '1' }, os: { type: 'x' } }

  it('refuses $client and the other internal arguments, for admins too', () => {
    for (const extra of [
      { $client: client },
      { $audit: {} },
      { $configServerState: {} },
      { $configTime: 1 },
      { $topologyTime: 1 },
      { $impersonatedUser: { user: 'root', db: 'admin' } },
      { $impersonatedRoles: [] },
      { $tenant: 1 },
      { $queryOptions: {} },
      { mayBypassWriteBlocking: true },
      { $eval: 'function () { return 1 }' },
    ]) {
      for (const policy of [admin, nonAdmin]) {
        const verdict = policy(onTheWire({ find: 'c', filter: {}, ...extra, $db: 'shop' }))
        expect(verdict.allow, JSON.stringify(extra)).toBe(false)
      }
      // Inside an explained command too.
      expect(admin(onTheWire({ explain: { find: 'c', ...extra }, $db: 'shop' })).allow).toBe(false)
    }
  })

  it('lets through what the driver itself sends', () => {
    const cmd = onTheWire({
      find: 'c',
      filter: {},
      lsid: { id: new BSON.UUID() },
      txnNumber: 1,
      $clusterTime: { clusterTime: new BSON.Timestamp({ t: 1, i: 1 }), signature: {} },
      $readPreference: { mode: 'secondaryPreferred' },
      readConcern: { level: 'local' },
      maxTimeMS: 1000,
      comment: 'x',
      apiVersion: '1',
      $db: 'shop',
    })
    expect(nonAdmin(cmd).allow).toBe(true)
  })
})
