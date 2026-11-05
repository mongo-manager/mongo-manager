// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import WatchView from '../src/watch/WatchView.vue'
import { resetWatchFeeds } from '../src/watch/feeds'
import { mountApp } from './support/app'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { event, fakeSocket } from './support/watch'

const live = vi.hoisted(() => ({ socket: null as unknown }))
vi.mock('../src/jobs/live', () => ({ realtimeSocket: () => live.socket }))
const downloads = vi.hoisted(() => ({
  text: [] as Array<[string, string]>,
  json: [] as Array<[unknown, string]>,
}))
vi.mock('../src/download', () => ({
  downloadText: (text: string, name: string) => downloads.text.push([text, name]),
  downloadJson: (data: unknown, name: string) => downloads.json.push([data, name]),
}))

const collection = { connectionId: 'c1', scope: 'collection' as const, db: 'shop', coll: 'orders' }
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  downloads.text.length = 0
  downloads.json.length = 0
})
afterEach(() => {
  resetWatchFeeds()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

async function view(target: object = collection, canExport = true, extra: Record<string, unknown> = {}) {
  const s = fakeSocket()
  live.socket = s.socket
  const { wrapper } = mountApp(WatchView, { props: { target, canExport, ...extra } })
  const { id } = s.lastSub()
  const send = async (type: string, payload: Record<string, unknown> = {}) => {
    s.deliver({ type, payload: { id, ...payload } })
    await flushPromises()
  }
  await send('started', { preImages: false, resumed: false })
  return { s, wrapper, id, send }
}

describe('the Watch view (phase 3e-1 spec §4.2)', () => {
  it('waits for changes, then lists them newest first with words beside the colours', async () => {
    const v = await view()
    expect(v.wrapper.text()).toContain('Waiting for changes…')
    expect(v.wrapper.text()).toContain('Live')
    await v.send('events', {
      events: [event(1), event(2, { op: 'delete', fullDocument: undefined })],
      lagMs: 10,
    })
    const rows = v.wrapper.findAll('[data-watch-row]')
    expect(rows.map((r) => r.find('[data-op]').text())).toEqual(['Delete', 'Insert'])
    expect(rows[0]!.attributes('aria-label')).toMatch(/^Delete 2, /)
    expect(v.wrapper.text()).toContain('2 events')
    // A truncated key keeps its full text on hover (UI review).
    expect(rows[0]!.find('[data-watch-key]').attributes('title')).toBe('2')
    // One way to the filter editor: "Edit filter" beside the chips, not a second toolbar button.
    expect(v.wrapper.find('[role="toolbar"]').text()).not.toContain('Filters')
  })

  it('names each event’s namespace at the database scope', async () => {
    const v = await view({ connectionId: 'c1', scope: 'database', db: 'shop' })
    await v.send('events', { events: [event(1, { ns: { db: 'shop', coll: 'people' } })], lagMs: 0 })
    expect(v.wrapper.find('[data-watch-row]').text()).toContain('people')
  })

  it('shows an update as a diff with pre-images, and the updated values with a hint without', async () => {
    const v = await view()
    const before = { _id: { $numberInt: '1' }, status: 'new', total: { $numberInt: '5' } }
    const after = { _id: { $numberInt: '1' }, status: 'paid', total: { $numberInt: '5' } }
    await v.send('events', {
      events: [
        event(1, {
          op: 'update',
          before,
          fullDocument: after,
          update: { updated: { status: 'paid' }, removed: [], truncated: [] },
        }),
        event(2, {
          op: 'update',
          fullDocument: undefined,
          update: {
            updated: { status: 'void' },
            removed: ['note'],
            truncated: [{ field: 'items', newSize: 1 }],
          },
        }),
      ],
      lagMs: 0,
    })
    const rows = v.wrapper.findAll('[data-watch-row]')
    await rows[1]!.trigger('click')
    const detail = v.wrapper.find('[data-watch-detail]')
    expect(detail.text()).toContain('status')
    expect(detail.text()).toContain('"new"')
    expect(detail.text()).toContain('"paid"')
    await rows[0]!.trigger('click')
    const plain = v.wrapper.find('[data-watch-detail]')
    expect(plain.text()).toContain('Updated')
    expect(plain.text()).toContain('note')
    expect(plain.text()).toContain('items to 1 items')
    expect(plain.text()).toContain('Turn on pre-images for this collection')
    expect(plain.find('a[href$="watch.html#pre-images"]').exists()).toBe(true)
  })

  // UI review: pre-images without "Show the whole document" still give a before/after diff.
  it('diffs an update from its before-image and update description alone', async () => {
    const v = await view()
    await v.send('events', {
      events: [
        event(1, {
          op: 'update',
          before: {
            _id: { $numberInt: '1' },
            status: 'new',
            items: [{ qty: { $numberInt: '1' } }],
            note: 'x',
          },
          fullDocument: undefined,
          update: {
            updated: { status: 'paid', 'items.0.qty': { $numberInt: '3' } },
            removed: ['note'],
            truncated: [],
          },
        }),
      ],
      lagMs: 0,
    })
    await v.wrapper.find('[data-watch-row]').trigger('click')
    const detail = v.wrapper.find('[data-watch-detail]')
    const text = detail.text()
    for (const shown of ['status', '"new"', '"paid"', 'items.0.qty', 'note', '"x"'])
      expect(text).toContain(shown)
    expect(text).not.toContain('Turn on pre-images')
  })

  it('shows a deleted document as it was, from its before-image, and shortened arrays beside a diff', async () => {
    const v = await view()
    await v.send('events', {
      events: [
        event(1, {
          op: 'update',
          before: { _id: { $numberInt: '1' }, items: [1, 2, 3] },
          fullDocument: undefined,
          update: { updated: {}, removed: [], truncated: [{ field: 'items', newSize: 1 }] },
        }),
        event(2, {
          op: 'delete',
          fullDocument: undefined,
          before: { _id: { $numberInt: '2' }, sku: 'gone-sku' },
        }),
      ],
      lagMs: 0,
    })
    const rows = v.wrapper.findAll('[data-watch-row]')
    await rows[0]!.trigger('click')
    expect(v.wrapper.find('[data-watch-detail]').text()).toContain('gone-sku')
    await rows[1]!.trigger('click')
    expect(v.wrapper.find('[data-watch-detail]').text()).toContain('items to 1 items')
  })

  it('pauses with Space on its toolbar, then catches up or starts from now', async () => {
    const v = await view()
    await v.wrapper.find('[role="toolbar"]').trigger('keydown', { key: ' ' })
    expect(v.s.sent.at(-1)).toEqual({ ch: 'watch', type: 'pause', id: v.id })
    await v.send('paused')
    expect(v.wrapper.text()).toContain('Paused')
    await v.wrapper.get('[data-watch-catch-up]').trigger('click')
    expect(v.s.sent.at(-1)).toEqual({ ch: 'watch', type: 'resume', id: v.id, from: 'here' })
    await v.send('resumed', { from: 'here' })
    await v.wrapper.get('[data-watch-pause]').trigger('click')
    await v.send('paused')
    await v.wrapper.get('[data-watch-from-now]').trigger('click')
    expect(v.s.sent.at(-1)).toEqual({ ch: 'watch', type: 'resume', id: v.id, from: 'now' })
  })

  it('restarts when an operation type is turned off and says so; shows a refused filter at the editor', async () => {
    const v = await view()
    await v.wrapper.get('[data-watch-chip="delete"]').trigger('click')
    const next = v.s.lastSub()
    expect(next.id).not.toBe(v.id)
    expect(next.options).toMatchObject({ ops: ['insert', 'update', 'replace'] })
    await flushPromises()
    expect(v.wrapper.text()).toContain('Filters changed: the feed started again from now.')
    v.s.deliver({
      type: 'error',
      payload: { id: next.id, reason: 'masking_filter', detail: 'fullDocument.email' },
    })
    await flushPromises()
    const editor = v.wrapper.find('[data-watch-filter-editor]')
    expect(editor.exists()).toBe(true)
    expect(editor.text()).toContain('This filter uses a field hidden from you (fullDocument.email).')
    // Said once, at the editor; the list asks for the filter to be fixed, with no "Start again".
    expect(v.wrapper.text().split('This filter uses a field hidden from you').length - 1).toBe(1)
    expect(v.wrapper.text()).toContain('Fix the filter above to start the feed.')
    expect(v.wrapper.find('[data-watch-start-again]').exists()).toBe(false)
  })

  it('refuses a filter that does not parse, in words, without restarting', async () => {
    const v = await view()
    await v.wrapper.get('[data-watch-filter-toggle]').trigger('click')
    const input = v.wrapper.find('[data-watch-filter-editor] textarea')
    await input.setValue('{ status: ')
    await v.wrapper.get('[data-watch-filter-apply]').trigger('click')
    expect(v.wrapper.text()).toContain('Not a valid filter')
    expect(v.s.lastSub().id).toBe(v.id)
    await input.setValue("{ 'fullDocument.status': 'paid' }")
    await v.wrapper.get('[data-watch-filter-apply]').trigger('click')
    expect(v.s.lastSub().filter).toEqual({ 'fullDocument.status': 'paid' })
  })

  it('exports what it shows, oldest first, and hides export without the right', async () => {
    const v = await view()
    await v.send('events', { events: [event(1), event(2)], lagMs: 0 })
    // A labelled trigger a keyboard reaches, not a bare icon (UI review).
    const trigger = v.wrapper.get('[data-watch-export] button')
    expect(trigger.text()).toBe('Export')
    expect(trigger.attributes('tabindex')).toBe('0')
    await trigger.trigger('click')
    // The menu is teleported to the body.
    ;(document.querySelector('[role="menuitem"]') as HTMLElement).click()
    await flushPromises()
    const [text, name] = downloads.text[0]!
    expect(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).seq),
    ).toEqual([1, 2])
    expect(text).not.toContain('"key"')
    expect(name).toMatch(/^watch-shop\.orders-.*\.ndjson$/)
    resetWatchFeeds()
    const hidden = await view(collection, false)
    expect(hidden.wrapper.find('[data-watch-export]').exists()).toBe(false)
  })

  it('says how a reconnect went, and why a feed ended, with a way to start again', async () => {
    const v = await view()
    v.s.drop()
    await flushPromises()
    expect(v.wrapper.text()).toContain('Reconnecting…')
    v.s.reopen()
    await v.send('started', { preImages: false, resumed: true })
    expect(v.wrapper.text()).toContain('Reconnected and resumed without missing anything.')
    await v.send('ended', { reason: 'invalidate' })
    expect(v.wrapper.text()).toContain('The collection was dropped or renamed, so this feed ended.')
    await v.wrapper.get('[data-watch-start-again]').trigger('click')
    expect(v.s.lastSub().id).not.toBe(v.id)
  })

  it('announces new changes politely, in batches', async () => {
    // Only the announcer's interval: flushPromises needs real timeouts.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const v = await view()
    await v.send('events', { events: [1, 2, 3, 4, 5].map((n) => event(n)), lagMs: 0 })
    vi.advanceTimersByTime(2_000)
    await flushPromises()
    const region = v.wrapper.find('[aria-live="polite"]')
    expect(region.text()).toBe('5 new changes')
  })

  // UI review: a feed that did not start never looks live (no green, no pulse).
  it('marks a refused or ended feed in neutral colours', async () => {
    const v = await view()
    expect(v.wrapper.get('[data-watch-status]').classes()).toContain('text-success')
    await v.send('error', { reason: 'internal' })
    const pill = v.wrapper.get('[data-watch-status]')
    expect(pill.classes().some((c) => c.includes('success'))).toBe(false)
    expect(
      pill
        .get('span')
        .classes()
        .some((c) => c.includes('animate')),
    ).toBe(false)
    // The dot has its own colour, never inherited.
    expect(pill.get('span').classes()).toContain('bg-fg-subtle')
  })

  it('marks an ended feed in neutral colours too, also after its events', async () => {
    const v = await view()
    await v.send('events', { events: [event(1)], lagMs: 0 })
    await v.send('ended', { reason: 'invalidate' })
    const pill = v.wrapper.get('[data-watch-status]')
    expect(pill.text()).toBe('Ended')
    expect(pill.classes().some((c) => c.includes('success'))).toBe(false)
    expect(pill.get('span').classes()).toContain('bg-fg-subtle')
  })

  // UI review: where watching cannot work here, no futile "Start again" and no filters to set.
  it('offers neither Start again nor filters on a standalone server, a view or with watching off', async () => {
    for (const reason of ['not_replica_set', 'view', 'turned_off']) {
      resetWatchFeeds()
      const v = await view()
      await v.send('error', { reason })
      expect(v.wrapper.find('[data-watch-start-again]').exists()).toBe(false)
      expect(v.wrapper.find('[data-watch-chip]').exists()).toBe(false)
      // Nothing to export yet.
      expect(v.wrapper.find('[data-watch-export]').exists()).toBe(false)
    }
  })

  // Final review C1/I6: what was left out is named beside the event, never read from a document.
  it('says which parts were too large, and shows a document whose own field is "elided"', async () => {
    const v = await view()
    await v.send('events', {
      events: [
        event(1, {
          fullDocument: undefined,
          before: undefined,
          elided: { fullDocument: 300_000, before: 400_000 },
        }),
        event(2, { fullDocument: { _id: { $numberInt: '2' }, elided: true, note: 'kept' } }),
      ],
      lagMs: 0,
    })
    const rows = v.wrapper.findAll('[data-watch-row]')
    await rows[1]!.trigger('click')
    const text = v.wrapper.get('[data-watch-detail]').text()
    expect(text).toContain('This document is 293 KB, too large for the feed.')
    expect(text).toContain('The document before the change is 390.6 KB, too large for the feed.')
    await rows[0]!.trigger('click')
    expect(v.wrapper.get('[data-watch-detail]').text()).toContain('kept')
  })

  it('speaks Turkish', async () => {
    i18n.global.locale.value = 'tr'
    const v = await view()
    expect(v.wrapper.text()).toContain('Değişiklikler bekleniyor…')
    expect(v.wrapper.text()).toContain('Canlı')
  })

  // Final review M4: a collection that does not exist yet.
  it('says a collection does not exist yet, and that its changes will come', async () => {
    const v = await view()
    await v.send('started', { preImages: false, resumed: false, gap: false, paused: false, exists: false })
    expect(v.wrapper.text()).toContain(
      'This collection does not exist yet. Its changes will appear here once it is created.',
    )
  })

  // Final review I5: a resume that may have missed changes says so.
  it('says when a reconnect may have missed changes', async () => {
    const v = await view()
    v.s.drop()
    v.s.reopen()
    await v.send('started', { preImages: false, resumed: true, gap: true, paused: false, exists: true })
    expect(v.wrapper.text()).toContain('Reconnected, but some changes made meanwhile may be missing.')
  })

  // Final review M5: the dead ends point to the guide; a view points to the collection it reads.
  it('links the guide where watching cannot work, and offers a view’s collection', async () => {
    const v = await view()
    await v.send('error', { reason: 'not_replica_set' })
    expect(v.wrapper.find('a[href$="watch.html#requirements"]').exists()).toBe(true)
    resetWatchFeeds()
    const w = await view(collection, true, { viewOn: 'orders_raw' })
    await w.send('error', { reason: 'view' })
    const button = w.wrapper.get('[data-watch-view-source]')
    expect(button.text()).toBe('Watch orders_raw')
    await button.trigger('click')
    const tabs = useTabsStore()
    expect(tabs.active?.params).toMatchObject({ db: 'shop', coll: 'orders_raw' })
    expect(useCollectionViewsStore().stateFor(tabs.active!.id).section).toBe('watch')
  })

  // Final review M9.
  it('says a delete without pre-images has no document, and hides Open document for a hidden key', async () => {
    const v = await view()
    await v.send('events', {
      events: [
        event(1, { op: 'delete', fullDocument: undefined }),
        event(2, { op: 'delete', fullDocument: undefined, documentKey: { _id: { tenant: '***', n: 2 } } }),
      ],
      lagMs: 0,
    })
    const rows = v.wrapper.findAll('[data-watch-row]')
    await rows[1]!.trigger('click')
    expect(v.wrapper.get('[data-watch-detail]').text()).toContain(
      'MongoDB sends only the key of a deleted document.',
    )
    expect(v.wrapper.find('[data-watch-open]').exists()).toBe(true)
    await rows[0]!.trigger('click')
    expect(v.wrapper.find('[data-watch-open]').exists()).toBe(false)
  })

  it('moves between Changes and JSON with the arrow keys, and copies only where the browser can', async () => {
    const v = await view()
    await v.send('events', { events: [event(1)], lagMs: 0 })
    await v.wrapper.get('[data-watch-row]').trigger('click')
    const tabs = v.wrapper.findAll('[data-watch-detail] [role="tab"]')
    expect(tabs[0]!.attributes('aria-controls')).toBeTruthy()
    expect(v.wrapper.find(`#${tabs[0]!.attributes('aria-controls')}`).exists()).toBe(true)
    await tabs[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(v.wrapper.findAll('[data-watch-detail] [role="tab"]')[1]!.attributes('aria-selected')).toBe('true')
    // With a clipboard: copies, then says so.
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    resetWatchFeeds()
    const w = await view()
    await w.send('events', { events: [event(1)], lagMs: 0 })
    await w.wrapper.get('[data-watch-row]').trigger('click')
    await w.wrapper.get('[data-watch-copy]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledOnce()
    expect(w.wrapper.get('[data-watch-copy]').text()).toBe('Copied')
    // Without one: no copy button that cannot copy.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    resetWatchFeeds()
    const x = await view()
    await x.send('events', { events: [event(1)], lagMs: 0 })
    await x.wrapper.get('[data-watch-row]').trigger('click')
    expect(x.wrapper.find('[data-watch-copy]').exists()).toBe(false)
  })
})
