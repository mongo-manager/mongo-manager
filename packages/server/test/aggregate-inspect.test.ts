import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { inspectPipeline } from '../src/aggregation/inspect'
import { AppError } from '../src/errors'

/** Phase 2a spec §3.1: every pipeline is inspected before MongoDB sees it. */
const request = (over: { allowServerJs?: boolean; role?: 'admin' | 'editor' | 'viewer' } = {}) =>
  ({
    server: { ctx: { config: { allowServerJs: over.allowServerJs ?? false } } },
    connectionRole: over.role ?? 'editor',
  }) as unknown as FastifyRequest

const refusal = (stages: unknown[], over?: Parameters<typeof request>[0]) => {
  try {
    inspectPipeline(request(over), stages as Record<string, unknown>[], 'd')
  } catch (e) {
    if (e instanceof AppError) return [e.statusCode, e.message] as const
    throw e
  }
  return null
}

describe('inspectPipeline: shape', () => {
  it('refuses a stage that is not one $ operator', () => {
    expect(refusal([{}])?.[0]).toBe(400)
    expect(refusal([{ $match: {}, $limit: 1 }])?.[0]).toBe(400)
    expect(refusal([{ match: {} }])?.[0]).toBe(400)
    expect(refusal([[{ $match: {} }]])?.[0]).toBe(400)
  })

  it('refuses $out or $merge anywhere but last', () => {
    expect(refusal([{ $out: 'c' }, { $match: {} }])).toEqual([400, expect.stringContaining('$out')])
    expect(refusal([{ $merge: 'c' }, { $limit: 1 }])?.[0]).toBe(400)
  })

  it('refuses stages that are not collection reads, naming them', () => {
    for (const op of ['$changeStream', '$currentOp', '$listSessions', '$listLocalSessions'])
      expect(refusal([{ [op]: {} }])).toEqual([400, expect.stringContaining(op)])
  })

  // Data review 2026-10-13 (M6), as the shell: other users' queries and the whole catalog.
  it('refuses the stages that read other users’ queries or the catalog, but to a connection admin', () => {
    for (const stage of [
      '$planCacheStats',
      '$listSampledQueries',
      '$queryStats',
      '$listCatalog',
      '$querySettings',
      '$listClusterCatalog',
    ]) {
      expect(refusal([{ [stage]: {} }])?.[0], stage).toBe(403)
      expect(refusal([{ $unionWith: { coll: 'x', pipeline: [{ [stage]: {} }] } }])?.[0], stage).toBe(403)
      expect(refusal([{ [stage]: {} }], { role: 'admin' }), stage).toBeNull()
    }
  })

  it('refuses server-side JavaScript at any depth, unless it is allowed', () => {
    const nested = [
      { $facet: { a: [{ $project: { x: { $function: { body: 'f', args: [], lang: 'js' } } } }] } },
    ]
    expect(refusal(nested)?.[0]).toBe(400)
    expect(refusal(nested, { allowServerJs: true })).toBeNull()
    // Security review 2026-10-16 (I-1): MongoDB's internal JavaScript operators too.
    const emit = [{ $project: { e: { $_internalJsEmit: { eval: 'function () {}', this: '$$ROOT' } } } }]
    const reduce = [
      { $group: { _id: null, r: { $_internalJsReduce: { data: {}, eval: 'function () {}' } } } },
    ]
    expect(refusal(emit)?.[0]).toBe(400)
    expect(refusal(reduce)?.[0]).toBe(400)
  })

  it('refuses a $out or $merge target it cannot read', () => {
    expect(refusal([{ $out: 5 }])?.[0]).toBe(400)
    expect(refusal([{ $merge: { into: {} } }])?.[0]).toBe(400)
  })
})

