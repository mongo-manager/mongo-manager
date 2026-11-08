// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { DestinationSummary, RemoteBackup } from '@mongo-manager/shared'
import RemoteList from '../src/backup/RemoteList.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, choose } from './support/dom'

/** W4 item 5: thawing an archived copy from the destination's list, and its waiting state. */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const S3: DestinationSummary = {
  id: 'd1',
  name: 'Glacier',
  type: 's3',
  level: 'browse',
  policy: { encryptedOnly: true },
}
const row = (over: Partial<RemoteBackup>): RemoteBackup => ({
  key: 'mongo-manager/2026/10/mm-1.mmbak',
  name: 'mm-1.mmbak',
  size: 1000,
  createdAt: Date.now() - 86_400_000,
  format: 'mmbak',
  archived: true,
  thaw: 'none',
  state: 'complete',
  copyId: 'k1',
  sender: 'me',
  mine: true,
  scope: { kind: 'database', db: 'shop', views: true },
  connectionId: 'c1',
  masked: false,
  anonymous: false,
  ...over,
})

describe('thawing an archived copy (W4.5)', () => {
  it('asks for the days and the speed, and sends the thaw', async () => {
    let thawing = false
    const { calls } = mockApi({
      'GET backup-destinations/d1/backups': () => [
        200,
        { items: [row({ thaw: thawing ? 'thawing' : 'none' })], cursor: null },
      ],
      'POST backup-destinations/d1/backups/thaw': () => {
        thawing = true
        return [200, { state: 'thawing' }]
      },
    })
    mountApp(RemoteList, { props: { destination: S3, connectionId: 'c1', canRestore: true } })
    await flushPromises()
    // Archived: no restore yet, a thaw instead.
    expect(document.querySelector('[data-action="restore"]')).toBeNull()
    document.querySelector<HTMLButtonElement>('[data-action="thaw"]')!.click()
    await flushPromises()
    await choose(byLabel<HTMLSelectElement>('Keep it readable for'), '7')
    await choose(byLabel<HTMLSelectElement>('Speed'), 'Bulk')
    button('Start the thaw').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/thaw'))!.body).toEqual({
      key: 'mongo-manager/2026/10/mm-1.mmbak',
      days: 7,
      tier: 'Bulk',
    })
    await flushPromises()
    expect(document.querySelector('[data-remote-row]')!.textContent).toContain('Thawing')
  })

  it('shows a thaw under way as waiting, with no restore and no second thaw', async () => {
    mockApi({
      'GET backup-destinations/d1/backups': () => [200, { items: [row({ thaw: 'thawing' })], cursor: null }],
    })
    mountApp(RemoteList, { props: { destination: S3, connectionId: 'c1', canRestore: true } })
    await flushPromises()
    expect(document.querySelector('[data-remote-row]')!.textContent).toContain('Thawing')
    expect(document.querySelector('[data-action="thaw"]')).toBeNull()
    expect(document.querySelector('[data-action="restore"]')).toBeNull()
  })

  it('offers the restore once the copy is thawed', async () => {
    mockApi({
      'GET backup-destinations/d1/backups': () => [
        200,
        { items: [row({ archived: false, thaw: 'thawed' })], cursor: null },
      ],
    })
    mountApp(RemoteList, { props: { destination: S3, connectionId: 'c1', canRestore: true } })
    await flushPromises()
    expect(document.querySelector('[data-action="restore"]')).toBeTruthy()
    expect(document.querySelector('[data-remote-row]')!.textContent).toContain('Thawed')
  })

  it('rehydrates an Azure blob with a priority only (it stays in Cool: no days)', async () => {
    const { calls } = mockApi({
      'GET backup-destinations/d1/backups': () => [200, { items: [row({})], cursor: null }],
      'POST backup-destinations/d1/backups/thaw': () => [200, { state: 'thawing' }],
    })
    mountApp(RemoteList, {
      props: { destination: { ...S3, type: 'azure' }, connectionId: 'c1', canRestore: true },
    })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-action="thaw"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-test="thaw-form"]')!.textContent).not.toContain(
      'Keep it readable for',
    )
    expect(document.body.textContent).toContain('Cool tier for good')
    await choose(byLabel<HTMLSelectElement>('Speed'), 'Expedited')
    expect(byLabel<HTMLSelectElement>('Speed').selectedOptions[0]!.textContent).toContain('High priority')
    button('Start the thaw').click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/thaw'))!.body).toMatchObject({ tier: 'Expedited' })
  })
})
