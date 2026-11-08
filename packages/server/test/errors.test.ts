// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError, Errors } from '../src/errors'
import { parseInput } from '../src/validate'

describe('AppError', () => {
  it('renders an ApiErrorBody without undefined fields', () => {
    expect(Errors.notFound('Nope').toBody()).toEqual({ code: 'NOT_FOUND', message: 'Nope' })
    expect(Errors.rateLimited(1500).toBody('req-1')).toEqual({
      code: 'RATE_LIMITED',
      message: 'Too many requests; try again later',
      details: { retryAfterMs: 1500 },
      correlationId: 'req-1',
    })
  })

  it('carries HTTP status codes', () => {
    expect(Errors.validation('x').statusCode).toBe(400)
    expect(Errors.unauthenticated().statusCode).toBe(401)
    expect(Errors.forbidden().statusCode).toBe(403)
    expect(Errors.readOnly().statusCode).toBe(403)
    expect(Errors.notFound().statusCode).toBe(404)
    expect(Errors.conflict('x').statusCode).toBe(409)
    expect(Errors.payloadTooLarge().statusCode).toBe(413)
    expect(Errors.rateLimited(1).statusCode).toBe(429)
    expect(Errors.forbidden()).toBeInstanceOf(AppError)
  })
})

describe('parseInput', () => {
  it('returns parsed data', () => {
    expect(parseInput(z.object({ n: z.coerce.number() }), { n: '5' })).toEqual({ n: 5 })
  })

  it('throws VALIDATION_ERROR with issue paths', () => {
    try {
      parseInput(z.object({ a: z.object({ b: z.string() }) }), { a: { b: 1 } })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe('VALIDATION_ERROR')
      expect((e as AppError).details).toEqual([{ path: 'a.b', message: expect.any(String) }])
    }
  })
})
