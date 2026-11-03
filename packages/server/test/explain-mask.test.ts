import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BSON, BSONRegExp, Code, Decimal128, Int32, Long, ObjectId, type Document } from 'mongodb'
import { maskExplain, personalPlan, planRefusal } from '../src/masking/explain'
import { registerKeyVaults } from '../src/connections/access'
import { compileRules } from '../src/masking/match'
import type { GateDeps } from '../src/masking/gate/context'
import { normaliseExplain } from '../src/explain/normalise'

/** Every explain answer captured from MongoDB (6.0 to 8.2, sharded too), and the hand-made ones. */
const ROOT = join(__dirname, 'fixtures', 'explain')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : f.endsWith('.json') ? [p] : []
  })
const FIXTURES = files(ROOT).map((p) => ({
  name: relative(ROOT, p),
  raw: (BSON.EJSON.parse(readFileSync(p, 'utf8'), { relaxed: true }) as { raw: Document }).raw,
}))

/** Every leaf with the keys above it. */
function leaves(v: unknown, path: string[] = [], out: Array<{ path: string[]; value: unknown }> = []) {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, path, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out)
  else out.push({ path, value: v })
  return out
}

/** Subtrees where MongoDB writes the query's values, or its own text that can quote one... */
const VALUE_TREES = new Set([
  'seekKeyLow',
  'seekKeyHigh',
  'slotBasedPlan',
  'projections',
  'expressions',
  'mergingExprs',
  'initExprs',
  'filter',
  'indexBounds',
  'parsedQuery',
  'errorMessage',
])
/** ...and texts known by their own key (an aggregation's `stages` list is a plan, not text). */
const VALUE_TEXT = new Set(['slots', 'stages'])
/** MongoDB's own size figures, named one by one (not the masker's pattern, so it is tested). */
const SIZES = new Set([
  'memUsage',
  'memLimit',
  'totalDataSizeSorted',
  'maxMemoryUsageBytes',
  'maxAccumulatorMemoryUsageBytes',
  'peakTrackedMemBytes',
  'spilledDataStorageSize',
  'spilledBytes',
  'totalSpillBytes',
  'spills',
  'spilledRecords',
  'usedDisk',
  'numBytesSpilledEstimate',
  'spilledBytesApprox',
  'totalDataSizeSortedBytesEstimate',
  'totalOutputDataSizeBytes',
])
/** A field reference, all a value position may keep (the masker's own rule is looser). */
const FIELD_REF = /^\$\$?[A-Za-z_][\w.]*$/

