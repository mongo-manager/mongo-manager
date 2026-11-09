// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import { useCommandsStore } from '../src/stores/commands'
import { collectionPlace, connectionPlace, usePlacesStore } from '../src/stores/places'
import { mockApi, mountApp } from './support/app'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  mockApi({ 'GET connections': () => [200, [{ id: 'c1', name: 'Prod', permissions: [] }]] })
})
afterEach(() => {
  document.body.innerHTML = ''
})

/** A user with two places opened and one pinned. */
function withPlaces() {
  const places = usePlacesStore()
  places.bindUser('u1')
  places.visit(collectionPlace('c1', 'shop', 'orders'))
  places.visit(collectionPlace('c1', 'shop', 'customers'))
  places.pin(connectionPlace({ id: 'c1', name: 'Prod' }))
  return places
}
const groupLabels = () =>
  [...document.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))

// User request 2026-10-10: the palette's Recent could not be cleared.
describe('clearing what was opened last, from the palette', () => {
  it('clears Recent from its heading, keeping the pins', async () => {
    const places = withPlaces()
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    expect(groupLabels()).toEqual(['Pinned', 'Recent'])
    const clear = document.querySelector<HTMLButtonElement>('[data-clear-recent]')!
    expect(clear.textContent).toContain('Clear')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    clear.dispatchEvent(down)
    // The search box keeps the focus.
    expect(down.defaultPrevented).toBe(true)
    clear.click()
    await nextTick()
    expect(places.recent).toEqual([])
    expect(places.pins).toHaveLength(1)
    expect(localStorage.getItem('mm:recent:u1')).toBe('[]')
    expect(groupLabels()).toEqual(['Pinned'])
    expect(document.querySelector('[data-clear-recent]')).toBeNull()
  })

  it('offers no Clear where nothing was opened', async () => {
    usePlacesStore().bindUser('u1')
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    expect(document.querySelector('[data-clear-recent]')).toBeNull()
  })

  it('lists a command only while it can do something (keyboard users clear Recent this way)', async () => {
    const places = withPlaces()
    const commands = useCommandsStore()
    commands.register({
      id: 'places.clearRecent',
      title: 'Clear recently opened',
      when: () => places.recent.length > 0,
      run: () => places.clearRecent(),
    })
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    const titles = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent!.trim())
    expect(titles()).toContain('Clear recently opened')
    places.clearRecent()
    await nextTick()
    expect(titles()).not.toContain('Clear recently opened')
  })
})
