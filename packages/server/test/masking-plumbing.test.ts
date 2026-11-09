// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Int32 } from 'mongodb'
import { toWire } from '@mongo-manager/shared'
import { AppError } from '../src/errors'
import { createSecretBox } from '../src/crypto/secret-box'
import { hashDocument } from '../src/data/ejson-io'
import { serverCode, serverError, serverText, toAppError } from '../src/data/mongo-errors'
import { driverWrapped } from './support/driver-wrap'
import { forRestricted } from '../src/masking/errors'
import { RefusalAudit, REFUSALS_PER_MINUTE } from '../src/masking/audit'
import { maskItem } from '../src/masking/present'
import { nsMaskerFrom } from '../src/masking/match'

describe('document pin (phase 3c §4.1, review focus 5)', () => {
  it('is an HMAC: stable for one key, different from a plain SHA-256, different across keys', () => {
    const key = randomBytes(32)
    const doc = { _id: 1, email: 'a@x' }
    const pin = hashDocument(doc, createSecretBox(key).derive('mm-doc-pin-v1'), 'crm.users')
    expect(pin).toBe(hashDocument(doc, createSecretBox(key).derive('mm-doc-pin-v1'), 'crm.users'))
    expect(pin).not.toBe(createHash('sha256').update(toWire(doc)).digest('hex'))
    expect(pin).not.toBe(
      hashDocument(doc, createSecretBox(randomBytes(32)).derive('mm-doc-pin-v1'), 'crm.users'),
    )
  })
})

describe('errors for a restricted user (phase 3c §4.7)', () => {
  const mongo = (props: Record<string, unknown>) =>
    Object.assign(new Error(String(props.message)), { name: 'MongoServerError', ...props })

  it('drops the duplicate key value, keeps the index and field names', () => {
    const e = toAppError(
      mongo({
        code: 11000,
        message: 'E11000 index: email_1 dup key: { email: "S3NT1N3L" }',
        keyValue: { email: 'S3NT1N3L' },
        keyPattern: { email: 1 },
      }),
    ) as AppError
    const shown = forRestricted(e)
    expect(JSON.stringify(shown.toBody())).not.toContain('S3NT1N3L')
    expect(shown.details).toMatchObject({ index: 'email_1', fields: ['email'], hidden: true })
  })

  it('replaces a free-text MongoDB message with its code', () => {
    const e = toAppError(
      mongo({ code: 241, codeName: 'ConversionFailure', message: "Failed to parse number 'S3NT1N3L'" }),
    ) as AppError
    const shown = forRestricted(e)
    expect(shown.message).not.toContain('S3NT1N3L')
    expect(shown.details).toMatchObject({ code: 241, codeName: 'ConversionFailure', hidden: true })
  })

  // Review of the agent's gate (nit): a server not available did not refuse: it could not complete.
  it('says a server not there could not complete it, not that it refused', () => {
    const shown = forRestricted(
      toAppError(mongo({ code: 91, codeName: 'ShutdownInProgress', message: 'shutting down' })) as AppError,
    )
    expect(shown.statusCode).toBe(503)
    expect(shown.message).toMatch(/^MongoDB could not complete the operation \(91 ShutdownInProgress\)/)
  })

  // CI 2026-10-23 (MongoDB 6.0; independent review, Important 1): the driver reports any write the
  // server refuses as IllegalOperation (20) as "does not support retryable writes", with the
  // server's own error on originalError: that one is answered — its text, its code.
  it("answers the server's error from under the driver's own wrapper", () => {
    const refused = driverWrapped('Cannot perform a non-multi delete on a time-series collection')
    const open = toAppError(refused) as AppError
    expect(open.message).toBe('Cannot perform a non-multi delete on a time-series collection')
    expect(open.statusCode).toBe(400)
    expect(forRestricted(open).details).toMatchObject({ code: 20, hidden: true })
    expect(serverError(refused)).toBe((refused as { originalError?: unknown }).originalError)
    // Defensive: whatever it wraps is answered as itself (a server not there: 503).
    expect((toAppError(driverWrapped('shutting down', 91)) as AppError).statusCode).toBe(503)
    // An error with a code of its own, or nothing a server raised under it, is left as it is.
    const own = mongo({ code: 2, message: 'BadValue', originalError: mongo({ code: 20, message: 'x' }) })
    expect(serverError(own)).toBe(own)
    const plain = mongo({ message: 'no code', originalError: new Error('not the server') })
    expect(serverError(plain)).toBe(plain)
    // A code under it that is not a MongoDB error is not taken for the server's (second review, Minor 3).
    const odd = mongo({ message: 'wrapped', originalError: { code: 20, message: 'x' } })
    expect(serverError(odd)).toBe(odd)
    expect((toAppError(odd) as AppError).message).toBe('wrapped')
  })

  // Third independent review (nits 4, 7): the server's code and words, for the jobs' reasons.
  it("reads the server's code and words, from under the driver's wrapper too", () => {
    expect(serverCode(driverWrapped())).toBe(20)
    expect(serverCode(mongo({ code: 2, message: 'BadValue' }))).toBe(2)
    expect(serverCode(null)).toBeUndefined()
    expect(serverText(driverWrapped('refused here'))).toBe('refused here')
    expect(serverText(new Error('plain'))).toBe('plain')
    // Something thrown as text is said as itself; anything else with no words of its own, as a
    // refusal (final review, nit 5): never "undefined" nor "[object Object]".
    expect(serverText('thrown text')).toBe('thrown text')
    expect(serverText({ reason: 'x' })).toBe('MongoDB refused the operation')
    expect(serverText(undefined)).toBe('MongoDB refused the operation')
  })

  it('keeps the code when the driver hands it over as a BSON Int32 (reads with promoteValues off)', () => {
    const e = toAppError(
      mongo({ code: new Int32(241), codeName: 'ConversionFailure', message: "Failed to parse number 'x'" }),
    ) as AppError
    expect(forRestricted(e).details).toMatchObject({ code: 241, codeName: 'ConversionFailure' })
  })

  it('leaves errors that carry no MongoDB text alone', () => {
    const e = new AppError('FORBIDDEN', 'no', 403)
    expect(forRestricted(e)).toBe(e)
    const timeout = toAppError(mongo({ code: 50, message: 'operation exceeded time limit' })) as AppError
    expect(forRestricted(timeout)).toBe(timeout)
  })
})

