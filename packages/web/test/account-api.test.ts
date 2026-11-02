import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { accountApi, auditApi, grantsApi, usersApi } from '../src/api/account'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import { useDialogStore } from '../src/stores/dialogs'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { typeInto } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('account and admin API', () => {
  it('uses the server routes with encoded ids and query parameters', async () => {
    let auditUrl: URL | undefined
    const { calls } = mockApi({
      'POST auth/password': () => [200, { csrfToken: 'new' }],
      'DELETE auth/passkeys/a%2Fb%2Bc': () => [204],
      'PATCH users/u1': () => [200, {}],
      'POST users/u1/reset-2fa': () => [204],
      'POST users/u1/password': () => [204],
      'POST users': () => [200, {}],
      'PUT connections/c1/grants/u2': () => [204],
      'GET audit': (_b, url) => {
        auditUrl = url
        return [200, []]
      },
    })
    await accountApi.changePassword('old', 'new-password-123')
    await accountApi.deletePasskey('a/b+c', 'pw')
    await usersApi.update('u1', { role: 'viewer', currentPassword: 'mine' })
    await usersApi.reset2fa('u1', 'mine')
    await usersApi.resetPassword('u1', 'their-new-password-1', 'mine')
    await usersApi.create('eve', 'eve-password-2026-x', 'viewer', 'mine')
    await grantsApi.set('c1', 'u2', null)
    await auditApi.list({ limit: 50, beforeId: 10, action: 'users.create' })
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', 'auth/password', { currentPassword: 'old', newPassword: 'new-password-123' }],
      ['DELETE', 'auth/passkeys/a%2Fb%2Bc', { password: 'pw' }],
      // Security audit 2026-10-16: confirmed with the administrator's own password.
      ['PATCH', 'users/u1', { role: 'viewer', currentPassword: 'mine' }],
      ['POST', 'users/u1/reset-2fa', { currentPassword: 'mine' }],
      ['POST', 'users/u1/password', { password: 'their-new-password-1', currentPassword: 'mine' }],
      [
        'POST',
        'users',
        {
          username: 'eve',
          password: 'eve-password-2026-x',
          role: 'viewer',
          requireTwoFactor: false,
          currentPassword: 'mine',
        },
      ],
      ['PUT', 'connections/c1/grants/u2', { role: null }],
      ['GET', 'audit', undefined],
    ])
    expect(Object.fromEntries(auditUrl!.searchParams)).toEqual({
      limit: '50',
      beforeId: '10',
      action: 'users.create',
    })
  })
})

describe('prompt dialogs', () => {
  it('resolve with the typed value, or null when cancelled', async () => {
    mountApp(DialogHost)
    const dialogs = useDialogStore()
    const first = dialogs.prompt({
      title: 'Password',
      message: 'Enter it',
      input: { type: 'password', label: 'Your password' },
    })
    await nextTick()
    const input = document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement
    expect(input.type).toBe('password')
    expect((document.querySelector('[data-test="confirm"]') as HTMLButtonElement).disabled).toBe(true)
    await typeInto(input, 'secret')
    input.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(await first).toBe('secret')
    await flushPromises()
    const second = dialogs.prompt({
      title: 'Name',
      message: 'm',
      input: { type: 'text', label: 'Name', value: 'old' },
    })
    await nextTick()
    expect((document.querySelector('[data-test="prompt-input"] input') as HTMLInputElement).value).toBe('old')
    ;(document.querySelector('[data-test="cancel"]') as HTMLButtonElement).click()
    expect(await second).toBeNull()
  })
})
