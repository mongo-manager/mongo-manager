import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  indexFindings,
  sampleFindings,
  showFilter,
  sizeFindings,
  sizePipeline,
  sortFindings,
  surveyFindings,
  surveySample,
  typeShares,
  type Doc,
  type Finding,
} from '../src/checks'

const int = (n: number) => ({ $numberInt: String(n) })
const nested = (depth: number): Record<string, unknown> => {
  let v: Record<string, unknown> = { leaf: 1 }
  for (let i = 1; i < depth; i++) v = { n: v }
  return v
}

describe('what a sample of documents says about the schema (schema health)', () => {
  it('finds a large array, by path, the largest first', () => {
    const findings = sampleFindings([
      { tags: Array.from({ length: 1500 }, () => 'x') },
      { tags: ['a'], items: [{ parts: Array.from({ length: 12000 }, () => int(1)) }] },
    ])
    expect(findings.filter((f) => f.id === 'largeArray')).toEqual([
      { id: 'largeArray', severity: 'high', path: 'items.parts', values: { length: 12000 } },
      { id: 'largeArray', severity: 'warning', path: 'tags', values: { length: 1500 } },
    ])
  })

  it('finds deep nesting and documents with very many fields', () => {
    const wide = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`f${i}`, i]))
    const findings = sampleFindings([nested(LIMITS.depthWarn + 2), wide])
    expect(findings.find((f) => f.id === 'deepNesting')).toMatchObject({
      severity: 'warning',
      values: { depth: LIMITS.depthWarn + 2 },
    })
    expect(findings.find((f) => f.id === 'manyFields')).toMatchObject({
      severity: 'warning',
      values: { fields: 205 },
    })
  })

  it('finds a field holding values of more than one type, null aside', () => {
    const findings = sampleFindings([
      { price: int(5), note: null, at: { $date: { $numberLong: '0' } } },
      { price: '5', note: 'x', at: { $date: { $numberLong: '1' } } },
      { price: { $numberDouble: '5.5' } },
    ])
    expect(findings.filter((f) => f.id === 'mixedTypes')).toEqual([
      { id: 'mixedTypes', severity: 'info', path: 'price', values: { types: 'number, string' } },
    ])
  })

  it('finds nothing in plain documents', () => {
    expect(
      sampleFindings([
        { a: 1, b: { c: [1, 2] } },
        { a: 2, b: { c: [] } },
      ]),
    ).toEqual([])
  })
})

describe('what the sizes say (schema health)', () => {
  it('measures documents on the server, over a sample', () => {
    expect(sizePipeline(10000)).toEqual([
      { $sample: { size: int(10000) } },
      { $project: { _id: 0, s: { $bsonSize: '$$ROOT' } } },
      {
        $group: {
          _id: null,
          count: { $sum: int(1) },
          avg: { $avg: '$s' },
          max: { $max: '$s' },
          over1mb: { $sum: { $cond: [{ $gt: ['$s', int(LIMITS.docWarn)] }, int(1), int(0)] } },
          over8mb: { $sum: { $cond: [{ $gt: ['$s', int(LIMITS.docHigh)] }, int(1), int(0)] } },
        },
      },
    ])
  })

  it('warns of large documents, more strongly near the limit', () => {
    expect(
      sizeFindings({
        count: int(100),
        avg: int(2000),
        max: int(9_000_000),
        over1mb: int(3),
        over8mb: int(1),
      }),
    ).toEqual([{ id: 'largeDocuments', severity: 'high', values: { count: 1, max: 9_000_000 } }])
    expect(
      sizeFindings({
        count: int(100),
        avg: int(2000),
        max: int(2_000_000),
        over1mb: int(3),
        over8mb: int(0),
      }),
    ).toEqual([{ id: 'largeDocuments', severity: 'warning', values: { count: 3, max: 2_000_000 } }])
    expect(
      sizeFindings({ count: int(1), avg: int(10), max: int(10), over1mb: int(0), over8mb: int(0) }),
    ).toEqual([])
    expect(sizeFindings(null)).toEqual([])
  })
})

