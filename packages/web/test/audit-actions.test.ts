// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { ALL_AUDIT_ACTIONS, PERMISSIONS } from '@mongo-manager/shared'
import WorkspaceView from '../src/views/WorkspaceView.vue'
import { createAppRouter } from '../src/router'
import { i18n } from '../src/i18n'
import { useTabsStore } from '../src/stores/tabs'
import { auditActionKey, auditGroupKey, useAuditWords } from '../src/admin/auditWords'
import en from '../src/i18n/locales/en.json'
import tr from '../src/i18n/locales/tr.json'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'
import { offered, openPicker, pick } from './support/pickers'

/** Audit action labels (2026-10-28): the log says what was done in words, in every language. */
type Tree = { [key: string]: string | Tree }
const at = (tree: Tree, key: string): unknown =>
  key.split('.').reduce<unknown>((t, k) => (t as Tree | undefined)?.[k], tree)
const leaves = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`),
  )

describe('the audit actions’ words', () => {
  it.each([
    ['en', en],
    ['tr', tr],
  ] as const)('name every action the server writes, in %s', (_lang, messages) => {
    const missing = ALL_AUDIT_ACTIONS.filter(
      (a) => typeof at(messages as Tree, auditActionKey(a)) !== 'string',
    )
    expect(missing).toEqual([])
    const groups = [...new Set(ALL_AUDIT_ACTIONS.map((a) => a.split('.')[0]!))]
    expect(groups.filter((g) => typeof at(messages as Tree, auditGroupKey(g)) !== 'string')).toEqual([])
  })

  it('name no action the server does not write', () => {
    const known = new Set(ALL_AUDIT_ACTIONS.map(auditActionKey))
    for (const messages of [en, tr]) {
      const actions = (messages as unknown as { audit: { actions: Tree } }).audit.actions
      expect(leaves(actions, 'audit.actions.').filter((k) => !known.has(k))).toEqual([])
    }
  })

  // Final review: no two codes share a message.
  it('give each action a message of its own', () => {
    const keys = ALL_AUDIT_ACTIONS.map(auditActionKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('are words, not the code again', () => {
    for (const a of ALL_AUDIT_ACTIONS) {
      expect(at(en as Tree, auditActionKey(a))).not.toBe(a)
      expect(at(tr as Tree, auditActionKey(a))).not.toBe(a)
    }
    // Two actions never read the same: the log could not tell them apart.
    for (const messages of [en, tr]) {
      const words = ALL_AUDIT_ACTIONS.map((a) => at(messages as Tree, auditActionKey(a)))
      expect(words.filter((w, i) => words.indexOf(w) !== i)).toEqual([])
    }
  })
})

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const entry = (id: number, action: string) => ({
  id,
  at: Date.UTC(2026, 9, 28, 10, 0, id),
  userId: 'u1',
  username: 'ada',
  ip: '127.0.0.1',
  action,
  connectionId: null,
  namespace: null,
  outcome: 'success',
  details: { status: 200 },
})

async function auditLog(rows: ReturnType<typeof entry>[]) {
  const urls: URL[] = []
  mockApi({
    'GET auth/status': () => [200, { mode: 'team', setupRequired: false, authenticated: true }],
    'GET auth/me': () => [
      200,
      {
        mode: 'team',
        user: { id: 'u1', username: 'ada', role: 'admin' },
        permissions: [...PERMISSIONS],
        csrfToken: 'c',
        readOnly: false,
        twoFactor: {},
      },
    ],
    'GET connections': () => [200, []],
    'GET users': () => [200, []],
    'GET audit': (_b, url) => {
      urls.push(url)
      return [200, rows]
    },
  })
  const router = createAppRouter(createMemoryHistory())
  await router.push('/')
  const tabs = useTabsStore()
  tabs.bindUser('u1')
  tabs.open({ kind: 'audit', title: '' })
  mountApp(WorkspaceView, { plugins: [router] })
  await vi.waitFor(() =>
    expect(document.querySelectorAll('main tbody tr[data-entry]').length).toBe(rows.length),
  )
  return { urls }
}
const cell = (i: number) => document.querySelectorAll('main tbody tr[data-entry] [data-audit-action]')[i]!

const trigger = () => document.querySelector<HTMLButtonElement>('[data-audit-action-filter] button')!
async function search(text: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  field.value = text
  field.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('the audit log', () => {
  it('says each action in words, its code kept on the side', async () => {
    await auditLog([entry(1, 'auth.totp.disable'), entry(2, 'livesync.attention')])
    expect(cell(0).textContent!.trim()).toBe('Turn off the authenticator app')
    expect(cell(0).getAttribute('title')).toBe('Turn off the authenticator app\nauth.totp.disable')
    // Final review: a screen reader hears the code too, not only a pointer's tooltip.
    expect(cell(0).parentElement!.querySelector('.sr-only:last-child')!.textContent).toBe(
      ' (auth.totp.disable)',
    )
    expect(cell(1).textContent!.trim()).toBe('Live sync needs attention')
    ;(document.querySelector('button[aria-label="Show details"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-audit-code]')!.textContent).toBe('Code: auth.totp.disable')
  })

  // Final review: an entry with no details opens too, to its code alone.
  it('opens an entry with no details to its code', async () => {
    await auditLog([{ ...entry(1, 'auth.launch'), details: null } as unknown as ReturnType<typeof entry>])
    ;(document.querySelector('button[aria-label="Show details"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-audit-code]')!.textContent).toBe('Code: auth.launch')
    expect(document.querySelector('main tbody pre')).toBeNull()
  })

  it('says them in the user’s language', async () => {
    i18n.global.locale.value = 'tr'
    await auditLog([entry(1, 'auth.totp.disable'), entry(2, 'users.2fa.reset')])
    expect(cell(0).textContent!.trim()).toBe('Doğrulama uygulamasını kapatma')
    expect(cell(1).textContent!.trim()).toBe('Kullanıcının iki adımlı doğrulamasını sıfırlama')
  })

  // Final review: a language with no words for an action yet says it in English, not as a code.
  it('says an action in English where the language has no words for it yet', () => {
    i18n.global.setLocaleMessage('xx', {} as never)
    i18n.global.locale.value = 'xx' as never
    try {
      // Not the whole app: its session puts the user's own language back.
      const Probe = defineComponent({
        setup() {
          const words = useAuditWords()
          return () => h('p', words.action('auth.totp.disable').text)
        },
      })
      const { wrapper } = mountApp(Probe)
      expect(i18n.global.locale.value).toBe('xx')
      expect(wrapper.text()).toBe('Turn off the authenticator app')
    } finally {
      i18n.global.locale.value = 'en'
    }
  })

  // An entry changed outside the app: its code, as it is.
  it('shows the code of an action it has no words for', async () => {
    await auditLog([entry(1, 'legacy.thing')])
    expect(cell(0).textContent!.trim()).toBe('legacy.thing')
    expect(cell(0).classList.contains('font-mono')).toBe(true)
    expect(cell(0).getAttribute('title')).toBe('legacy.thing')
  })

  // Final review: an older version's code is said as the action that replaced it.
  it('says an older version’s action as the one that replaced it', async () => {
    await auditLog([entry(1, 'connections.personalFields.local'), entry(2, 'gridfs.rename')])
    expect(cell(0).textContent!.trim()).toBe('Hide personal data from oneself, or show it again')
    expect(cell(1).textContent!.trim()).toBe('Change a GridFS file')
  })

  it('filters by an action picked by its words, or found by its code', async () => {
    const { urls } = await auditLog([entry(1, 'auth.login')])
    // Final review: the visible label names the picker, which says what is picked.
    const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Action')!
    expect(document.getElementById(label.htmlFor)).toBe(trigger())
    expect(trigger().getAttribute('aria-label')).toBe('Action: Any action')
    await pick('data-audit-action-filter', 'Turn off the authenticator app')
    expect(trigger().textContent).toContain('Turn off the authenticator app')
    expect(trigger().getAttribute('aria-label')).toBe('Action: Turn off the authenticator app')
    button('Filter').click()
    await flushPromises()
    expect(urls.at(-1)!.searchParams.get('action')).toBe('auth.totp.disable')

    await openPicker('data-audit-action-filter')
    // Final review: wide enough for an action's words beside its code.
    expect(document.querySelector('[data-ds-popup]')!.className).toContain('w-[30rem]')
    // The search field and the list keep the field's own name.
    expect(document.querySelector('[role="combobox"]')!.getAttribute('aria-label')).toBe('Action')
    await search('totp.dis')
    expect(offered()).toEqual(['Turn off the authenticator app'])
    await search('')
    // Every action, and the choice of none first.
    expect(offered()[0]).toBe('Any action')
    expect(offered()).toHaveLength(ALL_AUDIT_ACTIONS.length + 1)
    const rest = offered().slice(1)
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en')))
    await pick('data-audit-action-filter', 'Any action')
    button('Filter').click()
    await flushPromises()
    expect(urls.at(-1)!.searchParams.get('action')).toBeNull()
  })

  // Final review: a code with no words is still filtered on, typed in full.
  it('filters on a code typed in full that has no words', async () => {
    const { urls } = await auditLog([entry(1, 'auth.login')])
    await openPicker('data-audit-action-filter')
    await search('legacy.thing')
    expect(offered()).toEqual(['Code: legacy.thing'])
    // A known code is offered by its words, never twice.
    await search('auth.login.totp')
    expect(offered()).toEqual(['Sign in with an authenticator app code'])
    await search('legacy.thing')
    await pick('data-audit-action-filter', 'Code: legacy.thing')
    expect(trigger().textContent).toContain('legacy.thing')
    button('Filter').click()
    await flushPromises()
    expect(urls.at(-1)!.searchParams.get('action')).toBe('legacy.thing')
  })

  it('says the picked action again when the language changes', async () => {
    await auditLog([entry(1, 'auth.login')])
    await pick('data-audit-action-filter', 'Turn off the authenticator app')
    i18n.global.locale.value = 'tr'
    await nextTick()
    expect(trigger().textContent).toContain('Doğrulama uygulamasını kapatma')
  })

  // Final review: Turkish found as typed, whatever the browser's language and marks.
  it('finds Turkish words typed without their marks or capitals', async () => {
    i18n.global.locale.value = 'tr'
    await auditLog([entry(1, 'auth.login')])
    await openPicker('data-audit-action-filter')
    await search('iki adimli dogrulama politikasi')
    expect(offered()).toEqual(['İki adımlı doğrulama politikasını değiştirme'])
    await search('SIFREYLE')
    expect(offered()).toEqual(['Şifreyle giriş'])
  })
})
