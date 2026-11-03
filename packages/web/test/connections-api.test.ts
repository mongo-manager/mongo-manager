import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionsApi } from '../src/api/connections'
import { ApiError } from '../src/api/client'
import { describeError } from '../src/api/errors'
import { formatBytes, formatCount } from '../src/format'
import { mockApi } from './support/app'

afterEach(() => vi.unstubAllGlobals())

describe('connectionsApi', () => {
  it('encodes names in paths and sends the typed confirmation (Review Focus 4)', async () => {
    const { calls } = mockApi({
      'DELETE connections/c%2F1/databases/a b': () => [204],
      'POST connections/c%2F1/databases/a b/collections/<x>/rename': (body) => [200, body],
      'GET connections/c%2F1/databases/a b/collections/<x>/stats': () => [200, { count: 1 }],
    })
    await connectionsApi.dropDatabase('c/1', 'a b')
    await connectionsApi.renameCollection('c/1', 'a b', '<x>', 'y')
    await connectionsApi.collectionStats('c/1', 'a b', '<x>')
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['DELETE', 'connections/c%2F1/databases/a b', { confirm: 'a b' }],
      ['POST', 'connections/c%2F1/databases/a b/collections/<x>/rename', { to: 'y' }],
      ['GET', 'connections/c%2F1/databases/a b/collections/<x>/stats', undefined],
    ])
  })

  it('tests unsaved settings, reusing stored secrets only for an existing connection', async () => {
    const { calls } = mockApi({ 'POST connections/test': () => [200, { ok: true }] })
    await connectionsApi.test({ hosts: [] })
    await connectionsApi.test({ hosts: [] }, 'c1')
    expect(calls.map((c) => c.body)).toEqual([
      { settings: { hosts: [] } },
      { settings: { hosts: [] }, connectionId: 'c1' },
    ])
  })
})

describe('describeError for MongoDB failures', () => {
  const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`

  it('explains connection kinds and shows sanitised server messages otherwise', () => {
    expect(describeError(new ApiError(502, 'MONGO_ERROR', 'x', { kind: 'network' }), t)).toBe(
      'mongo.kinds.network',
    )
    // Eighth review: a plan reading an index that holds personal data is not explained.
    expect(describeError(new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_index' }), t)).toBe(
      'masking.personalIndex',
    )
    // A full connection pool: the server is fine, every connection to it is in use.
    expect(describeError(new ApiError(503, 'MONGO_ERROR', 'x', { kind: 'pool' }), t)).toBe('mongo.kinds.pool')
    expect(describeError(new ApiError(400, 'MONGO_ERROR', 'Namespace not found', { code: 26 }), t)).toBe(
      'errors.MONGO_ERROR{"message":"Namespace not found"}',
    )
    expect(describeError(new ApiError(409, 'DOCUMENT_CHANGED', 'x'), t)).toBe('errors.DOCUMENT_CHANGED')
  })
})

describe('formatting', () => {
  it('formats sizes and counts for the current language', () => {
    expect(formatBytes(0, 'en')).toBe('0 B')
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
    expect(formatBytes(1536, 'tr')).toBe('1,5 KB')
    expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GB')
    expect(formatBytes(123_456_789, 'en')).toBe('117.7 MB')
    expect(formatCount(1234567, 'tr')).toBe('1.234.567')
  })
})
