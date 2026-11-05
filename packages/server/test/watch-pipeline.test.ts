// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { Int32 } from 'mongodb'
import { WatchOptionsSchema, type WatchTarget } from '@mongo-manager/shared'
import { compileRules } from '../src/masking/match'
import { buildPipeline, filterHash } from '../src/changestreams/pipeline'

const coll: WatchTarget = { connectionId: 'c', scope: 'collection', db: 'shop', coll: 'orders' }
const database: WatchTarget = { connectionId: 'c', scope: 'database', db: 'shop' }
const options = WatchOptionsSchema.parse({})
const rules = compileRules([{ db: 'shop', coll: 'orders', field: 'customer.email' }])
const CREDENTIALS = ['system.users', 'system.keys', 'system.backup_users', 'system.roles']
const DATA = { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete', 'invalidate'] } } }
const reason = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason ?? 'thrown'
  }
  return null
}

describe('the feed’s pipeline (phase 3e-1 spec §1.4)', () => {
  it('is built by the server: credential guard, operation types, then the filter', () => {
    expect(
      buildPipeline({
        target: coll,
        filter: { 'fullDocument.n': { $gt: 1 } },
        options,
        admin: false,
        masker: null,
      }),
    ).toEqual([
      { $match: { 'ns.coll': { $nin: CREDENTIALS }, 'to.coll': { $nin: CREDENTIALS } } },
      DATA,
      // Read as Extended JSON, like every filter: numbers keep their BSON type.
      { $match: { 'fullDocument.n': { $gt: new Int32(1) } } },
    ])
  })

  it('leaves the credential guard out for administrators and the filter out when empty', () => {
    expect(buildPipeline({ target: coll, filter: {}, options, admin: true, masker: null })).toEqual([DATA])
  })

  it('adds the schema operations only with "Include schema changes"', () => {
    const ops = WatchOptionsSchema.parse({ ops: ['insert', 'drop'], schemaChanges: false })
    expect(buildPipeline({ target: coll, filter: {}, options: ops, admin: true, masker: null })).toEqual([
      { $match: { operationType: { $in: ['insert', 'invalidate'] } } },
    ])
    expect(
      buildPipeline({
        target: coll,
        filter: {},
        options: { ...ops, schemaChanges: true },
        admin: true,
        masker: null,
      }),
    ).toEqual([{ $match: { operationType: { $in: ['insert', 'drop', 'invalidate'] } } }])
  })

  it('reads the filter as Extended JSON', () => {
    const [, , stage] = buildPipeline({
      target: coll,
      filter: { 'documentKey._id': { $oid: '64b7f0c2a1b2c3d4e5f60718' } },
      options,
      admin: false,
      masker: null,
    })
    expect(String((stage!.$match as Record<string, unknown>)['documentKey._id'])).toBe(
      '64b7f0c2a1b2c3d4e5f60718',
    )
  })

  it('refuses server-side JavaScript, an oversized or too deep filter (W4, W5)', () => {
    const build = (filter: Record<string, unknown>) => () =>
      buildPipeline({ target: coll, filter, options, admin: true, masker: null })
    expect(reason(build({ $where: 'sleep(1000)' }))).toBe('filter')
    expect(reason(build({ $expr: { $function: { body: 'x', args: [], lang: 'js' } } }))).toBe('filter')
    // Security review 2026-10-16 (I-1): MongoDB's internal JavaScript operators too.
    expect(reason(build({ $expr: { $_internalJsEmit: { eval: 'x', this: '$$ROOT' } } }))).toBe('filter')
    expect(reason(build({ a: 'x'.repeat(12 * 1024) }))).toBe('filter')
    let deep: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 25; i++) deep = { $and: [deep] }
    expect(reason(build(deep))).toBe('filter')
  })

  it('refuses a restricted user’s filter on personal paths at the collection scope (W3)', () => {
    const build = (filter: Record<string, unknown>) => () =>
      buildPipeline({ target: coll, filter, options, admin: false, masker: rules })
    expect(reason(build({ 'fullDocument.customer.email': 'a@x' }))).toBe('personal_field')
    expect(reason(build({ 'fullDocumentBeforeChange.customer.email': 'a@x' }))).toBe('personal_field')
    expect(reason(build({ 'updateDescription.updatedFields.customer.email': 'a@x' }))).toBe('personal_field')
    expect(reason(build({ 'fullDocument.customer': { email: 'a@x' } }))).toBe('personal_field')
    expect(reason(build({ fullDocument: { customer: { email: 'a@x' } } }))).toBe('masking_unsupported')
    expect(reason(build({ $expr: { $eq: ['$fullDocument.n', 1] } }))).toBe('masking_unsupported')
    expect(reason(build({ $or: [{ $expr: { $eq: ['$fullDocument.n', 1] } }] }))).toBe('masking_unsupported')
    expect(reason(build({ 'fullDocument.n': 1, operationType: 'insert' }))).toBeNull()
  })

  it('refuses document paths for a restricted user at the database scope (plan ruling 2)', () => {
    const build = (filter: Record<string, unknown>) => () =>
      buildPipeline({ target: database, filter, options, admin: false, masker: rules })
    expect(reason(build({ 'fullDocument.n': 1 }))).toBe('masking_unsupported')
    expect(reason(build({ 'documentKey._id': 1 }))).toBe('masking_unsupported')
    expect(reason(build({ 'ns.coll': 'orders', operationType: 'update' }))).toBeNull()
  })

  // Security review 2026-10-13 (low): a schema event's description (a validator, an index's partial
  // filter) is masked whole for a restricted user, yet a filter could test its values.
  it('refuses a restricted user’s filter on a schema event’s description', () => {
    for (const target of [coll, database]) {
      const build = (filter: Record<string, unknown>) => () =>
        buildPipeline({ target, filter, options, admin: false, masker: rules })
      expect(reason(build({ 'operationDescription.validator.customer.email': 'a@x' }))).toBe(
        'masking_unsupported',
      )
      expect(reason(build({ $or: [{ 'operationDescription.indexes.partialFilterExpression.n': 1 }] }))).toBe(
        'masking_unsupported',
      )
      expect(reason(build({ operationDescription: { $exists: true } }))).toBe('masking_unsupported')
      expect(reason(build({ 'stateBeforeChange.collectionOptions.validator.n': 1 }))).toBe(
        'masking_unsupported',
      )
    }
    // Nothing is hidden from an unrestricted user: the description may be filtered.
    expect(
      buildPipeline({
        target: coll,
        filter: { 'operationDescription.validator.n': 1 },
        options,
        admin: false,
        masker: null,
      }),
    ).toHaveLength(3)
  })

  it('hashes the filter for the audit, never keeping its values', () => {
    const key = Buffer.alloc(32, 7)
    expect(filterHash({}, key)).toBeNull()
    expect(filterHash({ a: 1 }, key)).toMatch(/^[0-9a-f]{64}$/)
    expect(filterHash({ a: 1 }, key)).toBe(filterHash({ a: 1 }, key))
    // Final review M7: keyed — another key, another name for the same filter.
    expect(filterHash({ a: 1 }, Buffer.alloc(32, 8))).not.toBe(filterHash({ a: 1 }, key))
  })
})
