import { describe, expect, it } from 'vitest'
import {
  BOUNDARIES,
  BSON_LIMIT,
  MAX_FIELDS,
  bytesText,
  outOfMemory,
  enterable,
  nameBytes,
  namesShare,
  readMeasured,
  sizePipeline,
} from '../src/size'

// The pipeline was checked on a real MongoDB 8: its sizes are the BSON sizes, to the byte.
const int = (n: number) => ({ $numberInt: String(n) })

describe('the pipeline', () => {
  it('samples, measures each document and each field, and answers in one document', () => {
    const p = sizePipeline([], 1000)
    expect(p[0]).toEqual({ $sample: { size: 1000 } })
    const project = (
      p[1] as { $project: { size: unknown; fields: { $map: { input: unknown; in: { s: unknown } } } } }
    ).$project
    expect(project.size).toEqual({ $bsonSize: '$$ROOT' })
    expect(project.fields.$map.input).toEqual({ $objectToArray: '$$ROOT' })
    // A field's bytes: a document of it alone, less an empty document's 5.
    expect(project.fields.$map.in.s).toEqual({
      $subtract: [{ $bsonSize: { $arrayToObject: [[{ k: '$$f.k', v: '$$f.v' }]] } }, 5],
    })
    const facet = (p[2] as { $facet: Record<string, Array<Record<string, unknown>>> }).$facet
    expect(Object.keys(facet)).toEqual(['stats', 'spread', 'largest', 'fields'])
    expect((facet.spread![0]!.$bucket as { boundaries: number[] }).boundaries).toEqual(BOUNDARIES)
    expect(facet.largest).toEqual([
      { $project: { _id: 1, size: 1 } },
      { $sort: { size: -1 } },
      { $limit: 10 },
    ])
    // The fields taking the most first; of two the same, by name.
    expect(facet.fields!.at(-2)).toEqual({ $sort: { total: -1, _id: 1 } })
    expect(facet.fields!.at(-1)).toEqual({ $limit: MAX_FIELDS + 1 })
  })

  it('measures all documents with no sample, and an object field’s own fields where it is one', () => {
    expect(sizePipeline([], null)[0]).toHaveProperty('$project')
    const p = sizePipeline(['address', 'geo'], 1000)
    // As the expressions read the path: an array of objects there is no object (review I2).
    expect(p[1]).toEqual({ $match: { $expr: { $eq: [{ $type: '$address.geo' }, 'object'] } } })
    const project = (p[2] as { $project: { size: unknown; fields: { $map: { input: unknown } } } }).$project
    expect(project.size).toEqual({ $bsonSize: '$address.geo' })
    expect(project.fields.$map.input).toEqual({ $objectToArray: '$address.geo' })
  })

  it('draws the sample after measuring when asked, for documents too large to sort whole', () => {
    const late = sizePipeline([], 1000, true)
    expect(late[0]).toHaveProperty('$project')
    expect(late[1]).toEqual({ $sample: { size: 1000 } })
    expect(outOfMemory('MongoDB refused the operation (292 QueryExceededMemoryLimitNoDiskUseAllowed)')).toBe(
      true,
    )
    expect(outOfMemory('Sort exceeded memory limit of 104857600 bytes')).toBe(true)
    expect(outOfMemory('MongoDB denied this operation')).toBe(false)
  })

  it('counts every field’s name on the server, and sorts the largest by their sizes alone', () => {
    const facet = (sizePipeline([], null)[1] as { $facet: Record<string, Array<Record<string, unknown>>> })
      .$facet
    const group = facet.stats![0]!.$group as Record<string, unknown>
    expect(group.names).toEqual({
      $sum: { $sum: { $map: { input: '$fields', in: { $add: [{ $strLenBytes: '$$this.k' }, 2] } } } },
    })
    expect(facet.largest![0]).toEqual({ $project: { _id: 1, size: 1 } })
  })

  it('goes into a key a path can name only', () => {
    expect(enterable('address')).toBe(true)
    for (const no of ['', 'a.b', '$x']) expect(enterable(no), no).toBe(false)
  })
})

