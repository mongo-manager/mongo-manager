// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { WatchOptionsSchema } from '@mongo-manager/shared/browser'
import { i18n } from '../src/i18n'
import WatchView from '../src/watch/WatchView.vue'
import { createWatchFeed, resetWatchFeeds, type FeedStatus } from '../src/watch/feeds'
import { useWatchWords } from '../src/watch/words'
import { useTabsStore } from '../src/stores/tabs'
import { useCollectionViewsStore } from '../src/stores/collectionViews'
import { mountApp } from './support/app'
import { event, fakeSocket } from './support/watch'

const live = vi.hoisted(() => ({ socket: null as unknown }))
vi.mock('../src/jobs/live', () => ({ realtimeSocket: () => live.socket }))
const downloads = vi.hoisted(() => ({ json: [] as Array<[unknown, string]> }))
vi.mock('../src/download', () => ({
  downloadText: () => undefined,
  downloadJson: (data: unknown, name: string) => downloads.json.push([data, name]),
}))

const target = { connectionId: 'c1', scope: 'collection' as const, db: 'shop', coll: 'orders' }
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  downloads.json.length = 0
})
afterEach(() => {
  resetWatchFeeds()
  document.body.innerHTML = ''
})

function words() {
  let out!: ReturnType<typeof useWatchWords>
  mount(
    defineComponent({
      setup() {
        out = useWatchWords()
        return () => h('div')
      },
    }),
    { global: { plugins: [i18n] } },
  )
  return out
}
const feedLike = (status: FeedStatus, reason: string | null, detail: string | null = null, lagMs = 0) => ({
  status: ref(status),
  reason: ref(reason),
  detail: ref(detail),
  lagMs: ref(lagMs),
})

describe('Watch words (phase 3e-1 gate)', () => {
  it('says every refusal in the reader’s words, codes included', () => {
    const w = words()
    expect(w.reason(feedLike('refused', 'limit', 'socket') as never)).toContain('This window already has 3')
    expect(w.reason(feedLike('refused', 'limit', 'user') as never)).toContain('You already have 5')
    expect(w.reason(feedLike('refused', 'limit', 'server') as never)).toContain('The server is at its limit')
    expect(w.reason(feedLike('refused', 'limit') as never)).toBe(
      'Too many live feeds: close one and try again.',
    )
    expect(w.reason(feedLike('refused', 'filter', 'size') as never)).toBe('A filter may be at most 12 KB.')
    expect(w.reason(feedLike('refused', 'filter', 'depth') as never)).toBe(
      'A filter may nest at most 20 levels.',
    )
    expect(w.reason(feedLike('refused', 'filter', 'server_js') as never)).toContain('$where')
    expect(w.reason(feedLike('refused', 'filter', 'anything') as never)).toBe('This filter cannot be used.')
    expect(w.reason(feedLike('refused', 'masking_filter', 'scope') as never)).toContain(
      'database and connection feeds',
    )
    expect(w.reason(feedLike('refused', 'masking_filter', 'shape') as never)).toContain('name each field')
    expect(w.reason(feedLike('unavailable', null) as never)).toContain('real-time connection')
    expect(w.reason(feedLike('refused', 'filter', 'ejson') as never)).toBe(
      'This filter is not valid Extended JSON.',
    )
    expect(w.reason(feedLike('refused', 'limit', 'rate') as never)).toBe(
      'Too many feeds were started in the last minute. Wait a moment and try again.',
    )
    expect(w.reason(feedLike('live', null) as never)).toBe('')
    i18n.global.locale.value = 'tr'
    expect(w.reason(feedLike('refused', 'filter', 'size') as never)).toBe('Bir filtre en çok 12 KB olabilir.')
  })

  it('says how far behind a feed is, names unknown operations, and words times', () => {
    const w = words()
    expect(w.status(feedLike('live', null, null, 12_400) as never)).toBe('Behind 12 s')
    // Final review M3: the spec's two seconds.
    expect(w.status(feedLike('live', null, null, 2_600) as never)).toBe('Behind 3 s')
    expect(w.status(feedLike('live', null, null, 1_900) as never)).toBe('Live')
    expect(w.op('reshardCollection')).toBe('Reshard')
    expect(w.op('somethingNew')).toBe('Change')
    const now = Date.UTC(2026, 9, 5, 12)
    expect(w.when(now - 5_000, now)).toBe('5 seconds ago')
    expect(w.when(now - 3 * 60_000, now)).toBe('3 minutes ago')
    expect(w.when(now - 2 * 3_600_000, now)).toBe('2 hours ago')
  })
})

describe('the Watch feed, edges (phase 3e-1 gate)', () => {
  it('ignores an empty batch, forgets old rate samples, and lets a polling socket stop it', () => {
    let clock = 0
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket, () => clock)
    feed.start()
    const { id } = s.lastSub()
    s.deliver({ type: 'events', payload: { id, events: [], lagMs: 0 } })
    expect(feed.total.value).toBe(0)
    s.deliver({ type: 'events', payload: { id, events: [event(1)], lagMs: 0 } })
    clock = 20_000
    s.deliver({ type: 'events', payload: { id, events: [event(2)], lagMs: 0 } })
    expect(feed.rate.value).toBeCloseTo(0.1)
    s.poll()
    expect(feed.status.value).toBe('unavailable')
  })

  it('does nothing on pause or resume before it started, and clears what it shows', () => {
    const s = fakeSocket()
    const feed = createWatchFeed(target, s.socket)
    feed.pause()
    feed.resume('here')
    expect(s.sent).toEqual([])
    feed.start()
    const { id } = s.lastSub()
    s.deliver({ type: 'events', payload: { id, events: [event(1)], lagMs: 0 } })
    feed.clear()
    expect([feed.events.value, feed.total.value, feed.counts.value, feed.rate.value]).toEqual([[], 0, {}, 0])
  })
})

