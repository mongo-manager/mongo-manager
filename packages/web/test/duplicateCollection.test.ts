// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { JobView } from '@mongo-manager/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DuplicateCollectionDialog from '../src/connections/DuplicateCollectionDialog.vue'
import { useTabsStore } from '../src/stores/tabs'
import { useToastStore } from '../src/stores/toasts'
import { useJobsStore } from '../src/jobs/store'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button, byLabel, typeInto } from './support/dom'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PATH = 'connections/c1/databases/shop/collections/orders/duplicate'
const JOB: JobView = {
  id: 'j1',
  kind: 'index.create',
  connectionId: 'c1',
  targetConnectionId: null,
  db: 'shop',
  coll: 'orders',
  target: 'n_1',
  state: 'running',
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}

describe('duplicating a collection (audit minor: the server route had no UI)', () => {
  it('asks for the new name, starts the copy in the background and says indexes are not copied', async () => {
    const job = { ...JOB, kind: 'collection.duplicate', target: 'orders_2026' }
    const { calls } = mockApi({ [`POST ${PATH}`]: () => [202, { job }] })
    const closed = vi.fn()
    mountApp(DuplicateCollectionDialog, {
      props: { connectionId: 'c1', db: 'shop', coll: 'orders', onClose: closed },
    })
    await flushPromises()
    expect(byLabel<HTMLInputElement>('New collection name').value).toBe('orders_copy')
    expect(document.body.textContent).toContain('Indexes are not copied.')
    await typeInto(byLabel('New collection name'), 'orders_2026')
    button('Duplicate').click()
    await flushPromises()
    expect(calls.find((c) => c.path === PATH)!.body).toEqual({ to: 'orders_2026' })
    // Phase 1h: the copy runs as a job; the tray follows it and the tree refreshes when it is done.
    expect(useJobsStore().byId.j1).toMatchObject({ target: 'orders_2026', state: 'running' })
    expect(useTabsStore().active).not.toMatchObject({ params: { coll: 'orders_2026' } })
    expect(useToastStore().toasts.at(-1)?.message).toBe(
      'Duplication started. You can follow it under Background jobs.',
    )
    expect(closed).toHaveBeenCalled()
  })

  it('shows a name conflict next to the field', async () => {
    mockApi({
      [`POST ${PATH}`]: () => [
        409,
        { code: 'CONFLICT', message: 'A collection or view with that name already exists' },
      ],
    })
    mountApp(DuplicateCollectionDialog, { props: { connectionId: 'c1', db: 'shop', coll: 'orders' } })
    await flushPromises()
    button('Duplicate').click()
    await flushPromises()
    expect(document.body.textContent).toContain('A collection or view with this name already exists.')
    expect(byLabel('New collection name').getAttribute('aria-invalid')).toBe('true')
  })
})
