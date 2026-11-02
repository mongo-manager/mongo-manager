import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, type SignInBans } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n, loadLocale } from '../src/i18n'
import { ApiError } from '../src/api/client'
import { describeError } from '../src/api/errors'
import { explainError } from '../src/api/reasons'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp, type Handler } from './support/app'
import { byLabel, choose, typeInto, securityTab } from './support/dom'

/**
 * Sign-in bans (2026-10-30): the Users page lists the addresses refused at the sign-in, blocks one,
 * and lifts a ban with the administrator's password; the sign-in says a ban and a busy server in the
 * user's words.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  i18n.global.locale.value = 'en'
})

const ADA = '00000000-0000-4000-8000-0000000000a1'
const me = {
  mode: 'team',
  user: { id: ADA, username: 'ada', role: 'admin' },
  permissions: [...PERMISSIONS],
  csrfToken: 'c',
  readOnly: false,
  twoFactor: { enabled: true, totp: true, passkeys: 0, recoveryCodesRemaining: 10 },
  twoFactorRequired: false,
}
const RULE = { failures: 30, windowMinutes: 15, stepsMinutes: [15, 60, 360, 1440] }
const UNTIL = Date.UTC(2026, 9, 30, 15, 0)
const listed = (...bans: SignInBans['bans']): SignInBans => ({ bans, total: bans.length, rule: RULE })

async function users(handlers: Record<string, Handler> = {}) {
  let state = listed({
    address: '203.0.113.7',
    reason: 'sign_in',
    strikes: 2,
    bannedAt: UNTIL - 3_600_000,
    until: UNTIL,
    by: null,
  })
  const r = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, me],
    'GET connections': () => [200, []],
    'GET users': () => [200, []],
    'GET users/bans': () => [200, state],
    'POST users/bans': (body) => {
      const { address } = body as { address: string }
      state = listed(...state.bans, {
        address,
        reason: 'manual',
        strikes: 0,
        bannedAt: 0,
        until: UNTIL,
        by: 'ada',
      })
      return [200, state]
    },
    'POST users/bans/lift': () => {
      state = listed()
      return [200, state]
    },
    ...handlers,
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser(ADA)
  tabs.open({ kind: 'users', title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  mountApp(DialogHost)
  await securityTab()
  await vi.waitFor(() => expect(document.querySelector('main [data-sign-in-bans]')).not.toBeNull())
  await flushPromises()
  return r
}

const said = () => useToastStore().toasts.map((x) => x.message)
const card = () => document.querySelector<HTMLElement>('[data-sign-in-bans]')!
const posts = (calls: { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body)

describe('the blocked addresses card', () => {
  it('says the rule and each ban: the address, why, and until when', async () => {
    await users()
    expect(card().textContent).toContain(
      'An address with 30 failed sign-ins within 15 min is blocked from signing in: 15 min → 1 h → 6 h → 24 h',
    )
    const row = card().querySelector<HTMLElement>('[data-ban]')!
    expect(row.textContent).toContain('203.0.113.7')
    expect(row.textContent).toContain('Too many failed sign-ins (block 2)')
    expect(row.textContent).toMatch(/until .*2026/)
    expect([...byLabel<HTMLSelectElement>('For').options].map((o) => o.textContent?.trim())).toEqual([
      '1 hour',
      '1 day',
      '7 days',
      '30 days',
    ])
  })

  it('blocks an address for the time chosen, asking nothing more', async () => {
    const { calls } = await users()
    await typeInto(byLabel<HTMLInputElement>('Address to block'), ' 198.51.100.4 ')
    await choose(byLabel<HTMLSelectElement>('For'), '168')
    card().querySelector<HTMLButtonElement>('[data-ban-form] button[type="submit"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-test="prompt-input"]')).toBeNull()
    expect(posts(calls, 'users/bans')).toEqual([{ address: '198.51.100.4', hours: 168 }])
    expect(card().querySelectorAll('[data-ban]')).toHaveLength(2)
    expect(said()).toContain('198.51.100.4 is blocked from signing in.')
  })

  it('says why an address cannot be blocked, in the user’s words', async () => {
    const { calls } = await users({
      'POST users/bans': () => [
        400,
        { code: 'VALIDATION_ERROR', message: 'x', details: { reason: 'ban_own_address' } },
      ],
    })
    await typeInto(byLabel<HTMLInputElement>('Address to block'), '192.0.2.1')
    card().querySelector<HTMLButtonElement>('[data-ban-form] button[type="submit"]')!.click()
    await flushPromises()
    expect(posts(calls, 'users/bans')).toHaveLength(1)
    expect(said()).toContain('That is the address you are signed in from: blocking it would lock you out.')
  })

  it('lifts a ban only with the administrator’s password', async () => {
    const { calls } = await users()
    const lift = () =>
      card().querySelector<HTMLButtonElement>('button[aria-label="Lift the block of 203.0.113.7"]')!
    lift().click()
    await flushPromises()
    expect(document.body.textContent).toContain('Lift the block of 203.0.113.7?')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(posts(calls, 'users/bans/lift')).toEqual([])

    lift().click()
    await flushPromises()
    await typeInto(
      document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement,
      'my password',
    )
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(posts(calls, 'users/bans/lift')).toEqual([{ address: '203.0.113.7', password: 'my password' }])
    expect(card().querySelector('[data-bans-empty]')?.textContent).toContain('No address is blocked.')
  })

  it('says how many there are when not all are shown', async () => {
    await users({ 'GET users/bans': () => [200, { ...listed(), total: 612 }] })
    expect(card().querySelector('[data-bans-more]')?.textContent).toContain(
      'Showing 0 of 612 blocked addresses.',
    )
  })

  it('is not shown by a server that has no bans', async () => {
    mockApi({
      'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
      'GET auth/me': () => [200, me],
      'GET connections': () => [200, []],
      'GET users': () => [200, []],
      'GET users/bans': () => [404, { code: 'NOT_FOUND', message: 'Not found' }],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    useTabsStore().bindUser(ADA)
    useTabsStore().open({ kind: 'users', title: '' })
    mountApp(WorkspaceView, { plugins: [router] })
    await vi.waitFor(() => expect(document.querySelector('main')).not.toBeNull())
    await flushPromises()
    expect(document.querySelector('[data-sign-in-bans]')).toBeNull()
  })
})

describe('a refused sign-in, in the user’s words', () => {
  const t = i18n.global.t as (key: string, values?: Record<string, unknown>) => string
  const refused = (details: Record<string, unknown>) =>
    new ApiError(429, 'RATE_LIMITED', 'Too many requests; try again later', details)

  it('says a ban and how long it lasts, and a busy server', () => {
    expect(describeError(refused({ reason: 'address_banned', retryAfterMs: 14 * 60_000 + 1 }), t)).toBe(
      'Too many failed sign-ins came from this address: signing in from here is blocked for 15 min. An administrator can lift the block.',
    )
    expect(describeError(refused({ reason: 'address_banned', retryAfterMs: 5 * 3_600_000 }), t)).toContain(
      'blocked for 5 h.',
    )
    expect(describeError(refused({ reason: 'server_busy', retryAfterMs: 2000 }), t)).toBe(
      'The server is checking many sign-ins right now. Try again in a few seconds.',
    )
    expect(describeError(refused({ retryAfterMs: 3000 }), t)).toBe('Too many attempts. Try again in 3 s.')
  })

  it('in every language', async () => {
    for (const lang of ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const) {
      await loadLocale(lang)
      i18n.global.locale.value = lang
      const banned = describeError(refused({ reason: 'address_banned', retryAfterMs: 60_000 }), t)
      expect(banned, lang).not.toMatch(/errors\.|Too many failed/)
      expect(banned, lang).toMatch(/1/)
      const busy = describeError(refused({ reason: 'server_busy' }), t)
      expect(busy, lang).not.toMatch(/errors\.|The server/)
      for (const reason of ['ban_not_an_address', 'ban_loopback', 'ban_own_address', 'ban_private']) {
        const said = explainError(new ApiError(400, 'VALIDATION_ERROR', 'English', { reason }), t)
        expect(said, `${lang} ${reason}`).not.toMatch(/users\.bans|English/)
      }
    }
  })
})
