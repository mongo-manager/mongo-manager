import { describe, expect, it } from 'vitest'
import {
  PreviewRequestSchema,
  RunRequestSchema,
  SavedPipelineBodySchema,
  isWritePipeline,
  stageOperator,
  writeTarget,
} from '../src'

describe('stageOperator (phase 2a)', () => {
  it('names the single $ key of a stage, and nothing else', () => {
    expect(stageOperator({ $match: {} })).toBe('$match')
    expect(stageOperator({ $match: {}, $limit: 1 })).toBeNull()
    expect(stageOperator({ match: {} })).toBeNull()
    expect(stageOperator({})).toBeNull()
    expect(stageOperator([{ $match: {} }])).toBeNull()
    expect(stageOperator(null)).toBeNull()
    expect(stageOperator('$match')).toBeNull()
  })
})

describe('writeTarget (phase 2a)', () => {
  it('reads every $out and $merge form, defaulting to the current database', () => {
    expect(writeTarget([{ $match: {} }], 'd')).toBeNull()
    expect(writeTarget([{ $out: 'c' }], 'd')).toEqual({ db: 'd', coll: 'c', stage: '$out' })
    expect(writeTarget([{ $out: { db: 'o', coll: 'c' } }], 'd')).toEqual({
      db: 'o',
      coll: 'c',
      stage: '$out',
    })
    expect(writeTarget([{ $merge: 'c' }], 'd')).toEqual({ db: 'd', coll: 'c', stage: '$merge' })
    expect(writeTarget([{ $merge: { into: 'c' } }], 'd')).toEqual({ db: 'd', coll: 'c', stage: '$merge' })
    expect(writeTarget([{ $merge: { into: { db: 'o', coll: 'c' } } }], 'd')).toEqual({
      db: 'o',
      coll: 'c',
      stage: '$merge',
    })
    expect(writeTarget([{ $merge: { into: { coll: 'c' } } }], 'd')).toEqual({
      db: 'd',
      coll: 'c',
      stage: '$merge',
    })
  })

  it('answers null for a malformed target, which the server then refuses', () => {
    expect(writeTarget([{ $out: 5 }], 'd')).toBeNull()
    expect(writeTarget([{ $merge: { into: {} } }], 'd')).toBeNull()
  })

  it('counts only a write stage in last place as a write pipeline', () => {
    expect(isWritePipeline([{ $match: {} }, { $out: 'c' }])).toBe(true)
    expect(isWritePipeline([{ $out: 'c' }, { $match: {} }])).toBe(false)
    expect(isWritePipeline([])).toBe(false)
  })
})

describe('aggregation request schemas (phase 2a spec §3)', () => {
  it('applies the defaults and caps of the spec', () => {
    expect(PreviewRequestSchema.parse({ stages: [] })).toMatchObject({
      sample: { mode: 'limit', size: 1000 },
      perStage: 20,
      maxTimeMS: 10_000,
      from: 0,
    })
    expect(() =>
      PreviewRequestSchema.parse({ stages: [], sample: { mode: 'limit', size: 100_001 } }),
    ).toThrow()
    expect(() => PreviewRequestSchema.parse({ stages: [], perStage: 51 })).toThrow()
    expect(() => PreviewRequestSchema.parse({ stages: Array(101).fill({ $match: {} }) })).toThrow()
    expect(RunRequestSchema.parse({ stages: [{ $match: {} }] })).toMatchObject({
      limit: 1000,
      allowDiskUse: true,
      maxTimeMS: 60_000,
      batchSize: 100,
    })
    expect(() => RunRequestSchema.parse({ stages: [] })).toThrow()
    expect(() => RunRequestSchema.parse({ stages: [{ $match: {} }], limit: 10_001 })).toThrow()
    expect(() => RunRequestSchema.parse({ stages: [{ $match: {} }], maxTimeMS: 300_001 })).toThrow()
    expect(() =>
      SavedPipelineBodySchema.parse({ name: 'x'.repeat(101), stages: [], shared: false }),
    ).toThrow()
    expect(() => SavedPipelineBodySchema.parse({ name: ' ', stages: [], shared: false })).toThrow()
  })
})
