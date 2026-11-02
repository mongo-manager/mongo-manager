import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { PERMISSIONS, type AccessEntry, type AccessPolicy } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import UnavailableView from '../src/views/UnavailableView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { createAppRouter } from '../src/router'
import { i18n, loadLocale } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { useSessionStore } from '../src/stores/session'
import { useToastStore } from '../src/stores/toasts'
import { describeUserAgent } from '../src/admin/userAgent'
import { afterIpNotAllowed } from '../src/auth/unauthenticated'
import { mockApi, mountApp, type Handler } from './support/app'
import { typeInto, securityTab } from './support/dom'

/**
 * Panel access (2026-10-30): the Users page sets the addresses the panel answers, shows who is
 * signed in from where and who a list would sign out, and warns before the administrator locks
 * themselves out; an address the panel refuses is told so.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const sessionsFor = (allow: (ip: string) => boolean) => [
  {
    username: 'ada',
    ip: '203.0.113.10',
    userAgent: CHROME_WIN,
    createdAt: 0,
    lastSeenAt: Date.now(),
    current: true,
    allowed: allow('203.0.113.10'),
  },
  {
    username: 'bob',
    ip: '198.51.100.20',
    userAgent: null,
    createdAt: 0,
    lastSeenAt: Date.now(),
    current: false,
    allowed: allow('198.51.100.20'),
  },
]
const policy = (entries: AccessEntry[], allow: (ip: string) => boolean = () => true): AccessPolicy => ({
  entries,
  yourAddress: '203.0.113.10',
  yourRange: '203.0.113.10',
  youAllowed: allow('203.0.113.10'),
  untrustedProxy: false,
  sessions: sessionsFor(allow),
})
/** A list "lets in" an address when an entry is the address itself (enough for these tests). */
const allowing = (entries: AccessEntry[]) => (ip: string) =>
  entries.length === 0 || entries.some((e) => e.range === ip)

async function users(handlers: Record<string, Handler> = {}) {
  let saved: AccessEntry[] = []
  const r = mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [200, me],
    'GET connections': () => [200, []],
    'GET users': () => [200, []],
    'GET users/access': () => [200, policy(saved, allowing(saved))],
    'POST users/access/preview': (body) => {
      const entries = (body as { entries: AccessEntry[] }).entries
      const invalid = entries.flatMap((e, i) => (/^[\d.:a-f/]+$/i.test(e.range) ? [] : [i]))
      const kept = entries.filter((_e, i) => !invalid.includes(i))
      return [200, { ...policy(kept, allowing(kept)), invalid }]
    },
    'PUT users/access': (body) => {
      saved = (body as { entries: AccessEntry[] }).entries
      return [200, policy(saved, allowing(saved))]
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
  await vi.waitFor(() => expect(document.querySelector('main [data-panel-access]')).not.toBeNull())
  await flushPromises()
  return r
}
const card = () => document.querySelector<HTMLElement>('[data-panel-access]')!
const addInput = () => card().querySelector<HTMLInputElement>('[data-access-add] input')!
async function addRange(range: string): Promise<void> {
  await typeInto(addInput(), range)
  card().querySelector<HTMLButtonElement>('[data-access-add] button[type="submit"]')!.click()
  await flushPromises()
  await new Promise((r) => setTimeout(r, 350))
  await flushPromises()
}
const said = () => useToastStore().toasts.map((x) => x.message)

describe('the panel access card', () => {
  it('says every address is let in, shows your address and who is signed in from where', async () => {
    await users()
    expect(card().textContent).toContain('Every address can reach the panel.')
    expect(card().querySelector('[data-your-address]')?.textContent).toContain('203.0.113.10')
    const rows = [...card().querySelectorAll('[data-access-session]')].map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('ada')
    expect(rows[0]).toContain('(you)')
    expect(rows[0]).toContain('Chrome · Windows')
    expect(rows[1]).toContain('198.51.100.20')
    expect(card().querySelector('[data-signed-out]')).toBeNull()
  })

  it('warns, as the list is made, that others are signed out and that it leaves you out', async () => {
    await users()
    await addRange('198.51.100.20')
    expect(card().querySelector('[data-access-info]')?.textContent).toContain(
      'users signed in from any other address are signed out at once',
    )
    expect(card().querySelector('[data-access-lockout]')?.textContent).toContain(
      'Your address 203.0.113.10 is not in the list. If you save it, you can no longer sign in from the address you are on now',
    )
    const out = [...card().querySelectorAll('[data-access-session]')].filter((r) =>
      r.querySelector('[data-signed-out]'),
    )
    expect(out.map((r) => r.textContent)).toEqual([expect.stringContaining('ada')])
    // Adding your own address takes the warning away.
    card().querySelector<HTMLButtonElement>('[data-add-mine]')!.click()
    await flushPromises()
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    expect(card().querySelector('[data-access-lockout]')).toBeNull()
    expect(card().querySelector('[data-add-mine]')).toBeNull()
  })

  it('marks a row that is no address', async () => {
    await users()
    await addRange('office.example')
    expect(card().querySelector('[data-access-entry]')?.textContent).toContain('Not an address or range')
  })

  it('saves with the password, and asks them to mean it when it locks them out', async () => {
    const { calls } = await users()
    await addRange('198.51.100.20')
    card().querySelector<HTMLButtonElement>('[data-access-save]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Lock yourself out?')
    expect(document.querySelector('[data-test="confirm"]')?.textContent).toContain('Save and lock me out')
    await typeInto(document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement, 'pw')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === 'users/access').map((c) => c.body)
    expect(puts).toEqual([
      { entries: [{ range: '198.51.100.20', label: '' }], password: 'pw', lockMeOut: true },
    ])
    expect(said()).toContain('Panel access saved; 1 session was signed out.')
  })

  it('saves a list with your address without asking you to lock yourself out', async () => {
    const { calls } = await users()
    card().querySelector<HTMLButtonElement>('[data-add-mine]')!.click()
    await flushPromises()
    card().querySelector<HTMLButtonElement>('[data-access-save]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Save panel access?')
    expect(document.body.textContent).toContain('1 session is signed out.')
    await typeInto(document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement, 'pw')
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === 'users/access').map((c) => c.body)
    expect(puts).toEqual([{ entries: [{ range: '203.0.113.10', label: 'My address' }], password: 'pw' }])
  })

  it('warns when requests come through a proxy nobody trusted', async () => {
    await users({ 'GET users/access': () => [200, { ...policy([]), untrustedProxy: true }] })
    expect(card().querySelector('[data-access-proxy]')?.textContent).toContain('--trusted-proxies')
  })
})

