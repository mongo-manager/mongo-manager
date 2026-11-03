import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, onUnauthenticated, path, setCsrfToken } from '../src/api/client'
import { describeError } from '../src/api/errors'
import { reasonKey, reasonMessage } from '../src/api/reasons'
import { mockApi } from './support/app'

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

describe('path``', () => {
  it('encodes every interpolated segment', () => {
    expect(path`connections/${'a/b?c#d'}/databases/${'shop'}`).toBe(
      'connections/a%2Fb%3Fc%23d/databases/shop',
    )
  })
})

describe('api client', () => {
  it('sends JSON with the CSRF token on mutating requests only', async () => {
    const { calls } = mockApi({
      'GET auth/status': () => [200, { ok: 1 }],
      'POST things': (body) => [200, body],
    })
    setCsrfToken('tok-1')
    expect(await api.get('auth/status')).toEqual({ ok: 1 })
    expect(await api.post('things', { a: 1 })).toEqual({ a: 1 })
    expect(calls[0]!.headers['x-csrf-token']).toBeUndefined()
    expect(calls[1]!.headers).toMatchObject({ 'x-csrf-token': 'tok-1', 'content-type': 'application/json' })
  })

  it('resolves relative to the document base (basePath support)', async () => {
    const { fetchMock } = mockApi({ 'GET auth/status': () => [200, {}] })
    await api.get('auth/status')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:4321/api/auth/status')
  })

  it('turns error bodies into ApiError and signals 401', async () => {
    mockApi({
      'POST x': () => [409, { code: 'CONFLICT', message: 'nope', details: { a: 1 }, correlationId: 'c1' }],
      'GET me': () => [401, { code: 'UNAUTHENTICATED', message: 'x' }],
    })
    const onAuth = vi.fn()
    onUnauthenticated(onAuth)
    await expect(api.post('x', {})).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'nope',
      details: { a: 1 },
      correlationId: 'c1',
    })
    await expect(api.get('me')).rejects.toBeInstanceOf(ApiError)
    expect(onAuth).toHaveBeenCalledTimes(1)
  })

  it('returns undefined for 204', async () => {
    mockApi({ 'POST auth/logout': () => [204] })
    expect(await api.post('auth/logout')).toBeUndefined()
  })
})

