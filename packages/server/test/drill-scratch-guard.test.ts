import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { commandPolicy, type Command } from '../src/shell/proxy/policy'
import { isDrillScratch, namesDrillScratch } from '../src/connections/access'
import { toWatchEvent } from '../src/changestreams/event'
import { assertRestoreMapping } from '../src/backup/restore-plan'
import { assertNoScratchRefs } from '../src/routes/data/database-access'

/**
 * W4 review C1 (defence in depth): a restore drill's scratch database (mm_drill_<hex>) holds a
 * backup's documents for as long as the drill runs. Besides the rules it is given, no one opens it
 * through the app — connection admins included: not in the shell, whatever names it.
 */
const admin = commandPolicy({ readOnly: false, admin: true })
const run = (body: Record<string, unknown>, db = 'shop'): Command => ({
  name: Object.keys(body)[0]!,
  db,
  body,
})
const scratch = 'mm_drill_0123456789ab'

describe('a drill’s scratch database in the shell', () => {
  it.each([
    ['a command run in it', run({ find: 'shop.users' }, scratch)],
    ['a database named in another case', run({ find: 'x' }, 'MM_DRILL_0123456789AB')],
    [
      'a $lookup from it',
      run({ aggregate: 'a', pipeline: [{ $lookup: { from: { db: scratch, coll: 'x' }, as: 'y' } }] }),
    ],
    ['a $unionWith of it', run({ aggregate: 'a', pipeline: [{ $unionWith: { db: scratch, coll: 'x' } }] })],
    ['a whole namespace', run({ dataSize: `${scratch}.x` })],
    ['a rename into it', run({ renameCollection: 'shop.a', to: `${scratch}.a` }, 'admin')],
    // W4 re-review (minor): writes into it too.
    ['an $out into it', run({ aggregate: 'a', pipeline: [{ $out: { db: scratch, coll: 'x' } }] })],
    [
      'a $merge into it',
      run({ aggregate: 'a', pipeline: [{ $merge: { into: { db: scratch, coll: 'x' } } }] }),
    ],
    [
      'a mapReduce into it',
      run({ mapReduce: 'a', map: 'f', reduce: 'g', out: { replace: 'x', db: scratch } }),
    ],
    ['an applyOps on it', run({ applyOps: [{ op: 'i', ns: `${scratch}.x`, o: { _id: 1 } }] }, 'admin')],
  ])('refuses %s, for an admin too', (_what, cmd) => {
    const r = admin(cmd)
    expect(r.allow).toBe(false)
  })

  it('refuses a mapReduce into it where server JavaScript is allowed', () => {
    const js = commandPolicy({ readOnly: false, admin: true, allowServerJs: true })
    const cmd = run({ mapReduce: 'a', map: 'f', reduce: 'g', out: { replace: 'x', db: scratch } })
    expect(js(cmd).allow).toBe(false)
    expect(js(run({ mapReduce: 'a', map: 'f', reduce: 'g', out: { replace: 'x', db: 'shop2' } })).allow).toBe(
      true,
    )
  })

  it('leaves other databases alone', () => {
    expect(admin(run({ find: 'users' })).allow).toBe(true)
    expect(admin(run({ find: 'users' }, 'mm_drilling')).allow).toBe(true)
    expect(isDrillScratch('mm_drill_')).toBe(true)
    expect(isDrillScratch('shop')).toBe(false)
  })
})

describe('a drill’s scratch database in a deployment or database feed', () => {
  it('shows none of its changes, to an admin either', () => {
    const insert = {
      operationType: 'insert',
      ns: { db: scratch, coll: 'shop.users' },
      documentKey: { _id: 1 },
      fullDocument: { _id: 1, name: 'Ada' },
    }
    expect(toWatchEvent(insert, { seq: 1, masker: null, admin: true })).toBeNull()
    const rename = {
      ...insert,
      operationType: 'rename',
      ns: { db: 'shop', coll: 'a' },
      to: { db: scratch, coll: 'a' },
    }
    expect(toWatchEvent(rename, { seq: 1, masker: null, admin: true })).toBeNull()
    expect(
      toWatchEvent({ ...insert, ns: { db: 'shop', coll: 'users' } }, { seq: 1, masker: null, admin: true }),
    ).not.toBeNull()
  })
})

