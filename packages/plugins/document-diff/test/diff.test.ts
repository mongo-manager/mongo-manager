import { describe, expect, it } from 'vitest'
import { changesAsJson, diffDocuments, idInput, parseId } from '../src/diff'

const int = (n: number) => ({ $numberInt: String(n) })

describe('two documents, field by field (document diff)', () => {
  it('finds added, removed and changed fields, nested objects by field', () => {
    const diff = diffDocuments(
      { _id: int(1), name: 'Ada', age: int(36), address: { city: 'Izmir', zip: '35' }, old: true },
      { _id: int(2), name: 'Ada', age: int(37), address: { city: 'Ankara', zip: '35' }, extra: null },
    )
    expect(diff.changes).toEqual([
      { path: 'age', kind: 'changed', left: int(36), right: int(37) },
      { path: 'address.city', kind: 'changed', left: 'Izmir', right: 'Ankara' },
      { path: 'old', kind: 'removed', left: true },
      { path: 'extra', kind: 'added', right: null },
    ])
    expect(diff.same).toEqual([
      { path: 'name', value: 'Ada' },
      { path: 'address.zip', value: '35' },
    ])
  })

  it('compares arrays by index, and a type change is a change', () => {
    const diff = diffDocuments(
      { tags: ['a', 'b', 'c'], n: int(5), when: { $date: { $numberLong: '0' } } },
      { tags: ['a', 'x'], n: { $numberDouble: '5.0' }, when: { $date: { $numberLong: '0' } } },
    )
    expect(diff.changes).toEqual([
      { path: 'tags.1', kind: 'changed', left: 'b', right: 'x' },
      { path: 'tags.2', kind: 'removed', left: 'c' },
      { path: 'n', kind: 'changed', left: int(5), right: { $numberDouble: '5.0' } },
    ])
    expect(diff.same.map((s) => s.path)).toEqual(['tags.0', 'when'])
  })

  it('treats an object and an array, or a value and an object, as a change of the whole', () => {
    expect(diffDocuments({ a: { b: 1 } }, { a: [1] }).changes).toEqual([
      { path: 'a', kind: 'changed', left: { b: 1 }, right: [1] },
    ])
    expect(diffDocuments({ a: 'x' }, { a: { b: 1 } }).changes).toEqual([
      { path: 'a', kind: 'changed', left: 'x', right: { b: 1 } },
    ])
  })

  it('reports nothing for equal documents, and the changes as JSON to copy', () => {
    expect(diffDocuments({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2 }] }).changes).toEqual([])
    const json = changesAsJson(diffDocuments({ a: 1 }, { a: 2 }))
    expect(JSON.parse(json)).toEqual([{ path: 'a', kind: 'changed', left: 1, right: 2 }])
  })

  it('keeps any field name apart, even those that look like paths or prototypes', () => {
    const left = JSON.parse('{"a.b": 1, "__proto__": {"x": 1}}')
    const right = JSON.parse('{"a.b": 2, "__proto__": {"x": 2}}')
    expect(diffDocuments(left, right).changes.map((c) => c.path)).toEqual(['a.b', '__proto__.x'])
  })
})

describe('an _id as typed (document diff)', () => {
  it('reads an ObjectId, a number, Extended JSON, or else a string', () => {
    expect(parseId('65a1b2c3d4e5f60718293a4b')).toEqual({ $oid: '65a1b2c3d4e5f60718293a4b' })
    expect(parseId(' 42 ')).toEqual({ $numberInt: '42' })
    expect(parseId('9007199254740993')).toEqual({ $numberLong: '9007199254740993' })
    expect(parseId('{"$oid": "65a1b2c3d4e5f60718293a4b"}')).toEqual({ $oid: '65a1b2c3d4e5f60718293a4b' })
    expect(parseId('"42"')).toBe('42')
    expect(parseId('order-7')).toBe('order-7')
    expect(parseId('   ')).toBeNull()
    expect(parseId('{ not json')).toBe('{ not json')
  })

  it('reads a decimal number as a number (review M10)', () => {
    expect(parseId('1.5')).toEqual({ $numberDouble: '1.5' })
    expect(parseId('-2.25')).toEqual({ $numberDouble: '-2.25' })
  })

  it('writes an _id back so that it reads as the same value again (review M10)', () => {
    for (const id of [
      '65a1b2c3d4e5f60718293a4b',
      '42',
      'a"b',
      'order-7',
      { $oid: '65a1b2c3d4e5f60718293a4b' },
      { $numberInt: '42' },
      { $numberLong: '9007199254740993' },
      { $numberDouble: '1.5' },
      { $numberDouble: '5.0' },
      { a: 1 },
    ])
      expect(parseId(idInput(id)), JSON.stringify(id)).toEqual(id)
    expect(idInput({ $oid: '65a1b2c3d4e5f60718293a4b' })).toBe('65a1b2c3d4e5f60718293a4b')
    expect(idInput('order-7')).toBe('"order-7"')
  })
})