describe('an address the panel refuses', () => {
  it('is told so, with its address, wherever it opens the app', async () => {
    mockApi({
      'GET auth/status': () => [
        403,
        { code: 'FORBIDDEN', message: 'x', details: { reason: 'ip_not_allowed', address: '198.51.100.99' } },
      ],
    })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('unavailable')
    expect(useSessionStore().blockedAddress).toBe('198.51.100.99')
    mountApp(UnavailableView, { plugins: [router] })
    await flushPromises()
    expect(document.querySelector('[data-blocked]')?.textContent).toContain(
      'This address cannot reach the panel',
    )
    expect(document.body.textContent).toContain('198.51.100.99 is not one of them')
  })

  it('in every language', async () => {
    for (const lang of ['tr', 'zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const) {
      await loadLocale(lang)
      i18n.global.locale.value = lang
      const body = i18n.global.t('unavailable.blockedBody', { address: '198.51.100.99' })
      expect(body, lang).toContain('198.51.100.99')
      expect(i18n.global.t('users.access.lockWarning', { address: 'X' }), lang).toContain('X')
      expect(i18n.global.te('users.access.reasons.excludesYou'), lang).toBe(true)
    }
  })
})

describe('a refusal of the address, mid-session or at load (review of panel access, I1)', () => {
  it('moves a ready page to the screen once, and never again from the guard’s own refused read', async () => {
    const router = createAppRouter(createMemoryHistory())
    const replace = vi.spyOn(router, 'replace').mockResolvedValue(undefined)
    await afterIpNotAllowed(router, false)
    expect(replace).not.toHaveBeenCalled()
    await afterIpNotAllowed(router, true)
    expect(replace).toHaveBeenCalledWith({ name: 'unavailable' })
  })
})

describe('an IPv6 administrator’s own address', () => {
  it('is added as its /64, said beside the button', async () => {
    const { calls } = await users({
      'GET users/access': () => [
        200,
        { ...policy([]), yourAddress: '2001:db8:1:2:a:b:c:d', yourRange: '2001:db8:1:2::/64' },
      ],
    })
    expect(card().querySelector('[data-access-ipv6]')?.textContent).toContain('2001:db8:1:2::/64')
    card().querySelector<HTMLButtonElement>('[data-add-mine]')!.click()
    await flushPromises()
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    const previews = calls.filter((c) => c.path === 'users/access/preview').map((c) => c.body)
    expect(previews.at(-1)).toEqual({ entries: [{ range: '2001:db8:1:2::/64', label: 'My address' }] })
    expect(card().querySelector('[data-add-mine]')).toBeNull()
  })

  it('marks a row too short to be an address without asking the server', async () => {
    const { calls } = await users()
    await addRange('1')
    expect(card().querySelector('[data-access-entry]')?.textContent).toContain('Not an address or range')
    expect(calls.filter((c) => c.path === 'users/access/preview').map((c) => c.body)).toEqual([
      { entries: [] },
    ])
  })
})

describe('a session’s browser', () => {
  it('is said in a few words', () => {
    expect(describeUserAgent(CHROME_WIN)).toBe('Chrome · Windows')
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      ),
    ).toBe('Safari · macOS')
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe(
      'Firefox · Linux',
    )
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe(
      'Edge · Windows',
    )
    expect(describeUserAgent('curl/8.0')).toBeNull()
    expect(describeUserAgent(null)).toBeNull()
  })
})
