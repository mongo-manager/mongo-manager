import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Int32, ObjectId, type Document } from 'bson'
import { ExportRequestSchema } from '@mongo-manager/shared'
import { docWriter } from '../src/transfer/writers'

/**
 * W4 item 2 (completion design §2 W4.2): arrays in a CSV or Excel export — a JSON cell (as
 * before), one column per element up to a bound, or the elements joined with a separator.
 */
async function csvOf(docs: Document[], over: Record<string, unknown> = {}) {
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (c: Buffer) => chunks.push(c))
  const req = ExportRequestSchema.parse({
    source: { kind: 'collection' },
    format: 'csv',
    csv: { delimiter: ',', header: true, lineEnding: 'lf', bom: false },
    ...over,
  })
  const w = docWriter(out, req)
  for (const d of docs) await w.write(d)
  const end = await w.end()
  out.end()
  return { text: Buffer.concat(chunks).toString('utf8'), omitted: end.omittedFields }
}

describe('arrays in a CSV export (W4.2)', () => {
  it('keeps an array as one JSON cell by default', async () => {
    const { text } = await csvOf([{ n: new Int32(1), tags: ['a', 'b'] }])
    expect(text).toBe('n,tags\n1,"[""a"",""b""]"\n')
  })

  it('expands arrays to one column per element, up to the bound, and reports the rest', async () => {
    const { text, omitted } = await csvOf(
      [
        { n: 1, tags: ['a', 'b'] },
        { n: 2, tags: ['c', 'd', 'e', 'f'] },
        { n: 3, tags: 'solo' },
      ],
      { arrays: { mode: 'index', max: 3 } },
    )
    expect(text).toBe('n,tags.0,tags.1,tags.2\n1,a,b,\n2,c,d,e\n3,,,\n')
    expect(omitted).toEqual(['tags.3', 'tags'])
  })

  it('expands chosen columns too, keeping their order', async () => {
    const { text } = await csvOf([{ a: [1, 2], b: 'x', c: [true] }], {
      fields: ['c', 'b', 'a'],
      arrays: { mode: 'index', max: 10 },
    })
    expect(text).toBe('c.0,b,a.0,a.1\ntrue,x,1,2\n')
  })

  it('joins the elements with the separator, each as its own text', async () => {
    const id = new ObjectId('5f1d7f1c2b3a4c5d6e7f8091')
    const { text } = await csvOf(
      [{ tags: ['a', 'b,c'], ids: [id], mixed: [1, { x: 1 }, null, new Date('2026-10-16T00:00:00Z')] }],
      { arrays: { mode: 'join', separator: ' | ' } },
    )
    expect(text).toBe(
      'tags,ids,mixed\n"a | b,c",5f1d7f1c2b3a4c5d6e7f8091,"1 | {""x"":1} |  | 2026-10-16T00:00:00.000Z"\n',
    )
  })

  it('guards a joined cell against spreadsheet formulas (T13)', async () => {
    const { text } = await csvOf([{ f: ['=cmd()', 'x'] }], { arrays: { mode: 'join', separator: ';' } })
    expect(text).toBe("f\n'=cmd();x\n")
  })

  it('keeps a masked value as *** in each mode (spec §8.1)', async () => {
    const doc = { tags: ['***', '***'], secret: '***' }
    expect((await csvOf([doc], { arrays: { mode: 'join', separator: ',' } })).text).toBe(
      'tags,secret\n"***,***",***\n',
    )
    expect((await csvOf([doc], { arrays: { mode: 'index', max: 5 } })).text).toBe(
      'tags.0,tags.1,secret\n***,***,***\n',
    )
  })

  it('bounds the options it takes', () => {
    const parse = (arrays: unknown) =>
      ExportRequestSchema.safeParse({ source: { kind: 'collection' }, format: 'csv', arrays }).success
    expect(parse({ mode: 'index', max: 0 })).toBe(false)
    expect(parse({ mode: 'index', max: 101 })).toBe(false)
    expect(parse({ mode: 'join', separator: '' })).toBe(false)
    expect(parse({ mode: 'join', separator: 'x'.repeat(17) })).toBe(false)
    expect(parse({ mode: 'join', separator: '\0' })).toBe(false)
    expect(parse({ mode: 'join', separator: ' / ' })).toBe(true)
  })

  it('never makes more columns than an export may have', async () => {
    const wide: Document = {}
    for (let i = 0; i < 20; i++) wide[`f${i}`] = Array.from({ length: 100 }, (_, j) => j)
    const { text, omitted } = await csvOf([wide], { arrays: { mode: 'index', max: 100 } })
    expect(text.split('\n')[0]!.split(',')).toHaveLength(1000)
    expect(omitted.length).toBeGreaterThan(0)
  })
})
