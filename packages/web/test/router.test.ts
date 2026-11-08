// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { createAppRouter } from '../src/router'
import { mockApi } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

const status = (s: object) => ({
  'GET auth/status': () => [200, s] as [number, unknown],
  'GET auth/me': () => [200, { permissions: [], csrfToken: 'c', user: {} }] as [number, unknown],
})

describe('router guards', () => {
  it('forces the setup wizard until an admin exists', async () => {
    mockApi(status({ mode: 'team', setupRequired: true, authenticated: false }))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('setup')
  })

  it('sends signed-out team users to login and signed-in users away from it', async () => {
    mockApi(status({ mode: 'team', setupRequired: false, authenticated: false }))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('login')
    vi.unstubAllGlobals()
    setActivePinia(createPinia())
    mockApi(status({ mode: 'team', setupRequired: false, authenticated: true }))
    const signedIn = createAppRouter(createMemoryHistory())
    await signedIn.push('/login')
    expect(signedIn.currentRoute.value.name).toBe('workspace')
  })

  it('lets local mode straight in', async () => {
    mockApi(status({ mode: 'local', setupRequired: false, authenticated: true }))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('workspace')
  })
})
