import { describe, expect, it } from 'vitest'
import { SchemaAnalyser, type SchemaAnalysis } from '@mongo-manager/shared'
import { ObjectId } from 'mongodb'
import { collectionsNamed, inferReferences, lookupsIn, modelFields, referenceBase } from '../src/model/infer'

const analyse = (docs: object[]): SchemaAnalysis => {
  const a = new SchemaAnalyser()
  for (const d of docs) a.add(d as Record<string, unknown>)
  return a.result()
}

describe('the data model’s inference (completion W6.4)', () => {
  it('reads a reference’s base from the field name, never from a word that merely ends in "id"', () => {
    expect(referenceBase('userId')).toEqual({ base: 'user', many: false })
    expect(referenceBase('user_id')).toEqual({ base: 'user', many: false })
    expect(referenceBase('authorIds')).toEqual({ base: 'author', many: true })
    expect(referenceBase('customer_ids')).toEqual({ base: 'customer', many: true })
    expect(referenceBase('orderID')).toEqual({ base: 'order', many: false })
    for (const word of ['paid', 'valid', '_id', 'id', 'Id', 'uuid', 'userid', 'grid'])
      expect(referenceBase(word), word).toBeNull()
  })

  it('finds the collection a base names, singular or plural, in any case or separator', () => {
    const names = ['users', 'Categories', 'boxes', 'people', 'order_items', 'audit']
    expect(collectionsNamed('user', names)).toEqual(['users'])
    expect(collectionsNamed('category', names)).toEqual(['Categories'])
    expect(collectionsNamed('box', names)).toEqual(['boxes'])
    expect(collectionsNamed('person', names)).toEqual(['people'])
    expect(collectionsNamed('orderItem', names)).toEqual(['order_items'])
    expect(collectionsNamed('audit', names)).toEqual(['audit'])
    expect(collectionsNamed('nothing', names)).toEqual([])
  })

  it('lists the top level and the nested fields that matter, masked ones by name only', () => {
    const analysis = analyse([
      {
        _id: new ObjectId(),
        name: 'a',
        address: { city: 'x', geo: { lat: 1, lng: 2 } },
        items: [{ productId: new ObjectId(), qty: 1, meta: { deep: { sellerId: new ObjectId() } } }],
      },
    ])
    analysis.fields.push({ path: 'ssn', keys: ['ssn'], count: 1, types: {}, masked: true })
    const { fields, moreFields } = modelFields(analysis)
    const paths = fields.map((f) => f.path)
    expect(paths).toEqual(
      expect.arrayContaining(['_id', 'name', 'address', 'address.city', 'items', 'items[].productId', 'ssn']),
    )
    // Deeper than two levels only when it is a reference (to 4).
    expect(paths).not.toContain('address.geo.lat')
    expect(paths).toContain('items[].meta.deep.sellerId')
    expect(paths[0]).toBe('_id')
    expect(fields.find((f) => f.path === 'ssn')).toEqual({ path: 'ssn', types: [], share: 1, masked: true })
    expect(fields.find((f) => f.path === '_id')).toMatchObject({ types: ['objectId'], share: 1 })
    expect(moreFields).toBeGreaterThan(0)
  })

  it('finds $lookup and $graphLookup joins, nested pipelines on their own collection, never other databases', () => {
    const stages = [
      { $match: { status: 'A' } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
      {
        $lookup: {
          from: 'products',
          as: 'p',
          pipeline: [{ $lookup: { from: 'vendors', localField: 'vendorId', foreignField: '_id', as: 'v' } }],
        },
      },
      { $lookup: { from: { db: 'other', coll: 'x' }, localField: 'a', foreignField: '_id', as: 'x' } },
      { $lookup: { from: { db: 'shop', coll: 'tags' }, localField: 'tagIds', foreignField: '_id', as: 't' } },
      {
        $facet: {
          a: [
            {
              $graphLookup: {
                from: 'staff',
                startWith: '$managerId',
                connectFromField: 'managerId',
                connectToField: '_id',
                as: 'chain',
              },
            },
          ],
        },
      },
      {
        $unionWith: {
          coll: 'archive',
          pipeline: [{ $lookup: { from: 'users', localField: 'ownerId', foreignField: '_id', as: 'o' } }],
        },
      },
    ]
    expect(lookupsIn(stages, 'orders', 'shop')).toEqual([
      { from: 'orders', field: 'userId', to: 'users', toField: '_id' },
      { from: 'products', field: 'vendorId', to: 'vendors', toField: '_id' },
      { from: 'orders', field: 'tagIds', to: 'tags', toField: '_id' },
      { from: 'orders', field: 'managerId', to: 'staff', toField: '_id' },
      { from: 'archive', field: 'ownerId', to: 'users', toField: '_id' },
    ])
    // Hostile shapes are read as nothing.
    expect(
      lookupsIn([{ $lookup: { from: 7, localField: {}, foreignField: null } }, null, 'x'], 'o', 'd'),
    ).toEqual([])
    const deep: Record<string, unknown> = {}
    let at = deep
    for (let i = 0; i < 500; i++) {
      const next = {}
      at.$facet = { a: [next] }
      at = next
    }
    expect(() => lookupsIn([deep], 'o', 'd')).not.toThrow()
  })

  it('infers references by name, by sampled values and by $lookup, merged, within the check budget', async () => {
    const users = [new ObjectId(), new ObjectId()]
    const orders = analyse([
      { _id: new ObjectId(), userId: users[0], buyer: users[1], tagIds: [new ObjectId()] },
      { _id: new ObjectId(), userId: users[1], buyer: users[0], tagIds: [new ObjectId()] },
    ])
    const people = analyse(users.map((_id) => ({ _id })))
    const checks: Array<{ target: string; values: string[] }> = []
    const refs = await inferReferences({
      collections: [
        { name: 'orders', type: 'collection', analysis: orders },
        { name: 'recent', type: 'view', analysis: null },
        { name: 'users', type: 'collection', analysis: people },
        { name: 'tags', type: 'collection', analysis: analyse([]) },
      ],
      lookups: [{ from: 'orders', field: 'tagIds', to: 'tags', toField: '_id' }],
      check: async (target, values) => {
        checks.push({ target, values })
        return target === 'users' ? values.filter((v) => users.some((u) => u.toHexString() === v)).length : 0
      },
      budget: 60,
    })
    const by = (field: string) => refs.find((r) => r.from === 'orders' && r.field === field)
    expect(by('userId')).toMatchObject({
      to: 'users',
      toField: '_id',
      sources: ['name', 'values'],
      many: false,
    })
    expect(by('userId')!.overlap).toEqual({ checked: 2, found: 2 })
    // "buyer" names nothing, but its values are users' _ids.
    expect(by('buyer')).toMatchObject({ to: 'users', sources: ['values'] })
    expect(by('tagIds')).toMatchObject({ to: 'tags', sources: ['name', 'lookup'], many: true })
    // A view is never a target; values are only ever hex ObjectIds; the budget holds.
    expect(checks.every((c) => c.target !== 'recent')).toBe(true)
    expect(checks.flatMap((c) => c.values).every((v) => /^[0-9a-f]{24}$/.test(v))).toBe(true)
    checks.length = 0
    await inferReferences({
      collections: [
        { name: 'orders', type: 'collection', analysis: orders },
        { name: 'users', type: 'collection', analysis: people },
      ],
      lookups: [],
      check: async (target, values) => (checks.push({ target, values }), 0),
      budget: 1,
    })
    expect(checks).toHaveLength(1)
  })

  it('never checks the values of a masked field, and keeps it by name', async () => {
    const orders = analyse([{ _id: new ObjectId(), userId: new ObjectId() }])
    const field = orders.fields.find((f) => f.path === 'userId')!
    // Defence in depth: even with values left on it, a masked field's are never checked.
    Object.assign(field, { types: {}, masked: true })
    expect(field.top?.length).toBe(1)
    const checks: string[] = []
    const refs = await inferReferences({
      collections: [
        { name: 'orders', type: 'collection', analysis: orders },
        { name: 'users', type: 'collection', analysis: analyse([]) },
      ],
      lookups: [],
      check: async (target) => (checks.push(target), 1),
      budget: 60,
    })
    expect(checks).toEqual([])
    expect(refs).toEqual([
      { from: 'orders', field: 'userId', to: 'users', toField: '_id', sources: ['name'], many: false },
    ])
  })
})
