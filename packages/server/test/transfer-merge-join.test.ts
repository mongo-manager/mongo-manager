import { describe, expect, it } from 'vitest'
import { Int32, Long } from 'mongodb'
import { ordered, diffSample, mergeJoin, sameDocument } from '../src/transfer/merge-join'

async function* from(docs: object[]) {
  for (const d of docs) yield d as never
}
async function all(source: object[], target: object[], ignore: string[][] = []) {
  const out: Array<[string, unknown]> = []
  for await (const e of mergeJoin(from(source), from(target), (a, b) => sameDocument(a, b, ignore)))
    out.push([e.kind, 'source' in e ? e.source._id : e.target._id])
  return out
}

describe('merge join (phase 3d-2 spec §6)', () => {
  it('sorts documents into the four groups', async () => {
    expect(
      await all(
        [
          { _id: 1, a: 1 },
          { _id: 2, a: 1 },
          { _id: 4, a: 1 },
        ],
        [
          { _id: 2, a: 2 },
          { _id: 3, a: 1 },
          { _id: 4, a: 1 },
        ],
      ),
    ).toEqual([
      ['onlySource', 1],
      ['different', 2],
      ['onlyTarget', 3],
      ['same', 4],
    ])
  })

  it('treats numerically equal ids of different types as one id, and field order as a difference', async () => {
    expect(await all([{ _id: new Int32(1), a: 1, b: 2 }], [{ _id: Long.fromNumber(1), b: 2, a: 1 }])).toEqual(
      [['different', new Int32(1)]],
    )
  })

  it('ignores the given paths, inside sub-documents too', async () => {
    expect(
      await all(
        [{ _id: 1, u: 1, m: { at: 1, v: 1 } }],
        [{ _id: 1, u: 2, m: { at: 2, v: 1 } }],
        [['u'], ['m', 'at']],
      ),
    ).toEqual([['same', 1]])
  })

  // Nineteenth review of explain masking (I2): of two equal _ids, neither goes on in storage order.
  it('refuses equal _ids before either is joined', async () => {
    const seen: unknown[] = []
    const stream = ordered(
      (async function* () {
        yield { _id: 1, x: 'first' }
        yield { _id: 1, x: 'second' }
      })(),
      'source',
    )
    await expect(
      (async () => {
        for await (const d of stream) seen.push(d)
      })(),
    ).rejects.toMatchObject({ details: { reason: 'id_duplicate' } })
    expect(seen).toEqual([])
  })

  // Tenth review (I1): MongoDB sorts an array _id by its least element, this join apart.
  it('refuses an array _id before anything is joined', async () => {
    await expect(all([{ _id: 3 }, { _id: [3, 9] }], [])).rejects.toMatchObject({
      details: { reason: 'id_array' },
    })
    await expect(all([], [{ _id: [1] }])).rejects.toMatchObject({ details: { reason: 'id_array' } })
    // The document it ties with is never passed on (eleventh review, nit).
    const seen: unknown[] = []
    const stream = ordered(
      (async function* () {
        yield { _id: 3 }
        yield { _id: [3, 9] }
      })(),
      'source',
    )
    await expect(
      (async () => {
        for await (const d of stream) seen.push(d)
      })(),
    ).rejects.toMatchObject({ details: { reason: 'id_array' } })
    expect(seen).toEqual([])
  })

  it('stops on out-of-order ids', async () => {
    await expect(all([{ _id: 2 }, { _id: 1 }], [])).rejects.toThrow(/order/)
  })

  it('describes a difference field by field, values cut, and says when only the order differs', () => {
    const d = diffSample({ _id: 1, a: 'x'.repeat(500), b: 1 }, { _id: 1, a: 'y', c: 1 }, [])
    expect(d.changes.map((c) => c.path).sort()).toEqual(['a', 'b', 'c'])
    expect(String(d.changes.find((c) => c.path === 'a')!.after).length).toBeLessThanOrEqual(201)
    expect(diffSample({ _id: 1, a: 1, b: 2 }, { _id: 1, b: 2, a: 1 }, []).orderOnly).toBe(true)
  })
})