describe('masked document items (phase 3c §4.2)', () => {
  it('masks the document and the _id of an unsupported item, keeps the pin', () => {
    const out = nsMaskerFrom([['email'], ['_id']])
    expect(maskItem({ document: { email: 'a', n: 1 }, hash: 'h' }, out)).toEqual({
      document: { email: '***', n: 1 },
      hash: 'h',
    })
    // Data review 2026-10-13 round 2 (M12): its reason can name a field and quote what it holds.
    expect(
      maskItem({ unsupported: { _id: 'a@x', reason: 'Field "email" holds a date outside the range' } }, out),
    ).toEqual({ unsupported: { _id: '***', reason: 'This document cannot be shown here' } })
  })
})

describe('refusal audit (phase 3c §8)', () => {
  it('logs at most ten refusals a minute per user, then one summary with the next refusal', () => {
    const rows: Array<Record<string, unknown>> = []
    let now = 0
    const audit = new RefusalAudit(
      { append: (r) => void rows.push(r as unknown as Record<string, unknown>) },
      () => now,
    )
    const request = {
      principal: { kind: 'user', userId: 'u1', username: 'u' },
      ip: '1',
      connection: { id: 'c' },
    } as never
    const refusal = new AppError('FORBIDDEN', 'x', 403, {
      reason: 'personal_field',
      field: 'email',
      ns: 'crm.users',
    })
    for (let i = 0; i < 15; i++) audit.refused(request, refusal)
    expect(rows).toHaveLength(REFUSALS_PER_MINUTE)
    expect(rows[0]).toMatchObject({
      action: 'masking.refused',
      outcome: 'denied',
      namespace: 'crm.users',
      details: { reason: 'personal_field', field: 'email' },
    })
    now = 61_000
    audit.refused(request, refusal)
    expect(rows.at(-2)).toMatchObject({ details: { suppressed: 5 } })
    expect(rows).toHaveLength(REFUSALS_PER_MINUTE + 2)
    audit.refused(request, new AppError('FORBIDDEN', 'x', 403))
    expect(rows).toHaveLength(REFUSALS_PER_MINUTE + 2)
  })
})