describe('an explain answer for a restricted user (sixth review)', () => {
  it('has fixtures to read', () => {
    expect(FIXTURES.length).toBeGreaterThan(40)
  })

  it.each(FIXTURES)('hides every value MongoDB wrote in $name', ({ raw }) => {
    for (const { path, value } of leaves(maskExplain(raw))) {
      if (value === null || value === undefined) continue
      const where = path.join('.')
      // A byte count, in any shape (a number, or one per accumulator), tells a value's length; so
      // does whether a run went to disk.
      if (path.some((k) => SIZES.has(k)) && !path.includes('serverParameters'))
        expect(value, where).toBe('***')
      // A value MongoDB wrote, a number too: only a field reference may stay.
      const text = path.some((k) => VALUE_TREES.has(k)) || VALUE_TEXT.has(path.at(-1)!)
      if (text && !(typeof value === 'string' && FIELD_REF.test(value))) expect(value, where).toBe('***')
    }
  })

  it.each(FIXTURES)('keeps the plan readable in $name', ({ raw }) => {
    // All of it but a node's filter and MongoDB's reason, which are values.
    const view = (answer: unknown) => {
      const { raw: _raw, ...rest } = normaliseExplain(answer as Document)
      return JSON.parse(
        JSON.stringify(rest, (k, v: unknown) =>
          k === 'filter' || (k === 'message' && v !== undefined) ? undefined : v,
        ),
      ) as unknown
    }
    expect(view(maskExplain(raw))).toEqual(view(raw))
  })

  it('hides a byte count given per accumulator', () => {
    const masked = maskExplain({
      stages: [
        { $group: { _id: null, c: { $push: '$$ROOT' } }, maxAccumulatorMemoryUsageBytes: { c: 4000 } },
      ],
      spilledDataStorageSize: 120,
      executionStats: {
        executionStages: { stage: 'group', spilledDataStorageSize: 120, peakTrackedMemBytes: 9 },
      },
    }) as Document
    expect(masked.stages[0].maxAccumulatorMemoryUsageBytes).toEqual({ c: '***' })
    expect(masked.spilledDataStorageSize).toBe('***')
    expect(masked.executionStats.executionStages).toMatchObject({
      stage: 'group',
      spilledDataStorageSize: '***',
      peakTrackedMemBytes: '***',
    })
  })

  it('hides SBE text inside a sub-plan, a "$" at its start included', () => {
    const answer = {
      stages: [
        {
          $unionWith: {
            coll: 'other',
            pipeline: [
              {
                $cursor: {
                  queryPlanner: {
                    winningPlan: {
                      stage: 'COLLSCAN',
                      slotBasedPlan: { slots: '$$RESULT=s1 env: { s2 = "SECRET" }', stages: 'x' },
                    },
                  },
                  executionStats: { executionSuccess: false, errorMessage: '$sort over "SECRET"' },
                },
              },
            ],
            // MongoDB's text right under a join stage, outside any sub-plan.
            errorMessage: '$unionWith over "SECRET"',
          },
        },
      ],
    }
    const masked = maskExplain(answer) as Document
    expect(JSON.stringify(masked)).not.toContain('SECRET')
    // A pipeline is a value position: a sub-plan there is hidden whole, as a view's literal that
    // looks like one would be (ninth review, M7).
    expect(masked.stages[0].$unionWith.pipeline[0].$cursor.queryPlanner.winningPlan.stage).toBe('***')
    const forged = maskExplain({
      stages: [{ $addFields: { x: { $const: { $cursor: { stage: 'SECRET', namespace: 'alice@x.com' } } } } }],
    })
    expect(JSON.stringify(forged)).not.toMatch(/SECRET|alice/)
  })

  it('keeps the names a join is read by, never the values in it', () => {
    const masked = maskExplain({
      stages: [
        {
          $lookup: {
            from: 'other',
            localField: 'g',
            foreignField: 'k',
            as: 'o',
            pipeline: [{ $match: { from: 'SECRET', as: 'SECRET' } }],
            let: { v: 'SECRET' },
          },
        },
        {
          $graphLookup: {
            from: 'tree',
            startWith: 'SECRET',
            connectFromField: 'p',
            connectToField: 'c',
            as: 't',
          },
        },
        { $match: { from: 'SECRET' } },
      ],
    }) as Document
    expect(masked.stages[0].$lookup).toMatchObject({
      from: 'other',
      localField: 'g',
      foreignField: 'k',
      as: 'o',
    })
    expect(masked.stages[1].$graphLookup).toMatchObject({
      from: 'tree',
      connectFromField: 'p',
      connectToField: 'c',
      as: 't',
    })
    expect(JSON.stringify(masked)).not.toContain('SECRET')
  })

  it('hides where the servers are, as errors do', () => {
    const masked = maskExplain({
      serverInfo: { host: 'db7.internal', port: 27017, version: '8.0.4' },
      queryPlanner: { winningPlan: { shards: [{ shardName: 's0', connectionString: 's0/10.0.0.5:27018' }] } },
    }) as Document
    expect(masked.serverInfo).toEqual({ host: '***', port: '***', version: '8.0.4' })
    expect(masked.queryPlanner.winningPlan.shards[0]).toEqual({ shardName: 's0', connectionString: '***' })
  })

  it('reads fields named as an object’s own keys are (constructor, toString) as any other', () => {
    const answer = JSON.parse(
      '{"queryPlanner":{"winningPlan":{"stage":"PROJECTION_DEFAULT","transformBy":{"constructor":{"$slice":3},"toString":1}}},"constructor":{"from":"x"},"__proto__":{"stage":"SECRET"}}',
    ) as unknown
    const masked = maskExplain(answer) as Document
    expect(JSON.stringify(masked)).not.toContain('SECRET')
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype)
  })

  it('hides a projection’s literals, names a plan node would carry included', () => {
    const masked = maskExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'PROJECTION_DEFAULT',
          transformBy: {
            version: 'SECRET',
            type: 'SECRET',
            localField: 'SECRET',
            keyPattern: { $const: 'SECRET' },
          },
          inputStage: { stage: 'IXSCAN', keyPattern: { g: 1 }, multiKeyPaths: { g: [] }, indexName: 'g_1' },
        },
      },
      somewhere: { keyPattern: { $const: 'SECRET' }, serverParameters: 'SECRET' },
    }) as Document
    expect(JSON.stringify(masked)).not.toContain('SECRET')
    expect(masked.queryPlanner.winningPlan.inputStage).toEqual({
      stage: 'IXSCAN',
      keyPattern: { g: 1 },
      multiKeyPaths: { g: [] },
      indexName: 'g_1',
    })
  })

  it('keeps a figure, and hides every other BSON value', () => {
    const masked = maskExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'CLUSTERED_IXSCAN',
          minRecord: new ObjectId(),
          maxRecord: new Date(),
          code: new Code('SECRET'),
          pattern: new BSONRegExp('SECRET'),
          decimal: Decimal128.fromString('1.5'),
          nReturned: Long.fromNumber(5),
          works: new Int32(3),
        },
      },
    }) as Document
    expect(masked.queryPlanner.winningPlan).toMatchObject({
      minRecord: '***',
      maxRecord: '***',
      code: '***',
      pattern: '***',
      decimal: '***',
    })
    expect(Number(masked.queryPlanner.winningPlan.nReturned)).toBe(5)
    expect(Number(masked.queryPlanner.winningPlan.works)).toBe(3)
  })

  it('hides a clustered scan’s bounds, numbers too: they are _id values (M9)', () => {
    const masked = maskExplain({
      executionStats: {
        executionStages: { stage: 'CLUSTERED_IXSCAN', minRecord: 17, maxRecord: 42, nReturned: 3 },
      },
    }) as Document
    expect(masked.executionStats.executionStages).toEqual({
      stage: 'CLUSTERED_IXSCAN',
      minRecord: '***',
      maxRecord: '***',
      nReturned: 3,
    })
  })

  it('keeps only field references in a value position, never other text that starts with "$"', () => {
    const masked = maskExplain({
      stages: [
        { $match: { hash: '$2b$10$abcdefghij' } },
        { $project: { b: '$$ROOT.c', c: '$$RESULT=s5 env: { }', d: '$ecret@x.com' } },
      ],
    }) as Document
    expect(masked.stages[0].$match.hash).toBe('***')
    // Not a field's name: text that only starts like one.
    expect(masked.stages[1].$project).toEqual({ b: '$$ROOT.c', c: '***', d: '***' })
    // A literal that looks like one, where only literals are (a view's $match, a filter).
    const literal = maskExplain({
      stages: [{ $match: { email: '$ecret@x.com', name: '$name' } }],
      queryPlanner: { winningPlan: { stage: 'COLLSCAN', filter: { email: { $eq: '$ecret' } } } },
    }) as Document
    expect(JSON.stringify(literal)).not.toContain('ecret')
    expect(literal.stages[0].$match.name).toBe('***')
    // $literal and $const hold literals wherever they are (ninth review, M8).
    const quoted = maskExplain({
      stages: [{ $project: { a: { $literal: '$john_doe' }, b: { $const: '$jane' } } }],
    })
    expect(JSON.stringify(quoted)).not.toMatch(/john|jane/)
  })

  it('hides a run going to disk, and a memory limit', () => {
    const masked = maskExplain({
      stages: [{ $sort: { sortKey: { n: 1 } }, usedDisk: true, memLimit: 104857600 }],
    }) as Document
    expect(masked.stages[0]).toMatchObject({ usedDisk: '***', memLimit: '***' })
  })

  it('reads an answer nested beyond any real plan without failing', () => {
    let deep: Document = { stage: 'EOF' }
    for (let i = 0; i < 10_000; i++) deep = { stage: 'FETCH', inputStage: deep }
    expect(() => maskExplain({ queryPlanner: { winningPlan: deep } })).not.toThrow()
  })

  it('shows the server’s own settings as set: they measure no data', () => {
    const settings = {
      internalQueryMaxBlockingSortMemoryUsageBytes: 104857600,
      internalQueryFrameworkControl: 'trySbeRestricted',
    }
    expect(
      (maskExplain({ serverParameters: settings, serverInfo: {} }) as Document).serverParameters,
    ).toEqual(settings)
  })

  /** The gate's lookups over fixed namespaces: their rules, indexes and views. */
  const gate = (
    rules: Array<{ db: string; coll: string; field: string }>,
    indexes: Record<string, Document[]> = {},
    views: Record<string, { viewOn: string; pipeline: Document[] }> = {},
    kinds: Record<string, 'timeseries' | 'missing'> = {},
  ): GateDeps => ({
    masker: compileRules(rules),
    indexes: async (db, coll) => indexes[`${db}.${coll}`] ?? [],
    view: async (db, coll) => views[`${db}.${coll}`] ?? null,
    kind: async (db, coll) => (views[`${db}.${coll}`] ? 'view' : (kinds[`${db}.${coll}`] ?? 'collection')),
  })
  const RULES = [
    { db: 'd', coll: 'c', field: 'email' },
    { db: 'd', coll: 'c', field: 'customer.phone' },
  ]
  const plan = (node: Document, namespace?: string) => ({
    queryPlanner: { ...(namespace ? { namespace } : {}), winningPlan: node },
  })

  it('finds an index holding a personal path by its key pattern', async () => {
    const g = gate(RULES)
    // A field below a personal one, the personal one itself, one above it, and a wildcard.
    expect(
      await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { 'email.domain': 1 } }), g, 'd', 'c'),
    ).toBeTruthy()
    expect(
      await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { g: 1, email: 1 } }), g, 'd', 'c'),
    ).toBeTruthy()
    // One above it counts a field's elements that is not personal itself (ninth review, I6).
    expect(await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { customer: 1 } }), g, 'd', 'c')).toBeNull()
    expect(await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { '$**': 1 } }), g, 'd', 'c')).toBeTruthy()
    expect(await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { g: 1, n: -1 } }), g, 'd', 'c')).toBeNull()
    // As text, quoted or not (an IDHACK writes it so).
    expect(
      await personalPlan(plan({ stage: 'IDHACK', keyPattern: '{ "email": 1 }' }), g, 'd', 'c'),
    ).toBeTruthy()
    // Nothing is personal where the plan reads.
    expect(
      await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { email: 1 } }), g, 'd', 'other'),
    ).toBeNull()
  })

  it('finds one named only (an SBE stage, a join’s indexesUsed), through the collection’s indexes', async () => {
    const g = gate(RULES, {
      'd.c': [
        { name: 'name_phone', key: { name: 1, 'customer.phone': 1 } },
        { name: 'name_1', key: { name: 1 } },
      ],
    })
    expect(await personalPlan(plan({ stage: 'ixseek', indexName: 'name_phone' }), g, 'd', 'c')).toBeTruthy()
    expect(await personalPlan(plan({ stage: 'ixseek', indexName: 'name_1' }), g, 'd', 'c')).toBeNull()
    // An index it cannot name where personal data is: refused, in doubt.
    expect(await personalPlan(plan({ stage: 'ixseek', indexName: 'gone' }), g, 'd', 'c')).toBeTruthy()
    // A join into the collection: classic ($lookup with indexesUsed) and SBE (EQ_LOOKUP).
    const classic = {
      stages: [
        { $cursor: { queryPlanner: { namespace: 'd.notes', winningPlan: { stage: 'COLLSCAN' } } } },
        {
          $lookup: { from: 'c', localField: 'x', foreignField: 'name', as: 'o' },
          indexesUsed: ['name_phone'],
        },
      ],
    }
    expect(await personalPlan(classic, g, 'd', 'notes')).toBeTruthy()
    const sbe = plan({
      stage: 'EQ_LOOKUP',
      foreignCollection: 'd.c',
      indexName: 'name_phone',
      inputStage: { stage: 'COLLSCAN' },
    })
    expect(await personalPlan(sbe, g, 'd', 'notes')).toBeTruthy()
    const union = {
      stages: [{ $unionWith: { coll: 'c', pipeline: [] } }],
      queryPlanner: { winningPlan: { stage: 'ixseek', indexName: 'name_phone' } },
    }
    expect(await personalPlan(union, g, 'd', 'notes')).toBeTruthy()
  })

  it('reads a join’s target in the request’s database, a dot in its name or not (I1)', async () => {
    const g = gate([{ db: 'd', coll: 'users.archive', field: 'phone' }], {
      'd.users.archive': [{ name: 'p_1', key: { phone: 1 } }],
    })
    const answer = {
      stages: [
        {
          $lookup: { from: 'users.archive', localField: 'a', foreignField: 'phone', as: 'o' },
          indexesUsed: ['p_1'],
        },
      ],
    }
    expect(await personalPlan(answer, g, 'd', 'notes')).toBe('d.users.archive')
  })

  it('follows a join into a view to its source, where the rules and indexes are (I2)', async () => {
    const g = gate(
      RULES,
      { 'd.c': [{ name: 'cust_phone', key: { cust: 1, 'customer.phone': 1 } }] },
      { 'd.usersView': { viewOn: 'c', pipeline: [] } },
    )
    const answer = {
      stages: [
        {
          $lookup: { from: 'usersView', localField: 'a', foreignField: 'cust', as: 'o' },
          indexesUsed: ['cust_phone'],
        },
      ],
    }
    expect(await personalPlan(answer, g, 'd', 'notes')).toBe('d.c')
  })

  it('never reads a namespace from what the user wrote (M2)', async () => {
    const listed = gate(RULES, { 'd.notes': [{ name: 'g_1', key: { g: 1 } }] })
    const indexes = vi.fn(listed.indexes)
    const g: GateDeps = { ...listed, indexes }
    const answer = {
      command: { find: 'notes', filter: { namespace: 'admin.system.users', indexName: 'x' } },
      queryPlanner: {
        namespace: 'd.notes',
        parsedQuery: { namespace: { $eq: 'admin.system.users' } },
        winningPlan: { stage: 'COLLSCAN' },
      },
      // A stage's spec is the user's too.
      stages: [{ $project: { namespace: 'admin.system.users', indexName: 'x', keyPattern: { email: 1 } } }],
    }
    // A real plan node names an index, so the namespaces are looked at (tenth review, M2).
    answer.queryPlanner.winningPlan = { stage: 'IXSCAN', indexName: 'g_1', keyPattern: { g: 1 } } as never
    expect(await personalPlan(answer, g, 'd', 'notes')).toBeNull()
    expect(indexes).toHaveBeenCalled()
    expect(indexes.mock.calls.map((c) => c.join('.'))).not.toContain('admin.system.users')
  })

  it('refuses where a collection with rules cannot list its indexes and a name is not found (M1)', async () => {
    const g = gate(RULES, { 'd.notes': [{ name: 'cust_1', key: { cust: 1 } }] })
    // The foreign cust_1 is not the local one: the collection with rules listed nothing.
    const answer = {
      stages: [
        {
          $cursor: {
            queryPlanner: { namespace: 'd.notes', winningPlan: { stage: 'IXSCAN', indexName: 'cust_1' } },
          },
        },
        { $lookup: { from: 'c', localField: 'a', foreignField: 'cust', as: 'o' }, indexesUsed: ['cust_1'] },
      ],
    }
    expect(await personalPlan(answer, g, 'd', 'notes')).toBe('d.c')
  })

  it('counts a field in a rule as personal, not every path a ** rule could reach (I6)', async () => {
    const g = gate([{ db: 'd', coll: 'c', field: '**.ssn' }])
    expect(await personalPlan(plan({ stage: 'IDHACK', keyPattern: { _id: 1 } }), g, 'd', 'c')).toBeNull()
    expect(await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { 'a.ssn': 1 } }), g, 'd', 'c')).toBe('d.c')
  })

  it('takes a text index, and a time-series one named by the collection itself, as personal (M4, M5)', async () => {
    const g = gate(RULES)
    expect(
      await personalPlan(plan({ stage: 'TEXT_MATCH', keyPattern: { _fts: 'text', _ftsx: 1 } }), g, 'd', 'c'),
    ).toBe('d.c')
    const series = gate([{ db: 'd', coll: 'ts', field: 'metadata.phone' }], {}, {}, { 'd.ts': 'timeseries' })
    expect(
      await personalPlan(
        plan({ stage: 'IXSCAN', keyPattern: { 'meta.region': 1 } }, 'd.ts'),
        series,
        'd',
        'ts',
      ),
    ).toBe('d.ts')
    // An ordinary collection may name a field meta: its index is judged by its rules (tenth review, M2).
    const ordinary = gate([{ db: 'd', coll: 'u', field: 'email' }])
    expect(
      await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { 'meta.x': 1 } }, 'd.u'), ordinary, 'd', 'u'),
    ).toBeNull()
  })

  it('refuses in doubt where an index’s keys may name another collection’s paths', async () => {
    // A view with rules of its own: its plan names its source's paths.
    const view = gate(
      [{ db: 'd', coll: 'v', field: 'phone' }],
      {},
      { 'd.v': { viewOn: 'src', pipeline: [] } },
    )
    expect(
      await personalPlan(
        plan({ stage: 'IXSCAN', keyPattern: { 'customer.phone': 1 } }, 'd.src'),
        view,
        'd',
        'v',
      ),
    ).toBeTruthy()
    // A time-series collection reads its buckets, whose keys are meta.* and control.*.
    const series = gate([{ db: 'd', coll: 'ts', field: 'metadata.phone' }])
    expect(
      await personalPlan(
        plan({ stage: 'IXSCAN', keyPattern: { 'meta.region': 1 } }, 'd.system.buckets.ts'),
        series,
        'd',
        'ts',
      ),
    ).toBeTruthy()
    // With no index at all, nothing is refused.
    expect(
      await personalPlan(plan({ stage: 'COLLSCAN' }, 'd.system.buckets.ts'), series, 'd', 'ts'),
    ).toBeNull()
  })
  it('follows joins nested in a join’s pipeline and in a joined view’s (tenth review, I1)', async () => {
    const rules = [{ db: 'd', coll: 'users', field: 'tags' }]
    const indexes = { 'd.users': [{ name: 'acc_tags', key: { accountId: 1, tags: 1 } }] }
    const nested = {
      stages: [
        { $cursor: { queryPlanner: { namespace: 'd.orders', winningPlan: { stage: 'COLLSCAN' } } } },
        {
          $lookup: {
            from: 'shipments',
            as: 's',
            pipeline: [{ $lookup: { from: 'users', localField: 'u', foreignField: 'accountId', as: 'x' } }],
          },
          indexesUsed: ['acc_tags'],
          totalKeysExamined: 7,
        },
      ],
    }
    expect(await personalPlan(nested, gate(rules, indexes), 'd', 'orders')).toBe('d.users')
    const viaView = {
      stages: [
        { $cursor: { queryPlanner: { namespace: 'd.orders', winningPlan: { stage: 'COLLSCAN' } } } },
        {
          $lookup: { from: 'joined', localField: 'a', foreignField: 'b', as: 's' },
          indexesUsed: ['acc_tags'],
        },
      ],
    }
    const views = {
      'd.joined': {
        viewOn: 'shipments',
        pipeline: [{ $lookup: { from: 'users', localField: 'u', foreignField: 'accountId', as: 'x' } }],
      },
    }
    expect(await personalPlan(viaView, gate(rules, indexes, views), 'd', 'orders')).toBe('d.users')
  })

  it('refuses an index it cannot place while rules apply, and when there are more joins than it follows (I1, I2)', async () => {
    const rules = [{ db: 'd', coll: 'users', field: 'tags' }]
    const unknown = {
      queryPlanner: { namespace: 'd.orders', winningPlan: { stage: 'IXSCAN', indexName: 'nowhere_1' } },
    }
    expect(await personalPlan(unknown, gate(rules), 'd', 'orders')).toBeTruthy()
    const many = {
      stages: [
        ...Array.from({ length: 60 }, (_, i) => ({
          $lookup: { from: `c${i}`, localField: 'a', foreignField: 'b', as: `o${i}` },
        })),
        { $lookup: { from: 'users', localField: 'a', foreignField: 'accountId', as: 'u' } },
      ],
      queryPlanner: {
        namespace: 'd.orders',
        winningPlan: { stage: 'EQ_LOOKUP', foreignCollection: 'd.users', indexKeyPattern: { tags: 1 } },
      },
    }
    expect(await personalPlan(many, gate(rules), 'd', 'orders')).toBeTruthy()
  })

  it('takes a wildcard index below a personal path for what it may scan (I3)', async () => {
    const g = gate([{ db: 'd', coll: 'c', field: 'profile.ssn' }])
    expect(
      await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { $_path: 1, profile: 1 } }), g, 'd', 'c'),
    ).toBe('d.c')
    expect(await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { 'profile.$**': 1 } }), g, 'd', 'c')).toBe(
      'd.c',
    )
    // A wildcard scan of a path beside the personal one reads that path's keys only (eleventh, M5).
    expect(
      await personalPlan(
        plan({ stage: 'IXSCAN', keyPattern: { $_path: 1, 'profile.city': 1 } }),
        g,
        'd',
        'c',
      ),
    ).toBeNull()
    // An ordinary index on a field beside the personal one is not.
    expect(
      await personalPlan(plan({ stage: 'IXSCAN', keyPattern: { 'profile.city': 1 } }), g, 'd', 'c'),
    ).toBeNull()
    // A wildcard scan of another collection widens nothing here.
    // (A rule below the other index's field: a pooled wildcard would make that index personal.)
    const two = gate([{ db: 'd', coll: 'b', field: 'address.city.zip' }])
    const answer = {
      stages: [
        {
          $cursor: {
            queryPlanner: {
              namespace: 'd.a',
              winningPlan: { stage: 'IXSCAN', keyPattern: { $_path: 1, x: 1 } },
            },
          },
        },
        { $lookup: { from: 'b', localField: 'k', foreignField: 'address.city', as: 'o' } },
      ],
      queryPlanner: {
        winningPlan: { stage: 'EQ_LOOKUP', foreignCollection: 'd.b', indexKeyPattern: { 'address.city': 1 } },
      },
    }
    expect(await personalPlan(answer, two, 'd', 'a')).toBeNull()
  })

  it('tells why: a personal index, a plan reading too much, an index it cannot place (eleventh, M3)', async () => {
    const rules = [{ db: 'd', coll: 'users', field: 'tags' }]
    expect(
      await planRefusal(
        plan({ stage: 'IXSCAN', keyPattern: { tags: 1 } }, 'd.users'),
        gate(rules),
        'd',
        'users',
      ),
    ).toEqual({
      ns: 'd.users',
      why: 'index',
    })
    const many = {
      stages: Array.from({ length: 60 }, (_, i) => ({
        $lookup: { from: `c${i}`, localField: 'a', foreignField: 'b', as: `o${i}` },
      })),
      queryPlanner: { winningPlan: { stage: 'IXSCAN', keyPattern: { g: 1 } } },
    }
    expect(await planRefusal(many, gate(rules), 'd', 'orders')).toMatchObject({ why: 'too_many' })
    const unplaced = plan({ stage: 'IXSCAN', indexName: 'nowhere_1' }, 'd.orders')
    expect(await planRefusal(unplaced, gate(rules), 'd', 'orders')).toEqual({
      ns: 'd.orders',
      why: 'unplaced',
    })
  })

  it('reads a key vault’s indexes with no rule at all (eleventh, M1)', async () => {
    const stop = registerKeyVaults({ keyVaultNamespaces: () => new Set(['d.keys']) })
    try {
      const answer = plan({ stage: 'IXSCAN', keyPattern: { keyAltNames: 1 } }, 'd.keys')
      expect(await personalPlan(answer, gate([]), 'd', 'keys')).toBe('d.keys')
    } finally {
      stop()
    }
  })

  it('keeps the field-name doubt about time-series where the gate cannot tell a collection’s kind (M4)', async () => {
    const { kind: _kind, ...noKind } = gate([{ db: 'd', coll: 'ts', field: 'metadata.phone' }])
    expect(
      await personalPlan(
        plan({ stage: 'IXSCAN', keyPattern: { 'meta.region': 1 } }, 'd.ts'),
        noKind,
        'd',
        'ts',
      ),
    ).toBe('d.ts')
  })

  it('follows a join inside a $facet (eleventh, test gap)', async () => {
    const rules = [{ db: 'd', coll: 'users', field: 'tags' }]
    const indexes = { 'd.users': [{ name: 'acc_tags', key: { accountId: 1, tags: 1 } }] }
    const answer = {
      stages: [
        { $cursor: { queryPlanner: { namespace: 'd.orders', winningPlan: { stage: 'COLLSCAN' } } } },
        {
          $facet: {
            joined: [{ $lookup: { from: 'users', localField: 'u', foreignField: 'accountId', as: 'x' } }],
          },
          indexesUsed: ['acc_tags'],
        },
      ],
    }
    expect(await personalPlan(answer, gate(rules, indexes), 'd', 'orders')).toBe('d.users')
  })

  it('does not refuse for a collection with rules that does not exist yet (M1)', async () => {
    const g = gate(
      [{ db: 'd', coll: '*', field: 'email' }],
      { 'd.orders': [{ name: 'status_1', key: { status: 1 } }] },
      {},
      { 'd.later': 'missing' },
    )
    const answer = {
      stages: [
        {
          $cursor: {
            queryPlanner: { namespace: 'd.orders', winningPlan: { stage: 'IXSCAN', indexName: 'status_1' } },
          },
        },
        { $lookup: { from: 'later', localField: 'a', foreignField: 'b', as: 'l' } },
      ],
    }
    expect(await personalPlan(answer, g, 'd', 'orders')).toBeNull()
  })

  it('looks nothing up where no rule applies (M5)', async () => {
    const indexes = vi.fn(async () => [])
    const g: GateDeps = { ...gate([]), indexes }
    expect(await personalPlan(plan({ stage: 'IXSCAN', indexName: 'x' }), g, 'd', 'c')).toBeNull()
    expect(indexes).not.toHaveBeenCalled()
  })
})