// W4 re-review C1: what a request names, wherever the request's own structure puts it.
describe('a drill’s scratch database named in a request', () => {
  it('is found under a source, a target, a mapping or a scope, never in a user’s documents', () => {
    expect(namesDrillScratch({ source: { db: scratch, coll: 'x' }, target: { db: 'b' } })).toBe(true)
    expect(namesDrillScratch({ target: { connectionId: 'c', db: scratch } })).toBe(true)
    expect(namesDrillScratch({ mapping: [{ from: { db: 'a' }, to: { db: scratch } }] })).toBe(true)
    expect(namesDrillScratch({ scope: { kind: 'database', db: 'MM_DRILL_X' } })).toBe(true)
    expect(namesDrillScratch({ db: scratch })).toBe(true)
    expect(namesDrillScratch({ ns: `${scratch}.users` })).toBe(true)
    // A document or a query holding the words is data, not a name.
    expect(namesDrillScratch({ documents: [{ db: scratch }], filter: { db: scratch } })).toBe(false)
    expect(namesDrillScratch({ source: { db: 'shop' }, target: { db: 'mm_drilling' } })).toBe(false)
    expect(namesDrillScratch(null)).toBe(false)
  })
})

// W4 re-review 2 (I2): the scan reads a request's own structure — never a buffer's bytes, a stream's
// internals, or more than a bounded number of entries.
describe('the scan of a request', () => {
  it('passes a large buffer and a stream over at once', () => {
    const started = performance.now()
    expect(namesDrillScratch(Buffer.alloc(30 * 1024 * 1024))).toBe(false)
    expect(namesDrillScratch({ body: Buffer.alloc(30 * 1024 * 1024), db: 'shop' })).toBe(false)
    expect(namesDrillScratch(new PassThrough())).toBe(false)
    expect(namesDrillScratch({ upload: new PassThrough(), target: { db: 'shop' } })).toBe(false)
    expect(performance.now() - started).toBeLessThan(200)
  })

  // W4 final review (minor): past its bound the scan refuses the request (fails closed); the bound is
  // above the largest body the server takes (1 MiB: about 100,000 entries).
  it('refuses a request past a bounded number of entries, and reads the largest valid one whole', () => {
    expect(namesDrillScratch({ a: 1, target: { db: scratch } })).toBe(true)
    // A padded request (2,000 mappings and more) is read to its end.
    const padded = Array.from({ length: 100_000 }, () => ({ to: { db: 'x' } }))
    expect(namesDrillScratch({ mapping: [...padded.slice(0, 12_000), { to: { db: scratch } }] })).toBe(true)
    const wide = Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`k${i}`, { x: i }]))
    const started = performance.now()
    let reason: unknown
    try {
      namesDrillScratch(wide)
    } catch (e) {
      reason = (e as { details?: { reason?: string } }).details?.reason
    }
    expect(reason).toBe('too_complex')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

// W4 final review (minor): the restore plan and MongoDB's users and roles check on their own.
describe('a drill’s scratch database in a restore or a role', () => {
  const refused = (fn: () => void) => {
    try {
      fn()
      return false
    } catch (e) {
      return (e as { details?: { reason?: string } }).details?.reason === 'drill_scratch'
    }
  }
  it('is refused as a restore’s target or source', () => {
    const m = (from: string, to: string) => [{ from: { db: from, coll: 'a' }, to: { db: to, coll: 'a' } }]
    expect(refused(() => assertRestoreMapping(m('shop', scratch)))).toBe(true)
    expect(refused(() => assertRestoreMapping(m(scratch, 'shop')))).toBe(true)
    expect(refused(() => assertRestoreMapping(m('shop', 'shop2')))).toBe(false)
  })
  it('is refused in a user’s or a role’s grants', () => {
    expect(refused(() => assertNoScratchRefs({ roles: [{ role: 'read', db: scratch }] }))).toBe(true)
    expect(refused(() => assertNoScratchRefs({ db: scratch }))).toBe(true)
    expect(
      refused(() =>
        assertNoScratchRefs({
          privileges: [{ resource: { db: scratch, collection: '' }, actions: ['find'] }],
        }),
      ),
    ).toBe(true)
    expect(refused(() => assertNoScratchRefs({ roles: [{ role: 'read', db: 'shop' }] }))).toBe(false)
  })
})