describe('the Watch view, more (phase 3e-1 gate)', () => {
  async function view() {
    const s = fakeSocket()
    live.socket = s.socket
    const { wrapper } = mountApp(WatchView, { props: { target, canExport: true } })
    const { id } = s.lastSub()
    const send = async (type: string, payload: Record<string, unknown> = {}) => {
      s.deliver({ type, payload: { id, ...payload } })
      await flushPromises()
    }
    await send('started', { preImages: null, resumed: false })
    return { s, wrapper, id, send }
  }

  it('exports JSON, oldest first, without the list’s own keys', async () => {
    const v = await view()
    await v.send('events', { events: [event(1), event(2)], lagMs: 0 })
    await v.wrapper.get('[data-watch-export] button').trigger('click')
    ;(document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click()
    await flushPromises()
    const [data, name] = downloads.json[0]!
    expect((data as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2])
    expect(JSON.stringify(data)).not.toContain('"key"')
    expect(name).toMatch(/^watch-shop\.orders-.*\.json$/)
  })

  it('opens a document in its collection’s Documents section, filtered by its _id', async () => {
    const v = await view()
    await v.send('events', { events: [event(7)], lagMs: 0 })
    await v.wrapper.get('[data-watch-row]').trigger('click')
    await v.wrapper.get('[data-watch-open]').trigger('click')
    const tabs = useTabsStore()
    const state = useCollectionViewsStore().stateFor(tabs.activeId!)
    expect(state.section).toBe('documents')
    expect(state.draft.filter).toBe('{ _id: 7 }')
    expect(state.query.filter).toEqual({ _id: { $numberInt: '7' } })
  })

  it('sets operation types and schema changes from the chips and checkboxes', async () => {
    const v = await view()
    const boxes = v.wrapper.findAll('input[type="checkbox"]')
    await boxes[1]!.setValue(true)
    expect(v.s.lastSub().options).toMatchObject({ schemaChanges: true })
    expect((v.s.lastSub().options as { ops: string[] }).ops).toContain('createIndexes')
    await v.wrapper.findAll('input[type="checkbox"]')[1]!.setValue(false)
    expect((v.s.lastSub().options as { ops: string[] }).ops).toEqual([
      'insert',
      'update',
      'replace',
      'delete',
    ])
    await v.wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true)
    expect(v.s.lastSub().options).toMatchObject({ fullDocument: true })
    // The last chip stays on: a feed watches at least one kind of change.
    for (const op of ['update', 'replace', 'delete'])
      await v.wrapper.get(`[data-watch-chip="${op}"]`).trigger('click')
    const before = v.s.lastSub().id
    await v.wrapper.get('[data-watch-chip="insert"]').trigger('click')
    expect(v.s.lastSub().id).toBe(before)
    expect(WatchOptionsSchema.parse(v.s.lastSub().options).ops).toEqual(['insert'])
  })

  it('fills the editor from an example and removes a filter', async () => {
    const v = await view()
    await v.wrapper.get('[data-watch-filter-toggle]').trigger('click')
    const example = v.wrapper
      .findAll('[data-watch-filter-editor] button')
      .find((b) => b.text().includes('Orders that became paid'))!
    await example.trigger('click')
    expect(
      (v.wrapper.get('[data-watch-filter-editor] textarea').element as HTMLTextAreaElement).value,
    ).toContain('updateDescription.updatedFields.status')
    await v.wrapper.get('[data-watch-filter-apply]').trigger('click')
    expect(v.s.lastSub().filter).toEqual({ 'updateDescription.updatedFields.status': 'paid' })
    const remove = v.wrapper
      .findAll('[data-watch-filter-editor] button')
      .find((b) => b.text() === 'Remove filter')!
    await remove.trigger('click')
    expect(v.s.lastSub().filter).toEqual({})
  })

  it('holds new events behind a pill while the reader is scrolled down', async () => {
    const v = await view()
    await v.send('events', { events: [event(1), event(2), event(3)], lagMs: 0 })
    const list = v.wrapper.get('[data-watch-row]').element.closest('.overflow-auto') as HTMLElement
    list.scrollTop = 88
    await v.send('events', { events: [event(4), event(5)], lagMs: 0 })
    expect(v.wrapper.get('[data-watch-new]').text()).toBe('2 new events')
    await v.wrapper.get('[data-watch-new]').trigger('click')
    expect(v.wrapper.find('[data-watch-new]').exists()).toBe(false)
  })

  it('toggles with Space only while live or paused', async () => {
    const v = await view()
    await v.send('paused')
    await v.wrapper.get('[role="toolbar"]').trigger('keydown', { key: ' ' })
    expect(v.s.sent.at(-1)).toEqual({ ch: 'watch', type: 'resume', id: v.id, from: 'here' })
    await v.send('ended', { reason: 'closed' })
    const count = v.s.sent.length
    await v.wrapper.get('[role="toolbar"]').trigger('keydown', { key: ' ' })
    expect(v.s.sent.length).toBe(count)
  })

  // Final review M6: "şimdiden" means "already, in advance"; "from now" is "şu andan itibaren".
  describe('Turkish Watch words', () => {
    it('say "from now" as "şu andan itibaren", never "şimdiden"', async () => {
      const tr = (await import('../src/i18n/locales/tr.json')).default as { watch: unknown }
      const text = JSON.stringify(tr.watch)
      expect(text).not.toMatch(/şimdiden/i)
      expect(text).toContain('Şu andan itibaren')
    })
  })
})
