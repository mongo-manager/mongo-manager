// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { BSON, Code } from 'bson'
import { commandPolicy, type Command } from '../src/shell/proxy/policy'
import { commandWithSequences, encodeOpMsg, parseOpMsg } from '../src/shell/proxy/wire'

/**
 * Security audit 2026-10-16 (Important 1): the shell ignored `allowServerJs`. Every other path refuses
 * $where, $function and $accumulator unless the server allows it (MM_ALLOW_SERVER_JS); the shell
 * proxy's policy now does too, for admins as well — the setting is the server's, not a role's.
 */
const off = commandPolicy({ readOnly: false, admin: true })
const editorOff = commandPolicy({ readOnly: false, admin: false })
const on = commandPolicy({ readOnly: false, admin: true, allowServerJs: true })
const run = (body: Record<string, unknown>, db = 'shop'): Command => ({
  name: Object.keys(body)[0]!,
  db,
  body,
})

const WHERE = { $where: 'sleep(100) || true' }
const FUNCTION = { $expr: { $function: { body: 'function () { return true }', args: [], lang: 'js' } } }
const ACCUMULATOR = {
  $accumulator: {
    init: 'function () { return 0 }',
    accumulate: 'function (s) { return s }',
    accumulateArgs: [],
    merge: 'function (a) { return a }',
    lang: 'js',
  },
}

/** Every way a command can carry server JavaScript, as mongosh or a crafted worker would send it. */
const carriers: Array<[string, Command]> = [
  ['find filter $where', run({ find: 'c', filter: WHERE })],
  ['find filter $where as Code', run({ find: 'c', filter: { $where: new Code('true') } })],
  ['find filter $expr $function', run({ find: 'c', filter: FUNCTION })],
  ['find filter $where under $and', run({ find: 'c', filter: { $and: [{ a: 1 }, WHERE] } })],
  ['aggregate $match $where', run({ aggregate: 'c', pipeline: [{ $match: WHERE }], cursor: {} })],
  [
    'aggregate $group $accumulator',
    run({ aggregate: 'c', pipeline: [{ $group: { _id: null, v: ACCUMULATOR } }], cursor: {} }),
  ],
  [
    'aggregate $function in a $lookup pipeline in a $facet',
    run({
      aggregate: 'c',
      pipeline: [{ $facet: { a: [{ $lookup: { from: 'x', pipeline: [{ $match: FUNCTION }], as: 'y' } }] } }],
      cursor: {},
    }),
  ],
  ['update filter $where', run({ update: 'c', updates: [{ q: WHERE, u: { $set: { a: 1 } } }] })],
  [
    'update pipeline $function',
    run({
      update: 'c',
      updates: [{ q: {}, u: [{ $set: { a: { $function: { body: 'f', args: [], lang: 'js' } } } }] }],
    }),
  ],
  ['delete filter $where', run({ delete: 'c', deletes: [{ q: WHERE, limit: 0 }] })],
  ['findAndModify query $where', run({ findAndModify: 'c', query: WHERE, remove: true })],
  [
    'findAndModify update pipeline $function',
    run({ findAndModify: 'c', query: {}, update: [{ $set: { a: FUNCTION.$expr } }] }),
  ],
  ['count query $where', run({ count: 'c', query: WHERE })],
  ['distinct query $where', run({ distinct: 'c', key: 'a', query: WHERE })],
  [
    'explain of a find with $where',
    run({ explain: { find: 'c', filter: WHERE }, verbosity: 'queryPlanner' }),
  ],
  [
    'explain of an aggregate with $accumulator',
    run({ explain: { aggregate: 'c', pipeline: [{ $group: { _id: 1, v: ACCUMULATOR } }], cursor: {} } }),
  ],
  [
    'mapReduce, whatever its functions',
    run({ mapReduce: 'c', map: new Code('function () {}'), reduce: 'function () {}', out: { inline: 1 } }),
  ],
  [
    'mapReduce in lower case',
    run({ mapreduce: 'c', map: 'function () {}', reduce: 'f', out: { inline: 1 } }),
  ],
  ['group', run({ group: { ns: 'c', key: {}, $reduce: 'function () {}', initial: {} } })],
  ['eval', run({ eval: 'function () { return 1 }' })],
  ['a validator with $where', run({ create: 'c', validator: WHERE })],
  ['collMod validator $expr $function', run({ collMod: 'c', validator: FUNCTION })],
]

describe('server-side JavaScript in the shell (security audit 2026-10-16, Important 1)', () => {
  it.each(carriers)('refuses %s when server JavaScript is off, for an admin and an editor', (_, command) => {
    for (const policy of [off, editorOff]) {
      const verdict = policy(command)
      expect(verdict.allow).toBe(false)
      if (!verdict.allow) {
        expect(verdict.reason).toMatch(/JavaScript on the MongoDB server/)
        // There is no --allow-server-js flag: the setting is MM_ALLOW_SERVER_JS or the config file.
        expect(verdict.reason).toMatch(/MM_ALLOW_SERVER_JS/)
        expect(verdict.reason).not.toMatch(/--allow-server-js/)
        expect(verdict.code).toBe('SERVER_JS')
      }
    }
  })

  it.each(carriers)('lets %s through when the server allows server JavaScript', (_, command) => {
    expect(on(command).allow).toBe(true)
  })

  it('still applies the rest of the policy when server JavaScript is allowed', () => {
    const readOnly = commandPolicy({ readOnly: true, admin: false, allowServerJs: true })
    expect(readOnly(run({ mapReduce: 'c', map: 'f', reduce: 'f', out: 'x' })).allow).toBe(false)
    expect(readOnly(run({ find: 'c', filter: WHERE })).allow).toBe(true)
  })

  it('lets ordinary commands through when server JavaScript is off', () => {
    for (const command of [
      run({ find: 'c', filter: { a: { $gt: 1 }, $expr: { $eq: ['$a', 1] } } }),
      run({ aggregate: 'c', pipeline: [{ $group: { _id: null, n: { $sum: 1 } } }], cursor: {} }),
      run({ insert: 'c', documents: [{ code: new Code('x') }] }),
      run({ update: 'c', updates: [{ q: { a: 1 }, u: { $set: { where: 1 } } }] }),
    ])
      expect(off(command).allow).toBe(true)
  })

  it('finds $where in a kind-1 document sequence a crafted worker moves it into', () => {
    const msg = parseOpMsg(
      encodeOpMsg({
        flags: 0,
        command: { update: 'c', $db: 'shop' },
        sequences: [
          {
            identifier: 'updates',
            documents: [Buffer.from(BSON.serialize({ q: WHERE, u: { $set: { a: 1 } } }))],
          },
        ],
      }),
    )
    const verdict = off({ name: msg.name, db: 'shop', body: commandWithSequences(msg) })
    expect(verdict.allow).toBe(false)
  })

  it('refuses a body nested too deeply to scan (fail closed)', () => {
    let deep: Record<string, unknown> = { a: 1 }
    for (let i = 0; i < 300; i++) deep = { $and: [deep] }
    const verdict = off(run({ find: 'c', filter: deep }))
    expect(verdict.allow).toBe(false)
    // Said as what it is, not as an operator that runs JavaScript.
    if (!verdict.allow) expect(verdict.reason).toMatch(/nested too deeply/)
  })
})
