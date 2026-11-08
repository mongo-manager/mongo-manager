// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import type { Document } from 'bson'
import { ExportRequestSchema } from '@mongo-manager/shared'
import { docWriter } from '../src/transfer/writers'

/**
 * Data review 2026-10-13 (M3): a CSV, XLSX or SQL export took its columns from the first document
 * only, and reported only top-level fields left out — a.c after a first {a:{b}}, a text where a
 * sub-document was, a key holding a dot were lost without a word. Columns now come from the
 * documents sampled first; what no column holds is reported by its path.
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

describe('CSV columns of an export', () => {
  it('takes its columns from the documents sampled, not the first alone', async () => {
    const { text, omitted } = await csvOf([{ a: { b: 1 } }, { a: { b: 2, c: 3 } }, { 'x.y': 5 }])
    expect(text).toBe('a.b,a.c,x.y\n1,,\n2,3,\n,,5\n')
    expect(omitted).toEqual([])
  })

  it('reports by its path what no column holds', async () => {
    const { text, omitted } = await csvOf(
      [
        { a: { b: 1 }, keep: 1 },
        { a: 'text', keep: 2 },
        { a: { b: 2 }, deep: { x: { y: 1 } } },
      ],
      {
        fields: ['a.b', 'keep'],
      },
    )
    expect(text).toBe('a.b,keep\n1,1\n,2\n2,\n')
    expect(omitted).toEqual(['a', 'deep'])
  })

  it('keeps an array whose elements were chosen as covered', async () => {
    const { omitted } = await csvOf([{ tags: ['a', 'b'], n: 1 }], { fields: ['tags.0', 'tags.1', 'n'] })
    expect(omitted).toEqual([])
  })

  // Review of the fix (Minor 1): an element no column holds, and a value another one shadows.
  it('names an array element no column holds, and a nested value a dotted key hides', async () => {
    const partly = await csvOf([{ tags: ['a', 'b'], n: 1 }], { fields: ['tags.0', 'n'] })
    expect(partly.omitted).toEqual(['tags.1'])
    const shadowed = await csvOf([{ x: { y: 1 }, 'x.y': 2 }])
    expect(shadowed.text).toBe('x.y\n2\n')
    expect(shadowed.omitted).toEqual(['x.y'])
  })
})
