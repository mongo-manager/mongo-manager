// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { MAX_SNIPPET_PARAMS, SnippetBodySchema, SnippetUpdateSchema } from '../src/api/snippets'

/** Phase 3a-2 spec §3.5: a snippet as saved — its template and parameters must agree. */
const base = {
  name: 'Top customers',
  code: 'db.orders.find({ total: { $gt: {{ min }} } }).limit({{limit}})',
  params: [
    { name: 'min', type: 'number', default: '100' },
    { name: 'limit', type: 'number' },
  ],
}

describe('SnippetBodySchema', () => {
  it('accepts a template whose placeholders are all declared (inner spaces allowed)', () => {
    const r = SnippetBodySchema.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.shared).toBe(false)
      expect(r.data.tags).toEqual([])
      expect(r.data.params.every((p) => p.required === false)).toBe(true)
    }
  })

  it('refuses a placeholder that is not declared', () => {
    expect(SnippetBodySchema.safeParse({ ...base, params: [base.params[0]] }).success).toBe(false)
  })

  it('refuses duplicate parameter names', () => {
    expect(
      SnippetBodySchema.safeParse({ ...base, params: [...base.params, { name: 'min', type: 'string' }] })
        .success,
    ).toBe(false)
  })

  it('refuses a default that is not valid for its type', () => {
    expect(
      SnippetBodySchema.safeParse({
        ...base,
        params: [{ name: 'min', type: 'number', default: 'abc' }, base.params[1]],
      }).success,
    ).toBe(false)
  })

  it('refuses too many parameters, too much code, a blank name and unknown fields', () => {
    const params = Array.from({ length: MAX_SNIPPET_PARAMS + 1 }, (_, i) => ({
      name: `p${i}`,
      type: 'string',
    }))
    expect(SnippetBodySchema.safeParse({ ...base, code: 'print(1)', params }).success).toBe(false)
    expect(
      SnippetBodySchema.safeParse({ ...base, code: 'x'.repeat(64 * 1024 + 1), params: [] }).success,
    ).toBe(false)
    expect(SnippetBodySchema.safeParse({ ...base, name: '   ' }).success).toBe(false)
    expect(SnippetBodySchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(
      SnippetBodySchema.safeParse({ ...base, params: [{ ...base.params[0], extra: 1 }, base.params[1]] })
        .success,
    ).toBe(false)
  })

  it('refuses a parameter name that is not a parameter name', () => {
    expect(
      SnippetBodySchema.safeParse({ ...base, code: 'print(1)', params: [{ name: 'a-b', type: 'string' }] })
        .success,
    ).toBe(false)
  })
})

describe('SnippetUpdateSchema', () => {
  it('leaves tags out when they are not sent', () => {
    const r = SnippetUpdateSchema.safeParse(base)
    expect(r.success && r.data.tags).toBeUndefined()
  })
})

describe('placeholder positions (final review I1)', () => {
  it('refuses to save a placeholder inside a string', () => {
    const r = SnippetBodySchema.safeParse({
      name: 'x',
      code: 'db.c.find({ name: "{{s}}" })',
      params: [{ name: 's', type: 'string' }],
    })
    expect(r.success).toBe(false)
    expect(r.success ? '' : r.error.issues.map((i) => i.message).join(' ')).toMatch(/\{\{s\}\}.*value/)
  })
})
