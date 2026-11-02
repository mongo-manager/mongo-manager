import { describe, expect, it } from 'vitest'
import { contextAt, shapeCompletion } from '../src/ds/code/shape'
/** Applies a shaped completion where the word starts, as the editor does, and marks the caret with |. */
function complete(before: string, after: string, label: string, kind: 'field' | 'operator' | 'constructor') {
  const word = /[$\w.]*$/.exec(before)![0]
  const start = before.length - word.length
  const ctx = contextAt(before.slice(0, start))
  const { text, caret } = shapeCompletion({ label, kind }, ctx, after)
  return `${before.slice(0, start)}${text.slice(0, caret)}|${text.slice(caret)}${after}`
}

describe('where the caret is (UI redesign R1 review: completion)', () => {
  it('knows the top level, a key position and a value position with its key', () => {
    expect(contextAt('')).toMatchObject({ depth: 0, position: 'top' })
    expect(contextAt('{ ')).toMatchObject({ depth: 1, position: 'key' })
    expect(contextAt('{ a: 1, ')).toMatchObject({ position: 'key' })
    expect(contextAt('{ status: ')).toMatchObject({ position: 'value', key: 'status' })
    expect(contextAt('{ "customer.city": ')).toMatchObject({ position: 'value', key: 'customer.city' })
    expect(contextAt('{ total: { $gt: ')).toMatchObject({ position: 'value', key: 'total' })
    // Reviewer B Minor 9: a field inside a document is named by its whole path.
    expect(contextAt('{ address: { city: ')).toMatchObject({ position: 'value', key: 'address.city' })
    expect(contextAt('{ items: { $elemMatch: { qty: { $gt: ')).toMatchObject({ key: 'items.qty' })
    expect(contextAt('{ $or: [{ status: ')).toMatchObject({ position: 'value', key: 'status' })
    expect(contextAt('{ status: { $in: [')).toMatchObject({ position: 'value', key: 'status' })
    expect(contextAt('{ status: { $in: ["a", ')).toMatchObject({ position: 'value', key: 'status' })
    expect(contextAt('{ $or: [')).toMatchObject({ position: 'element' })
    expect(contextAt('{ $or: [{ a: 1 }, ')).toMatchObject({ position: 'element' })
  })

  it('ignores braces, colons and commas inside strings', () => {
    expect(contextAt('{ note: "a, b: {" , ')).toMatchObject({ depth: 1, position: 'key' })
  })
})

describe('shaping a completion (the user saw "unknown identifier name")', () => {
  it('wraps a field chosen in an empty filter in braces, ready for its value', () => {
    expect(complete('na', '', 'name', 'field')).toBe('{ name: | }')
  })

  it('adds the colon after a key, and quotes a dotted path', () => {
    expect(complete('{ na', ' }', 'name', 'field')).toBe('{ name: | }')
    expect(complete('{ customer.ci', ' }', 'customer.city', 'field')).toBe('{ "customer.city": | }')
    expect(complete('{ na', ': 1 }', 'name', 'field')).toBe('{ name|: 1 }')
  })

  it('wraps a field chosen as an element of $or in its own document', () => {
    expect(complete('{ $or: [na', '] }', 'name', 'field')).toBe('{ $or: [{ name: | }] }')
  })

  it('gives operators their usual shape', () => {
    expect(complete('{ total: { $g', ' } }', '$gt', 'operator')).toBe('{ total: { $gt: | } }')
    expect(complete('{ status: { $i', ' } }', '$in', 'operator')).toBe('{ status: { $in: [|] } }')
    expect(complete('{ $o', ' }', '$or', 'operator')).toBe('{ $or: [{ | }] }')
    expect(complete('{ note: { $ex', ' } }', '$exists', 'operator')).toBe('{ note: { $exists: true| } }')
    expect(complete('{ total: $g', ' }', '$gt', 'operator')).toBe('{ total: { $gt: | } }')
    expect(complete('$o', '', '$or', 'operator')).toBe('{ $or: [{ | }] }')
  })

  it('opens a constructor with its argument ready', () => {
    expect(complete('{ _id: Obj', ' }', 'ObjectId', 'constructor')).toBe('{ _id: ObjectId("|") }')
    expect(complete('{ n: NumberI', ' }', 'NumberInt', 'constructor')).toBe('{ n: NumberInt(|) }')
    expect(complete('{ k: MinK', ' }', 'MinKey', 'constructor')).toBe('{ k: MinKey()| }')
  })
})

describe('a field name holding the caret mark (reviewer B Minor 10)', () => {
  it('is inserted whole, with the caret after it', () => {
    const shaped = shapeCompletion(
      { label: 'a|b', kind: 'field' },
      { depth: 1, position: 'key', key: null },
      '',
    )
    expect(shaped.text).toBe('"a|b": ')
    expect(shaped.caret).toBe('"a|b": '.length)
  })
})
