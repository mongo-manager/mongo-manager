import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AccountView from '../src/account/AccountView.vue'
import { useSessionStore } from '../src/stores/session'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '../src/router'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { localKeyNow, setLocalKey } from '../src/api/client'

/**
 * UI redesign R2–R5 spec §5 (R5): the account is a settings page — the shared page header, then its
 * sections as cards with a list of them on the side that takes you to each one.
 */
const sections = () =>
  [...document.querySelectorAll('nav[aria-label="Account sections"] button')].map((b) =>
    b.textContent!.trim(),
  )
const cards = () =>
  [...document.querySelectorAll('section[aria-labelledby] > h3')].map((h) => h.textContent!.trim())

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  mockApi({})
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('the account page', () => {
  it('opens on the page header and lists every section it shows, in order', async () => {
    const session = useSessionStore()
    session.status = { mode: 'team' } as never
    session.me = {
      user: { username: 'ada', role: 'admin' },
      permissions: [],
      twoFactor: { enabled: false, methods: [] },
    } as never
    mountApp(AccountView)
    await flushPromises()
    expect(document.querySelector('header h2')!.textContent).toContain('Account')
    expect(document.querySelector('header p')!.textContent).toContain('ada')
    expect(sections()).toEqual([
      'Profile',
      'Change password',
      'Two-factor authentication',
      'Backup keys',
      'AI chats',
      'Preferences',
      // W5: the user's own shortcuts.
      'Keyboard shortcuts',
    ])
    expect(cards()).toEqual(sections())
  })

  it('leaves out what local mode does not have, and has its browsers', async () => {
    useSessionStore().status = { mode: 'local' } as never
    mountApp(AccountView)
    await flushPromises()
    expect(sections()).toEqual(['Browsers', 'Backup keys', 'AI chats', 'Preferences', 'Keyboard shortcuts'])
    expect(cards()).toEqual(sections())
  })

  // Review of the audit fixes (important 1): every browser that opened a launch link, signed out.
  it('signs every browser out of local mode, then shows how to open the app', async () => {
    const { calls } = mockApi({ 'POST auth/local/sign-out-all': () => [204] })
    setLocalKey('page-key-1')
    useSessionStore().status = { mode: 'local' } as never
    const router = createAppRouter(createMemoryHistory())
    mountApp(AccountView, { plugins: [router] })
    mountApp(DialogHost)
    await flushPromises()
    ;(document.querySelector('[data-sign-out-browsers]') as HTMLButtonElement).click()
    await flushPromises()
    ;(document.querySelector('[data-test="confirm"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'auth/local/sign-out-all')).toBe(true)
    expect(localKeyNow()).toBeUndefined()
  })

  it('takes you to a section and says which one you are at', async () => {
    useSessionStore().status = { mode: 'local' } as never
    mountApp(AccountView)
    await flushPromises()
    const scrolled = vi.fn()
    const target = document.querySelector<HTMLElement>('section[aria-labelledby]:last-of-type')!
    target.scrollIntoView = scrolled
    const link = [
      ...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Account sections"] button'),
    ].at(-1)!
    link.click()
    await flushPromises()
    expect(scrolled).toHaveBeenCalled()
    expect(link.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(target.querySelector('h3'))
  })
})

describe('the account page, reviewed (R3–R5 minors 1, 2)', () => {
  // A short last card is never the first in view: at the end of the page the list marks it.
  it('marks the last section once the page is scrolled to its end', async () => {
    useSessionStore().status = { mode: 'local' } as never
    mountApp(AccountView)
    await flushPromises()
    const scroller = document.querySelector<HTMLElement>('[data-account-page] .overflow-auto')!
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    scroller.scrollTop = 1200
    scroller.dispatchEvent(new Event('scroll'))
    await flushPromises()
    const last = [...document.querySelectorAll('nav[aria-label="Account sections"] button')].at(-1)!
    expect(last.getAttribute('aria-current')).toBe('true')
  })

  // The title a section's link focuses shows the keyboard where it is.
  it('shows the focus on the title it takes you to', () => {
    useSessionStore().status = { mode: 'local' } as never
    mountApp(AccountView)
    const title = document.querySelector('section[aria-labelledby] > h3')!
    expect(title.className).toContain('focus-visible:outline-2')
    expect(title.className).not.toMatch(/(^|\s)focus:outline-none/)
    expect(document.querySelector('nav[aria-label="Account sections"]')!.className).toContain('lg:top-5')
  })
})
