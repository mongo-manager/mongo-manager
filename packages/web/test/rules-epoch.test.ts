import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'
import { keepPreviousShownFor, rulesChanged, type KeepPrevious } from '../src/masking/rulesEpoch'

/**
 * Review of 2026-10-26 (I2): a page is kept as the next one's placeholder only if the read that
 * brought it began after the personal data rules last changed — not landed after (a read begun
 * before answers what the rules hid then), and never by the clock.
 */
const held = () => {
  let answer: (v: unknown) => void = () => {}
  const promise = new Promise((resolve) => (answer = resolve))
  return { promise, answer: (v: unknown) => answer(v) }
}

describe('keepPreviousShownFor', () => {
  it('keeps a page read since the rules last changed', async () => {
    const client = new QueryClient()
    const keep = keepPreviousShownFor(client) as unknown as { value: KeepPrevious }
    rulesChanged()
    await client.fetchQuery({ queryKey: ['p', 1], queryFn: () => ({ rows: 1 }) })
    const query = client.getQueryCache().find({ queryKey: ['p', 1] })!
    expect(keep.value({ rows: 1 }, query)).toEqual({ rows: 1 })
  })

  it('lets go of a page whose read began before the rules changed, though it landed after', async () => {
    const client = new QueryClient()
    const keep = keepPreviousShownFor(client) as unknown as { value: KeepPrevious }
    const read = held()
    const fetching = client.fetchQuery({ queryKey: ['p', 2], queryFn: () => read.promise })
    rulesChanged()
    read.answer({ rows: 2 })
    await fetching
    const query = client.getQueryCache().find({ queryKey: ['p', 2] })!
    expect(keep.value({ rows: 2 }, query)).toBeUndefined()
  })

  it('lets go of a page read before, and of one set by hand, once the rules changed', async () => {
    const client = new QueryClient()
    const keep = keepPreviousShownFor(client) as unknown as { value: KeepPrevious }
    await client.fetchQuery({ queryKey: ['p', 3], queryFn: () => ({ rows: 3 }) })
    client.setQueryData(['p', 4], { rows: 4 })
    rulesChanged()
    const cache = client.getQueryCache()
    expect(keep.value({ rows: 3 }, cache.find({ queryKey: ['p', 3] }))).toBeUndefined()
    expect(keep.value({ rows: 4 }, cache.find({ queryKey: ['p', 4] }))).toBeUndefined()
  })

  it('lets go of a page read since the change but then set by hand (a request’s answer, of any age)', async () => {
    const client = new QueryClient()
    const keep = keepPreviousShownFor(client) as unknown as { value: KeepPrevious }
    rulesChanged()
    await client.fetchQuery({ queryKey: ['p', 5], queryFn: () => ({ rows: 5 }) })
    client.setQueryData(['p', 5], { rows: 6 })
    expect(keep.value({ rows: 6 }, client.getQueryCache().find({ queryKey: ['p', 5] }))).toBeUndefined()
  })

  it('is a new function at each change, so TanStack works its placeholder out again', () => {
    const keep = keepPreviousShownFor(new QueryClient())
    const before = keep.value
    rulesChanged()
    expect(keep.value).not.toBe(before)
  })
})