describe('inspectPipeline: namespaces the pipeline reads', () => {
  const credentials = [
    [{ $lookup: { from: 'system.users', localField: 'a', foreignField: 'b', as: 'c' } }],
    [{ $facet: { x: [{ $lookup: { from: 'system.users', as: 'c', pipeline: [] } }] } }],
    [{ $lookup: { from: 'ok', as: 'c', pipeline: [{ $unionWith: 'system.keys' }] } }],
    [
      {
        $unionWith: { coll: 'ok', pipeline: [{ $lookup: { from: 'system.roles', as: 'r', pipeline: [] } }] },
      },
    ],
    [
      {
        $graphLookup: {
          from: 'system.users',
          startWith: '$a',
          connectFromField: 'a',
          connectToField: 'b',
          as: 'g',
        },
      },
    ],
    [{ $unionWith: 'system.users' }],
    [{ $unionWith: { coll: 'system.backup_users' } }],
    [{ $lookup: { from: { db: 'admin', coll: 'system.users' }, as: 'c', pipeline: [] } }],
    [{ $lookup: { from: 'ok', as: 'c', pipeline: [{ $facet: { y: [{ $unionWith: 'system.users' }] } }] } }],
  ]

  it('refuses credential collections reached through $lookup, $graphLookup or $unionWith, at any depth', () => {
    for (const stages of credentials)
      expect(refusal(stages), JSON.stringify(stages)).toEqual([403, expect.any(String)])
  })

  it('lets a connection admin read them, as it may read them directly', () => {
    for (const stages of credentials) expect(refusal(stages, { role: 'admin' })).toBeNull()
  })

  it('reads other system collections as the direct routes do: allowed', () => {
    const stages = [
      {
        $graphLookup: {
          from: 'system.profile',
          startWith: '$a',
          connectFromField: 'a',
          connectToField: 'b',
          as: 'g',
        },
      },
    ]
    expect(refusal(stages)).toBeNull()
  })

  it('inspects a $lookup without from (a $documents sub-pipeline), and refuses a from it cannot read (Review Focus 2)', () => {
    expect(refusal([{ $lookup: { as: 'c', pipeline: [{ $documents: [{ a: 1 }] }] } }])).toBeNull()
    expect(
      refusal([
        { $lookup: { as: 'c', pipeline: [{ $documents: [] }, { $unionWith: 'system.users' }] } },
      ])?.[0],
    ).toBe(403)
    expect(refusal([{ $lookup: { from: 5, as: 'c', localField: 'a', foreignField: 'b' } }])?.[0]).toBe(400)
    expect(refusal([{ $lookup: { from: { coll: 5 }, as: 'c', pipeline: [] } }])?.[0]).toBe(400)
    expect(refusal([{ $unionWith: 7 }])?.[0]).toBe(400)
    expect(refusal([{ $lookup: 'x' }])?.[0]).toBe(400)
    expect(refusal([{ $lookup: { from: 'ok', as: 'c', pipeline: 'no' } }])?.[0]).toBe(400)
    expect(refusal([{ $facet: { a: 'no' } }])?.[0]).toBe(400)
  })
})

describe('inspectPipeline: writes', () => {
  it('refuses writes into admin, local and config, even for a connection admin', () => {
    for (const stages of [
      [{ $out: { db: 'admin', coll: 'x' } }],
      [{ $merge: { into: { db: 'config', coll: 'x' } } }],
      [{ $merge: { into: { db: 'local', coll: 'x' } } }],
    ]) {
      expect(refusal(stages)?.[0]).toBe(403)
      expect(refusal(stages, { role: 'admin' })?.[0]).toBe(403)
    }
  })

  it('refuses writing a system collection unless the connection admin asks', () => {
    expect(refusal([{ $out: 'system.js' }])?.[0]).toBe(403)
    expect(refusal([{ $out: 'system.js' }], { role: 'admin' })).toBeNull()
  })

  it('answers the write target, or none', () => {
    expect(inspectPipeline(request(), [{ $match: { a: 1 } }], 'd')).toEqual({ write: null })
    expect(inspectPipeline(request(), [{ $match: {} }, { $out: 'copy' }], 'd')).toEqual({
      write: { db: 'd', coll: 'copy', stage: '$out' },
    })
  })
})
