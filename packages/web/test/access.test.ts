// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AccessCard from '../src/workspace/tabs/AccessCard.vue'
import { i18n } from '../src/i18n'
import { useToastStore } from '../src/stores/toasts'
import { mockApi, mountApp } from './support/app'
import { choose } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('connection access', () => {
  it('shows each user’s grant and saves changes immediately', async () => {
    const { calls } = mockApi({
      'GET users': () => [
        200,
        [
          {
            id: 'u1',
            username: 'ada',
            role: 'admin',
            totpEnabled: false,
            disabled: false,
            createdAt: 0,
            passwordChangedAt: 0,
          },
          {
            id: 'u2',
            username: 'bob',
            role: 'editor',
            totpEnabled: false,
            disabled: false,
            createdAt: 0,
            passwordChangedAt: 0,
          },
          {
            id: 'u3',
            username: 'cem',
            role: 'viewer',
            totpEnabled: false,
            disabled: false,
            createdAt: 0,
            passwordChangedAt: 0,
          },
        ],
      ],
      'GET connections/c1/grants': () => [200, [{ userId: 'u3', role: 'none' }]],
      'PUT connections/c1/grants/u2': () => [204],
      'PUT connections/c1/grants/u3': () => [204],
    })
    mountApp(AccessCard, { props: { connection: { id: 'c1', name: 'Prod' } } })
    await flushPromises()
    // The kit's select is named by a (visually hidden) label; none for an admin.
    const select = (name: string) => {
      const label = [...document.querySelectorAll('label')].find(
        (l) => l.textContent?.trim() === `Access of ${name}`,
      )
      return (label ? document.getElementById(label.htmlFor) : null) as HTMLSelectElement
    }
    expect(select('ada')).toBeNull()
    expect(document.body.textContent).toContain('Admins always have full access.')
    expect(select('bob').value).toBe('inherit')
    expect(select('bob').selectedOptions[0]!.textContent).toBe('Inherit (editor)')
    expect(select('cem').value).toBe('none')
    await choose(select('bob'), 'viewer')
    await flushPromises()
    await choose(select('cem'), 'inherit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['connections/c1/grants/u2', { role: 'viewer' }],
      ['connections/c1/grants/u3', { role: null }],
    ])
    expect(useToastStore().toasts.at(-1)?.message).toBe('Access of cem updated.')
  })
})
