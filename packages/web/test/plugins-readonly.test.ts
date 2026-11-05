// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { assertHandedPipeline, assertNoForbidden, assertReadOnlyPipeline } from '../src/plugins/readOnly'

/** Nested `depth` levels deep, holding `inner` at the bottom. */
const nested = (depth: number, inner: unknown): unknown => {
  let v = inner
  for (let i = 0; i < depth; i++) v = { a: v }
  return v
}
const code = (run: () => unknown) => {
  try {
    run()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'accepted'
}

describe('what a plugin may run or hand the user (wave 1 review: missing tests)', () => {
  it('finds a forbidden operator behind a "__proto__" key, as JSON brings it', () => {
    const stages = JSON.parse('[{"$match":{"__proto__":{"$where":"sleep(1)"}}}]')
    expect(code(() => assertReadOnlyPipeline(stages))).toBe('bad_params')
    expect(code(() => assertHandedPipeline(stages))).toBe('bad_params')
    expect(code(() => assertNoForbidden(JSON.parse('{"__proto__":{"$function":{}}}')))).toBe('bad_params')
  })

  it('refuses what is nested too deeply to look through', () => {
    expect(code(() => assertReadOnlyPipeline([{ $match: nested(30, 1) }]))).toBe('accepted')
    expect(code(() => assertReadOnlyPipeline([{ $match: nested(50, 1) }]))).toBe('bad_params')
    expect(code(() => assertHandedPipeline([{ $match: nested(50, 1) }]))).toBe('bad_params')
    expect(code(() => assertNoForbidden(nested(50, 1)))).toBe('bad_params')
  })

  it('takes reading pipelines in $facet, never a $facet inside one', () => {
    expect(
      code(() => assertReadOnlyPipeline([{ $facet: { a: [{ $match: {} }], b: [{ $count: 'n' }] } }])),
    ).toBe('accepted')
    expect(code(() => assertReadOnlyPipeline([{ $facet: { a: [{ $facet: { b: [] } }] } }]))).toBe(
      'bad_params',
    )
    expect(code(() => assertReadOnlyPipeline([{ $facet: { a: [{ $lookup: {} }] } }]))).toBe('bad_params')
    expect(code(() => assertReadOnlyPipeline([{ $facet: 'x' }]))).toBe('bad_params')
  })
})
