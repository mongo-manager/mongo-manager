import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import { useCommandsStore } from '../src/stores/commands'
import { mountApp } from './support/app'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  document.body.innerHTML = ''
})

describe('command search', () => {
  it('matches characters in order and ranks prefix matches first', () => {
    const commands = useCommandsStore()
    commands.register({ id: 'a', title: 'Toggle theme', run: () => {} })
    commands.register({ id: 'b', title: 'Add connection', keywords: 'new server', run: () => {} })
    const off = commands.register({ id: 'c', title: 'Switch language', run: () => {} })
    expect(commands.search('tt').map((c) => c.id)).toEqual(['a'])
    expect(commands.search('serv').map((c) => c.id)).toEqual(['b'])
    expect(commands.search('').map((c) => c.id)).toEqual(['a', 'b', 'c'])
    off()
    expect(commands.search('').map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('CommandPalette (Review Focus 4)', () => {
  it('filters, moves with arrows, runs with Enter and closes', async () => {
    const run = vi.fn()
    const { wrapper } = mountApp(CommandPalette, { props: { open: true } })
    const commands = useCommandsStore()
    commands.register({ id: 'a', title: 'Toggle theme', run: () => {} })
    commands.register({ id: 'b', title: 'Toggle theme', run })
    await nextTick()
    const input = document.querySelector('[role="combobox"]') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    input.value = 'toggle'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await nextTick()
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!)!
    expect(active.textContent).toContain('Toggle theme')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
