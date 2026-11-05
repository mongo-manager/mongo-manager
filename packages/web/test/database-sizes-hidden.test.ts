// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DatabaseTab from '../src/workspace/tabs/DatabaseTab.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'

/**
 * 2026-10-26 (user report: "why does it say hidden for the data size too?"): a database's page hid
 * its sizes where personal data is hidden in it — a size tells the length of what is hidden — but
 * never said why. It says so, as a collection's page does, and an administrator is taken to the rules.
 */
const connection = (permissions: string[]) => ({
  id: 'c1',
  name: 'Prod',
  group: null,
  color: null,
  favorite: false,
  readOnly: false,
  settings: {},
  uri: 'mongodb://h/shop',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  access: 'admin',
  permissions,
  export: false,
  shell: false,
})
const STATS = (hidden: boolean) => ({
  collections: 4,
  views: 2,
  objects: 342,
  indexes: 9,
  dataSize: hidden ? null : 2048,
  storageSize: hidden ? null : 4096,
  indexSize: hidden ? null : 1024,
  ...(hidden ? { sizesHidden: true } : {}),
})
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

async function opened(hidden: boolean, permissions = ['databases:read', 'connections:manage']) {
  mockApi({
    'GET connections': () => [200, [connection(permissions)]],
    'GET connections/c1/databases': () => [
      200,
      { databases: [{ name: 'shop', sizeOnDisk: 1, empty: false }], totalSize: 1 },
    ],
    'GET connections/c1/databases/shop/collections': () => [200, []],
    'GET connections/c1/databases/shop/stats': () => [200, STATS(hidden)],
  })
  mountApp(DatabaseTab, { props: { connectionId: 'c1', db: 'shop' } })
  await flushPromises()
}
const note = () => document.querySelector<HTMLElement>('[data-sizes-hidden]')

describe('a database’s sizes hidden for personal data', () => {
  it('says why, once, under the figures', async () => {
    await opened(true)
    expect(note()!.textContent).toContain(
      'Sizes are hidden: rules hide personal data here from you, and a size would tell its length.',
    )
  })

  it('takes an administrator to the database’s personal data rules', async () => {
    await opened(true)
    const go = note()!.querySelector<HTMLButtonElement>('button')!
    expect(go.textContent!.trim()).toBe('See the rules')
    go.click()
    await flushPromises()
    const chosen = document.querySelector(
      '[role="tablist"][aria-label="Database sections"] [aria-selected="true"]',
    )
    expect(chosen!.textContent!.trim()).toBe('Personal data')
    // The button is gone with the overview: the focus goes to the tab it opened, not the page.
    expect(document.activeElement).toBe(chosen)
  })

  it('offers no way to the rules to one who cannot manage them', async () => {
    await opened(true, ['databases:read'])
    expect(note()).not.toBeNull()
    expect(note()!.querySelector('button')).toBeNull()
  })

  it('says nothing when the sizes are shown', async () => {
    await opened(false)
    expect(note()).toBeNull()
  })

  it('says so in Turkish', async () => {
    i18n.global.locale.value = 'tr'
    await opened(true)
    expect(note()!.textContent).toContain('Boyutlar gizli')
    expect(note()!.querySelector('button')!.textContent!.trim()).toBe('Kurallara bak')
  })
})
