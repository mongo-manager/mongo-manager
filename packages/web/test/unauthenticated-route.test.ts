// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '../src/router'
import { useSessionStore } from '../src/stores/session'
import { afterUnauthenticated } from '../src/auth/unauthenticated'
import { mockApi } from './support/app'

const ME = {
  mode: 'team',
  user: { id: 'u1', username: 'ada', role: 'admin' },
  permissions: [],
  csrfToken: 'csrf-1',
  readOnly: false,
  twoFactor: { enabled: false, totp: false, passkeys: 0, recoveryCodesRemaining: 0 },
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

/**
 * Review of the launch fix (minor 1): where a 401 leaves the page. A session that ended goes to
 * sign-in and comes back where it was; a page nobody was signed in on (local mode's gate, saying a
 * link was used) is left as it is, with why it is shown.
 */
describe('after a 401', () => {
  it('leaves the gate page as it is, with why it is shown', async () => {
    mockApi({
      'GET auth/status': () => [
        401,
        { code: 'UNAUTHENTICATED', message: 'Open it from a link', details: { reason: 'launch_required' } },
      ],
      'POST auth/local/claim': () => [401, { code: 'UNAUTHENTICATED', message: 'No link' }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/open-link?link=expired')
    expect(router.currentRoute.value.name).toBe('openLink')
    const session = useSessionStore()
    const wasIn = session.status?.authenticated === true
    session.ready = false
    await afterUnauthenticated(router, wasIn)
    expect(router.currentRoute.value.name).toBe('openLink')
    expect(router.currentRoute.value.query.link).toBe('expired')
  })

  it('sends a session that ended to sign in, to come back where it was', async () => {
    let signedIn = true
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: signedIn }],
      'GET auth/me': () => [200, ME],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/account')
    expect(router.currentRoute.value.name).toBe('account')
    const session = useSessionStore()
    const wasIn = session.status?.authenticated === true
    signedIn = false
    session.ready = false
    await afterUnauthenticated(router, wasIn)
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.next).toBe('/account')
  })
})