describe('what the indexes say (schema health)', () => {
  const ix = (
    name: string,
    key: Record<string, unknown>,
    ops: number | null,
    options: Record<string, unknown> = {},
  ) => ({
    name,
    key,
    options,
    usage: ops === null ? null : { ops, since: '2026-10-01T00:00:00.000Z' },
  })

  it('finds unused indexes, never the _id index', () => {
    const findings = indexFindings([
      ix('_id_', { _id: int(1) }, 0),
      ix('a_1', { a: int(1) }, 0),
      ix('b_1', { b: int(1) }, 9),
    ])
    expect(findings).toEqual([
      { id: 'unusedIndex', severity: 'info', values: { index: 'a_1', since: '2026-10-01T00:00:00.000Z' } },
    ])
  })

  it('finds an index whose keys begin another index’s keys, unless it does more (unique, partial…)', () => {
    const findings = indexFindings([
      ix('a_1', { a: int(1) }, 5),
      ix('a_1_b_-1', { a: int(1), b: int(-1) }, 5),
      ix('c_1', { c: int(1) }, 5, { unique: true }),
      ix('c_1_d_1', { c: int(1), d: int(1) }, 5),
      ix('e_-1', { e: int(-1) }, 5),
      ix('e_1_f_1', { e: int(1), f: int(1) }, 5),
      ix('g_text', { _fts: 'text', _ftsx: int(1) }, 5),
    ])
    // An index may be read backwards: {e: -1} is the start of {e: 1, f: 1} too.
    expect(findings).toEqual([
      { id: 'redundantIndex', severity: 'info', values: { index: 'a_1', covered: 'a_1_b_-1' } },
      { id: 'redundantIndex', severity: 'info', values: { index: 'e_-1', covered: 'e_1_f_1' } },
    ])
  })

  it('never calls a unique or a TTL index unused: it does its work without queries (review M3)', () => {
    expect(
      indexFindings([
        ix('email_1', { email: int(1) }, 0, { unique: true }),
        ix('at_1', { at: int(1) }, 0, { expireAfterSeconds: int(3600) }),
      ]),
    ).toEqual([])
  })

  it('never calls an index covered by a hidden one, or one of another collation (review M4)', () => {
    expect(
      indexFindings([
        ix('a_1', { a: int(1) }, 5),
        ix('a_1_b_1', { a: int(1), b: int(1) }, 5, { hidden: true }),
        ix('c_1', { c: int(1) }, 5),
        ix('c_1_d_1', { c: int(1), d: int(1) }, 5, { collation: { locale: 'tr' } }),
      ]),
    ).toEqual([])
  })

  it('warns of many indexes', () => {
    const many = Array.from({ length: LIMITS.indexesWarn + 1 }, (_, i) =>
      ix(`f${i}_1`, { [`f${i}`]: int(1) }, 1),
    )
    expect(indexFindings(many)).toContainEqual({
      id: 'manyIndexes',
      severity: 'warning',
      values: { count: LIMITS.indexesWarn + 1 },
    })
  })

  it('orders findings: high, then warnings, then information', () => {
    expect(
      sortFindings([
        { id: 'a', severity: 'info', values: {} },
        { id: 'b', severity: 'high', values: {} },
        { id: 'c', severity: 'warning', values: {} },
      ]).map((f) => f.id),
    ).toEqual(['b', 'c', 'a'])
  })
})

describe('the documents a finding is about, for Documents (schema health)', () => {
  const mixed = (docs: Doc[], path: string) => {
    const survey = surveySample(docs)
    const finding = surveyFindings(survey).find((f) => f.id === 'mixedTypes' && f.path === path)!
    return { survey, finding }
  }

  it('counts each type a field holds once per sampled document, the most common first', () => {
    const { survey } = mixed(
      [{ items: [{ p: int(1) }, { p: int(2) }] }, { items: [{ p: 'x' }] }, { items: [{ p: int(3) }] }],
      'items.p',
    )
    expect(typeShares(survey, 'items.p')).toEqual([
      { type: 'number', count: 2 },
      { type: 'string', count: 1 },
    ])
  })

  it('finds the same as before from a survey of the sample', () => {
    const docs: Doc[] = [{ total: int(5) }, { total: '5' }, { tags: Array.from({ length: 1001 }, () => 1) }]
    expect(surveyFindings(surveySample(docs))).toEqual(sampleFindings(docs))
  })

  it('selects the documents holding the rarer types of a mixed field', () => {
    const { survey, finding } = mixed(
      [{ total: int(5) }, { total: int(6) }, { total: '7' }, { total: null }],
      'total',
    )
    expect(showFilter(finding, survey)).toEqual({ total: { $type: 'string' } })
  })

  it('names several rarer types as a list, by the names $type knows', () => {
    const bin = { $binary: { base64: 'AA==', subType: '00' } }
    const { survey, finding } = mixed(
      [{ v: int(1) }, { v: int(2) }, { v: int(3) }, { v: true }, { v: bin }],
      'v',
    )
    expect(showFilter(finding, survey)).toEqual({ v: { $type: ['binData', 'bool'] } })
  })

  it('offers nothing it could not select exactly', () => {
    // $type on an array matches its elements too: "string" would pick the arrays of strings.
    const arrays = mixed([{ tags: ['a'] }, { tags: ['b'] }, { tags: 'c' }], 'tags')
    expect(showFilter(arrays.finding, arrays.survey)).toBeNull()
    // A field name with a dot, or one that reads as an operator, cannot be named in a query.
    const dotted = mixed([{ 'a.b': int(1) }, { 'a.b': 'x' }], 'a.b')
    expect(showFilter(dotted.finding, dotted.survey)).toBeNull()
    const operator = mixed([{ x: { $where: int(1) } }, { x: { $where: 'x' } }], 'x.$where')
    expect(showFilter(operator.finding, operator.survey)).toBeNull()
    const deep: Finding = { id: 'deepNesting', severity: 'warning', values: { depth: 30 } }
    expect(showFilter(deep, surveySample([]))).toBeNull()
    const unused: Finding = { id: 'unusedIndex', severity: 'info', values: { index: 'a_1', since: '' } }
    expect(showFilter(unused, null)).toBeNull()
  })

  it('selects large arrays by the element past the threshold, large documents by their size', () => {
    const docs: Doc[] = [{ tags: Array.from({ length: 1500 }, () => 'x') }]
    const survey = surveySample(docs)
    const array = surveyFindings(survey).find((f) => f.id === 'largeArray')!
    expect(showFilter(array, survey)).toEqual({ [`tags.${LIMITS.arrayWarn}`]: { $exists: true } })
    const dotted = surveySample([{ 'a.b': Array.from({ length: 1500 }, () => 'x') }])
    expect(showFilter(surveyFindings(dotted)[0]!, dotted)).toBeNull()
    const size = (severity: 'high' | 'warning'): Finding => ({
      id: 'largeDocuments',
      severity,
      values: { count: 1, max: 9_000_000 },
    })
    expect(showFilter(size('high'), null)).toEqual({
      $expr: { $gt: [{ $bsonSize: '$$ROOT' }, int(LIMITS.docHigh)] },
    })
    expect(showFilter(size('warning'), null)).toEqual({
      $expr: { $gt: [{ $bsonSize: '$$ROOT' }, int(LIMITS.docWarn)] },
    })
  })
})
