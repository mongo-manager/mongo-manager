// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import WatchView from '../src/watch/WatchView.vue'
import DialogHost from '../src/ds/DsConfirmHost.vue'
import ToastHost from '../src/ds/DsToastHost.vue'
import { resetWatchFeeds } from '../src/watch/feeds'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'
import { fakeSocket } from './support/watch'

/** W4 item 7 (completion design §2 W4.7): the Watch page's new parts. */
const live = vi.hoisted(() => ({ socket: null as unknown }))
vi.mock('../src/jobs/live', () => ({ realtimeSocket: () => live.socket }))

const collection = { connectionId: 'c1', scope: 'collection' as const, db: 'shop', coll: 'orders' }
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  resetWatchFeeds()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function view(extra: Record<string, unknown> = {}, preImages = false) {
  const s = fakeSocket()
  live.socket = s.socket
  const { wrapper } = mountApp(WatchView, { props: { target: collection, canExport: true, ...extra } })
  mountApp(DialogHost)
  mountApp(ToastHost)
  const { id } = s.lastSub()
  s.deliver({ type: 'started', payload: { id, preImages, resumed: false } })
  await flushPromises()
  return { s, wrapper, id }
}

describe('pre- and post-images from the Watch page (W4.7)', () => {
  it('offers who may change the collection to turn them on, after saying what it costs', async () => {
    const { calls } = mockApi({
      'PUT connections/c1/databases/shop/collections/orders/pre-images': () => [200, { enabled: true }],
    })
    const v = await view({ canChangeOptions: true })
    const bar = v.wrapper.find('[data-watch-pre-images]')
    expect(bar.text()).toContain('keeps no pre- and post-images')
    button('Turn on pre- and post-images').click()
    await flushPromises()
    expect(document.body.textContent).toContain('It costs storage')
    // The dialog's own button confirms.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) =>
      b.textContent?.includes('Turn on pre- and post-images'),
    )!
    confirm.click()
    await flushPromises()
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ enabled: true })
    expect(v.wrapper.find('[data-watch-pre-images]').exists()).toBe(false)
    expect(document.body.textContent).toContain('Pre- and post-images are on')
  })

  it('offers nothing without the right, nor where the collection keeps them already', async () => {
    expect((await view({ canChangeOptions: false })).wrapper.find('[data-watch-pre-images]').exists()).toBe(
      false,
    )
    resetWatchFeeds()
    document.body.innerHTML = ''
    expect(
      (await view({ canChangeOptions: true }, true)).wrapper.find('[data-watch-pre-images]').exists(),
    ).toBe(false)
  })
})

describe('recorded feeds and the alert hook (W4.7)', () => {
  it('asks the server to record (with the export right) and to alert, and says when it records', async () => {
    const v = await view()
    const record = v.wrapper.find('[data-watch-record] input')
    await record.setValue(true)
    await flushPromises()
    expect(v.s.lastSub().options).toMatchObject({ record: true, alert: false })
    await v.wrapper.find('[data-watch-alert] input').setValue(true)
    await flushPromises()
    const sub = v.s.lastSub()
    expect(sub.options).toMatchObject({ record: true, alert: true })
    v.s.deliver({
      type: 'started',
      payload: { id: sub.id, preImages: false, resumed: false, recording: true },
    })
    await flushPromises()
    expect(v.wrapper.find('[data-watch-recording]').text()).toBe('Recording')
    v.s.deliver({ type: 'recording', payload: { id: sub.id, state: 'full' } })
    await flushPromises()
    expect(v.wrapper.text()).toContain('The recording stopped: its file is full')
    expect(v.wrapper.find('[data-watch-recording]').exists()).toBe(false)
  })

  it('offers no recording without the export right', async () => {
    const v = await view({ canExport: false })
    expect(v.wrapper.find('[data-watch-record]').exists()).toBe(false)
    expect(v.wrapper.find('[data-watch-recordings-toggle]').exists()).toBe(false)
    expect(v.wrapper.find('[data-watch-alert]').exists()).toBe(true)
  })

  it('lists recordings, replays one in place of the live feed, and goes back to it', async () => {
    const recorded = [
      {
        seq: 1,
        op: 'insert',
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: 'a' },
        clusterTime: 1,
        masked: false,
        bytes: 10,
      },
      {
        seq: 2,
        op: 'delete',
        ns: { db: 'shop', coll: 'orders' },
        documentKey: { _id: 'b' },
        clusterTime: 2,
        masked: false,
        bytes: 10,
      },
    ]
    mockApi({
      'GET connections/c1/watch/recordings': () => [
        200,
        [
          {
            id: 'f1',
            name: 'watch-shop.orders-20261016T120000',
            namespace: 'shop.orders',
            size: 200,
            createdAt: Date.UTC(2026, 9, 16, 12),
            expiresAt: Date.UTC(2026, 9, 17),
            masked: false,
            recording: false,
          },
        ],
      ],
      // W4 review I9: read a page at a time from the server.
      'GET connections/c1/watch/recordings/f1/events': (_b, url) => {
        const from = Number(url.searchParams.get('from'))
        return [
          200,
          from === 0
            ? { events: [recorded[0]], next: 10, end: false }
            : { events: [recorded[1]], next: 20, end: true },
        ]
      },
    })
    const v = await view()
    await v.wrapper.find('[data-watch-recordings-toggle]').trigger('click')
    await flushPromises()
    const row = v.wrapper.find('[data-recording]')
    expect(row.text()).toContain('watch-shop.orders-20261016T120000')
    expect(row.find('a[download]').attributes('href')).toMatch(
      /\/api\/connections\/c1\/watch\/recordings\/f1$/,
    )
    await row.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(v.wrapper.find('[data-watch-replay]').text()).toContain(
      'Replaying watch-shop.orders-20261016T120000: 1 events',
    )
    // The rest, a page at a time, on demand.
    await v.wrapper.find('[data-replay-more]').trigger('click')
    await flushPromises()
    expect(v.wrapper.find('[data-watch-replay]').text()).toContain(': 2 events')
    expect(v.wrapper.find('[data-replay-more]').exists()).toBe(false)
    const rows = v.wrapper.findAll('[data-watch-row]')
    expect(rows.map((r) => r.find('[data-op]').text())).toEqual(['Delete', 'Insert'])
    await v.wrapper.find('[data-replay-back]').trigger('click')
    await flushPromises()
    expect(v.wrapper.find('[data-watch-replay]').exists()).toBe(false)
  })
})
