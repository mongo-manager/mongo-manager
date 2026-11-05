// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { READ_TIMEOUT_MS, useSessionStore } from '../src/stores/session'
import { mockApi } from './support/app'

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async ({ optionsJSON }: { optionsJSON: { challenge: string } }) => ({
    id: 'cred',
    challenge: optionsJSON.challenge,
  })),
}))

const ME = {
  mode: 'team',
  user: { id: 'u1', username: 'ada', role: 'admin' },
  permissions: ['documents:read', 'users:manage'],
  csrfToken: 'csrf-1',
  readOnly: false,
  twoFactor: { enabled: true, totp: true, passkeys: 1, recoveryCodesRemaining: 10 },
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

describe('session store', () => {
  it('loads status and me and exposes permissions', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
    })
    const s = useSessionStore()
    await s.refresh()
    expect(s.ready).toBe(true)
    expect(s.me?.user.username).toBe('ada')
    expect(s.can('users:manage')).toBe(true)
    expect(s.can('shell:execute')).toBe(false)
  })

  // 2026-10-17: a page come from a launch link reads the session twice at once (the router's guard
  // and another caller). The link's key may be claimed once only: the second claim was refused and
  // its "not allowed" answer overwrote the first's signed-in one, leaving the browser shut out.
  it('claims a launch key once when the session is read twice at once, and ends signed in', async () => {
    let claimed = false
    const { calls } = mockApi({
      'GET auth/status': () =>
        claimed
          ? [200, { mode: 'local', setupRequired: false, authenticated: true }]
          : [
              401,
              {
                code: 'UNAUTHENTICATED',
                message: 'Open it from a link',
                details: { reason: 'launch_required' },
              },
            ],
      'POST auth/local/claim': () => {
        if (claimed) return [401, { code: 'UNAUTHENTICATED', message: 'Already claimed' }]
        claimed = true
        return [200, { key: 'page-key' }]
      },
      'GET auth/me': () => [200, { ...ME, mode: 'local' }],
    })
    const s = useSessionStore()
    await Promise.all([s.refresh(), s.refresh()])
    expect(calls.filter((c) => c.path === 'auth/local/claim')).toHaveLength(1)
    expect(s.status?.authenticated).toBe(true)
    expect(s.status?.launchRequired).toBeUndefined()
    expect(s.me?.user.username).toBe('ada')
  })

  it('reads again after a read that failed', async () => {
    let fail = true
    mockApi({
      'GET auth/status': () =>
        fail
          ? [500, { code: 'INTERNAL', message: 'down' }]
          : [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
    })
    const s = useSessionStore()
    await expect(s.refresh()).rejects.toThrow()
    fail = false
    await s.refresh()
    expect(s.status?.authenticated).toBe(true)
  })

  // Review of the launch fix (minor 3): a read that was overtaken does not say the session is ready
  // when the one after it is still to come (a 401 meanwhile set it not ready).
  it('is ready only once the last read asked has ended', async () => {
    let answer!: () => void
    let first = true
    mockApi({
      'GET auth/status': async () => {
        if (first) {
          first = false
          await new Promise<void>((resolve) => (answer = resolve))
        }
        return [200, { mode: 'team', setupRequired: false, authenticated: false }]
      },
    })
    const s = useSessionStore()
    const a = s.refresh()
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    s.ready = false
    const b = s.refresh()
    answer()
    await a
    expect(s.ready).toBe(false)
    await b
    expect(s.ready).toBe(true)
  })

  // Review of the launch fix (minor 4): reads run one at a time, so one that hangs must not hold the
  // ones behind it (a sign-in, a sign-out) for ever.
  it('gives up a read that hangs, and the next one runs', async () => {
    vi.useFakeTimers()
    try {
      let hang = true
      mockApi({
        'GET auth/status': () =>
          hang
            ? new Promise<never>(() => undefined)
            : [200, { mode: 'team', setupRequired: false, authenticated: false }],
      })
      const s = useSessionStore()
      const stuck = s.refresh()
      const caught = stuck.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
      expect(await caught).toBeInstanceOf(Error)
      hang = false
      const next = s.refresh()
      await vi.advanceTimersByTimeAsync(0)
      await next
      expect(s.ready).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the two-step login with a TOTP code', async () => {
    let authenticated = false
    const { calls } = mockApi({
      'POST auth/login': () => [200, { mfaRequired: true, ticket: 't1', methods: ['totp', 'recovery'] }],
      'POST auth/login/totp': (body) => {
        authenticated = true
        return [200, { user: ME.user, csrfToken: 'csrf-2', received: body }]
      },
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated }],
      'GET auth/me': () => [200, { ...ME, csrfToken: 'csrf-2' }],
    })
    const s = useSessionStore()
    expect(await s.login('ada', 'pw')).toBe('mfa')
    expect(s.mfa).toEqual({ ticket: 't1', methods: ['totp', 'recovery'] })
    await s.verifyTotp('123456')
    expect(calls.find((c) => c.path === 'auth/login/totp')!.body).toEqual({ ticket: 't1', code: '123456' })
    expect(s.mfa).toBeNull()
    expect(s.me?.csrfToken).toBe('csrf-2')
  })

  it('verifies with a passkey using the ticket challenge', async () => {
    const { calls } = mockApi({
      'POST auth/login': () => [200, { mfaRequired: true, ticket: 't1', methods: ['passkey', 'recovery'] }],
      'POST auth/login/passkey/options': () => [200, { challenge: 'ch-1' }],
      'POST auth/login/passkey': () => [200, { user: ME.user, csrfToken: 'c' }],
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, ME],
    })
    const s = useSessionStore()
    await s.login('ada', 'pw')
    await s.verifyPasskey()
    expect(calls.find((c) => c.path === 'auth/login/passkey')!.body).toEqual({
      ticket: 't1',
      response: { id: 'cred', challenge: 'ch-1' },
    })
  })

  it('clears the session on logout', async () => {
    mockApi({
      'POST auth/logout': () => [204],
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: false }],
    })
    const s = useSessionStore()
    s.me = ME as never
    // Review 2026-10-12 (M18): the shells this browser tab kept for a reload go with the session.
    sessionStorage.setItem('mm:shell-session:tab-1', '11111111-2222-4333-8444-555555555555')
    sessionStorage.setItem('mm:other', 'kept')
    await s.logout()
    expect(s.me).toBeNull()
    expect(s.status?.authenticated).toBe(false)
    expect(sessionStorage.getItem('mm:shell-session:tab-1')).toBeNull()
    expect(sessionStorage.getItem('mm:other')).toBe('kept')
    sessionStorage.clear()
  })
})
