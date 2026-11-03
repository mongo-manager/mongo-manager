import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DsMenu from '../src/ds/DsMenu.vue'
import { mountApp } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
})

const rect = (top: number) =>
  ({ top, bottom: top + 20, left: 300, right: 320, width: 20, height: 20, x: 300, y: top }) as DOMRect

describe('menu and scrolling', () => {
  it('stays open for a scroll that did not move its button, and closes once it moved', async () => {
    const { wrapper } = mountApp(DsMenu, { props: { label: 'Menu', items: [{ id: 'a', label: 'A' }] } })
    const trigger = document.querySelector('button[aria-label="Menu"]') as HTMLButtonElement
    let top = 100
    trigger.getBoundingClientRect = () => rect(top)
    await (wrapper.vm as unknown as { openMenu(): Promise<void> }).openMenu()
    // The browser reports the scroll that brought the button into view one frame after the click.
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    top = 40
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
