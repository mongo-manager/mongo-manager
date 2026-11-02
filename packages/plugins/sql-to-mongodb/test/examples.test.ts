import { describe, expect, it } from 'vitest'
import { EXAMPLE_IDS, examples, quoteName } from '../src/examples'
import { translate } from '../src/translate'

const ORDERS = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a01' },
    status: 'shipped',
    total: { $numberInt: '120' },
    customerId: { $oid: '65a1b2c3d4e5f60718293a11' },
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a02' },
    status: 'paid',
    total: 80.5,
    customerId: { $oid: '65a1b2c3d4e5f60718293a12' },
  },
  { _id: { $oid: '65a1b2c3d4e5f60718293a03' }, status: 'shipped', total: { $numberInt: '42' }, note: 'a\nb' },
]

describe('examples for the open collection (plugin tabs redesign §2.2)', () => {
  it('offers each kind, every one of them a SELECT the translator takes', () => {
    for (const sample of [[], ORDERS])
      for (const coll of ['orders', null, 'my orders', 'order', 'we`ird']) {
        const list = examples(coll, sample)
        expect(list.map((e) => e.id)).toEqual(EXAMPLE_IDS)
        for (const e of list) expect(() => translate(e.sql), e.sql).not.toThrow()
      }
  })

  it('reads FROM the open collection', () => {
    for (const e of examples('my orders', [])) expect(translate(e.sql).collection).toBe('my orders')
  })

  it('uses the fields and values a sample holds', () => {
    const byId = Object.fromEntries(examples('orders', ORDERS).map((e) => [e.id, e.sql]))
    expect(byId.filter).toContain("WHERE status = 'shipped'")
    expect(byId.filter).toContain('ORDER BY total DESC')
    expect(byId.in).toContain("IN ('shipped', 'paid')")
    expect(byId.like).toContain("LIKE 'sh%'")
    expect(byId.group).toContain('GROUP BY status')
    expect(byId.join).toContain('JOIN customers')
    expect(byId.join).toContain('customerId')
  })

  it('prefers a field whose values repeat: it groups and filters better than a unique one', () => {
    const sample = [
      { name: 'Ada', city: 'Izmir' },
      { name: 'Grace', city: 'Izmir' },
      { name: 'Linus', city: 'Bursa' },
      { name: 'Ken' },
    ]
    const group = examples('people', sample).find((e) => e.id === 'group')!.sql
    expect(group).toContain('GROUP BY city')
    expect(examples('people', sample).find((e) => e.id === 'in')!.sql).toContain("IN ('Izmir', 'Bursa')")
  })

  it('quotes a value with a quote in it, and leaves out a value spread over lines', () => {
    const sample = [{ city: "O'Hare" }, { city: "O'Hare" }]
    const sql = examples('t', sample).find((e) => e.id === 'filter')!.sql
    expect(sql).toContain("city = 'O''Hare'")
    expect(translate(sql)).toMatchObject({ filter: { city: "O'Hare" } })
  })

  it('falls back to plain names without a sample', () => {
    const byId = Object.fromEntries(examples('orders', []).map((e) => [e.id, e.sql]))
    expect(byId.group).toContain('GROUP BY status')
  })
})

describe('names in SQL', () => {
  it('quotes what is not a plain word, or is a keyword', () => {
    expect(quoteName('orders')).toBe('orders')
    expect(quoteName('şehir_2')).toBe('şehir_2')
    expect(quoteName('my orders')).toBe('`my orders`')
    expect(quoteName('order')).toBe('`order`')
    expect(quoteName('we`ird')).toBe('`we``ird`')
    expect(quoteName('a.b')).toBe('`a.b`')
  })
})