describe('describeError', () => {
  const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`

  it('maps codes, overrides, rate limits and network failures', () => {
    expect(describeError(new ApiError(403, 'FORBIDDEN', 'x'), t)).toBe('errors.FORBIDDEN')
    expect(
      describeError(new ApiError(401, 'UNAUTHENTICATED', 'x'), t, { UNAUTHENTICATED: 'login.invalid' }),
    ).toBe('login.invalid')
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterMs: 4200 }), t)).toBe(
      'errors.RATE_LIMITED{"seconds":5}',
    )
    expect(describeError(new TypeError('Failed to fetch'), t)).toBe('errors.NETWORK')
    // Twenty-second review of explain masking (M-1): which target is a view, in the user's words.
    expect(
      describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'target_is_view', collection: 'v1' }), t),
    ).toBe('dataTransfer.errors.target_is_view{"collection":"v1"}')
    expect(
      describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'target_timeseries', collection: 'ts' }), t),
    ).toBe('dataTransfer.errors.target_timeseries{"collection":"ts"}')
    expect(
      describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'replace_timeseries', collection: 'm' }), t),
    ).toBe('dataTransfer.errors.replace_timeseries{"collection":"m"}')
    expect(
      describeError(
        new ApiError(409, 'CONFLICT', 'x', { reason: 'replace_into_timeseries', collection: 'm' }),
        t,
      ),
    ).toBe('dataTransfer.errors.replace_into_timeseries{"collection":"m"}')
    expect(describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'replace_into_timeseries' }), t)).toBe(
      'dataTransfer.errors.replace_into_timeseries_unnamed',
    )
    expect(describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'replace_timeseries' }), t)).toBe(
      'dataTransfer.errors.replace_timeseries_unnamed',
    )
    expect(describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'target_timeseries' }), t)).toBe(
      'dataTransfer.errors.target_timeseries_unnamed',
    )
    expect(describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'target_is_view' }), t)).toBe(
      'dataTransfer.errors.target_is_view_unnamed',
    )
    // Security review 2026-10-13 (M3): a page past the byte cap.
    expect(describeError(new ApiError(400, 'VALIDATION_ERROR', 'x', { reason: 'page_too_large' }), t)).toBe(
      'documents.pageTooLarge',
    )
    // Data review 2026-10-13 (H3, M2): a field the app cannot read back as it is, named, worded by
    // what it holds.
    const notRoundTrip = (kind?: string) =>
      describeError(new ApiError(409, 'CONFLICT', 'x', { reason: 'not_round_trip', kind, field: 'a.b' }), t)
    expect(notRoundTrip('ejson_like')).toBe('documents.notRoundTrip.ejson_like{"field":"a.b"}')
    expect(notRoundTrip('undefined')).toBe('documents.notRoundTrip.undefined{"field":"a.b"}')
    expect(notRoundTrip('too_deep')).toBe('documents.notRoundTrip.too_deep{"field":"a.b"}')
    expect(notRoundTrip('else')).toBe('documents.notRoundTrip.ejson_like{"field":"a.b"}')
    expect(describeError(new ApiError(500, 'INTERNAL', 'x', undefined, 'c9'), t)).toBe(
      'errors.UNKNOWN{"code":"c9"}',
    )
  })

  it('explains personal-data refusals and hidden MongoDB messages (phase 3c)', () => {
    expect(
      describeError(new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_field', field: 'email' }), t),
    ).toBe('masking.personalField{"field":"email"}')
    expect(
      describeError(
        new ApiError(403, 'FORBIDDEN', 'x', { reason: 'masking_unsupported', what: '$where' }),
        t,
      ),
    ).toBe('masking.unsupported{"what":"$where"}')
    expect(
      describeError(
        new ApiError(400, 'MONGO_ERROR', 'x', { hidden: true, code: 2, codeName: 'BadValue' }),
        t,
      ),
    ).toBe('masking.mongoHidden{"code":"2 BadValue"}')
    // A server not available for now could not complete it (review of the agent's gate, M-3).
    expect(
      describeError(
        new ApiError(503, 'MONGO_ERROR', 'x', { hidden: true, code: 91, codeName: 'ShutdownInProgress' }),
        t,
      ),
    ).toBe('masking.mongoHiddenUnavailable{"code":"91 ShutdownInProgress"}')
    expect(
      describeError(
        new ApiError(409, 'CONFLICT', 'x', { hidden: true, index: 'email_1', fields: ['email'] }),
        t,
      ),
    ).toBe('masking.duplicateHidden{"index":"email_1"}')
  })

  it('names the supported MongoDB range for an unsupported server (phase 1h)', () => {
    const e = new ApiError(422, 'UNSUPPORTED_SERVER', 'MongoDB 5.0.26 is not supported.', {
      kind: 'unsupported',
    })
    expect(describeError(e, t)).toBe('mongo.kinds.unsupported{"min":"6.0"}')
  })

  // Review of the open's stop (minor 3): an open the server stopped is no fault of the settings.
  it('says an open was stopped, not that the settings are invalid', () => {
    const e = new ApiError(503, 'MONGO_ERROR', 'The server is shutting down', { kind: 'closed' })
    expect(describeError(e, t)).toBe('mongo.kinds.closed')
  })

  // Sixth review of the open's stop (nit 3): the profiler's refusal has its own words (level 1
  // instead); the per-person reason any other work can meet names no level.
  it('says the profiler’s per-person refusal in its own words', () => {
    const refused = (reason: string) => new ApiError(409, 'CONFLICT', 'x', { reason })
    expect(reasonMessage(refused('oidc_level2'), t)).toBe('connection.reasons.oidc_level2')
    expect(reasonMessage(refused('oidc_per_person'), t)).toBe('connection.reasons.oidc_per_person')
  })

  // Ninth review of the open's stop (minor 7, older than it): a refusal naming no field said
  // "undefined holds personal data"; it says a personal field now.
  it('says a personal-field refusal that names no field without one', () => {
    const refused = (details: object) =>
      new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_field', ...details })
    expect(describeError(refused({}), t)).toBe('masking.personalFieldUnnamed')
    expect(describeError(refused({ field: 'email' }), t)).toBe('masking.personalField{"field":"email"}')
    // Tenth review (nit 2): a refused write naming no field says one without it too.
    const write = new ApiError(403, 'FORBIDDEN', 'x', { reason: 'personal_write' })
    expect(describeError(write, t)).toBe('masking.personalWriteUnnamed')
  })

  // Ninth review (nit 3): a weak password's problems are its own, never an object's keys.
  it('names only the problems of a weak password it knows', () => {
    const weak = new ApiError(400, 'VALIDATION_ERROR', 'x', {
      reason: 'weak_password',
      problems: ['too_short', 'constructor', 'toString'],
    })
    expect(reasonMessage(weak, t)).toBe(
      'security.reasons.weakPassword{"problems":"security.problems.tooShort"}',
    )
  })

  // Eighth review of the open's stop (nit 2): an object's own keys are no reasons.
  it('knows no reason by an object’s own key', () => {
    for (const reason of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(reasonKey(reason), reason).toBeUndefined()
    expect(reasonMessage(new ApiError(409, 'CONFLICT', 'x', { reason: 'constructor' }), t)).toBeNull()
  })
})
