import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from '../src/uuid'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => vi.unstubAllGlobals())

describe('randomId (a page over plain http has no crypto.randomUUID)', () => {
  it('gives a version 4 UUID', () => {
    expect(randomId()).toMatch(V4)
  })

  it('still gives one, from random bytes, where randomUUID is missing', () => {
    const { getRandomValues } = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: getRandomValues.bind(globalThis.crypto) })
    const ids = new Set(Array.from({ length: 50 }, () => randomId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(V4)
  })
})