describe('the answer', () => {
  const ANSWER = {
    stats: [{ _id: null, n: int(3), total: int(5274), max: int(5126), names: int(60) }],
    spread: [
      { _id: int(0), n: int(2) },
      { _id: int(4096), n: int(1) },
    ],
    largest: [
      { _id: int(1), size: int(5126) },
      { _id: int(3), size: int(91) },
    ],
    fields: [
      { _id: 'blob', total: int(5011), docs: int(1), max: int(5011), types: ['string'], elements: null },
      {
        _id: 'tags',
        total: int(49),
        docs: int(2),
        max: int(38),
        types: ['array'],
        elements: { $numberDouble: '1.5' },
      },
      {
        _id: 'address',
        total: int(98),
        docs: int(3),
        max: int(49),
        types: ['string', 'object'],
        elements: null,
      },
    ],
  }

  it('is read as documents, sizes in ranges, the largest, and each field', () => {
    const m = readMeasured(ANSWER)
    expect(m).toMatchObject({ documents: 3, total: 5274, max: 5126, names: 60, moreFields: false })
    expect(m.spread).toEqual([2, 0, 1, 0, 0, 0, 0, 0])
    expect(m.largest).toEqual([
      { id: int(1), size: 5126 },
      { id: int(3), size: 91 },
    ])
    expect(m.fields[1]).toEqual({
      name: 'tags',
      total: 49,
      docs: 2,
      max: 38,
      types: ['array'],
      elements: 1.5,
    })
    expect(m.fields[2]!.types).toEqual(['object', 'string'])
    expect(m.fields[0]!.elements).toBeNull()
  })

  it('counts a size past the limit with the largest range, never the smallest', () => {
    const m = readMeasured({
      ...ANSWER,
      spread: [
        { _id: int(0), n: int(2) },
        { _id: 'over', n: int(1) },
      ],
    })
    expect(m.spread).toEqual([2, 0, 0, 0, 0, 0, 0, 1])
  })

  it('says when more fields hold bytes than are listed', () => {
    const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({
      _id: `f${i}`,
      total: int(1),
      docs: int(1),
      max: int(1),
      types: [],
    }))
    const m = readMeasured({ ...ANSWER, fields: many })
    expect(m.fields).toHaveLength(MAX_FIELDS)
    expect(m.moreFields).toBe(true)
  })

  it('is empty for an empty collection, and for no answer at all', () => {
    expect(readMeasured({ stats: [], spread: [], largest: [], fields: [] })).toMatchObject({
      documents: 0,
      total: 0,
      fields: [],
    })
    expect(readMeasured(undefined)).toMatchObject({ documents: 0, spread: [0, 0, 0, 0, 0, 0, 0, 0] })
  })
})

describe('names and sizes', () => {
  it('counts a name’s bytes in each document holding it', () => {
    expect(nameBytes('a')).toBe(3)
    expect(nameBytes('ğ')).toBe(4)
    // Counted on the server over every field, those not listed too.
    const m = readMeasured({ stats: [{ n: int(10), total: int(1000), names: { $numberLong: '150' } }] })
    expect(namesShare(m)).toBeCloseTo(0.15)
    expect(namesShare(readMeasured({}))).toBe(0)
  })

  it('writes a size as MongoDB counts it, 1 KB 1,024 bytes', () => {
    expect(bytesText(512, 'en')).toBe('512 B')
    expect(bytesText(1000, 'en')).toBe('1,000 B')
    expect(bytesText(1023, 'en')).toBe('1,023 B')
    expect(bytesText(1024, 'en')).toBe('1 KB')
    expect(bytesText(2355, 'en')).toBe('2.3 KB')
    expect(bytesText(1536 * 1024, 'tr')).toBe(
      `${new Intl.NumberFormat('tr', { maximumFractionDigits: 1 }).format(1.5)} MB`,
    )
    expect(bytesText(1536 * 1024, 'pt')).toBe(
      `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(1.5)} MB`,
    )
    expect(bytesText(1536 * 1024, 'ja')).toBe(
      `${new Intl.NumberFormat('ja', { maximumFractionDigits: 1 }).format(1.5)} MB`,
    )
    expect(bytesText(1536 * 1024, 'de')).toBe(
      `${new Intl.NumberFormat('de', { maximumFractionDigits: 1 }).format(1.5)} MB`,
    )
    expect(bytesText(1536 * 1024, 'xx')).toBe(bytesText(1536 * 1024, 'en'))
    expect(bytesText(BSON_LIMIT, 'en')).toBe('16 MB')
    // Never 1,024 of a unit; and gigabytes for a whole collection.
    expect(bytesText(1024 * 1024 - 1, 'en')).toBe('1 MB')
    expect(bytesText(51.2 * 1024 ** 3, 'en')).toBe('51.2 GB')
  })
})
