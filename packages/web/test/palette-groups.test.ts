import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CommandPalette from '../src/workspace/CommandPalette.vue'
import { useCommandsStore, type Command } from '../src/stores/commands'
import { useTabsStore } from '../src/stores/tabs'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'

/**
 * Review I3: the saved items of each open connection are a group of their own, the active
 * connection's first; each group is cut on its own, so one connection's long list never pushes
 * another's out, and a refresh of a list never reorders what is shown.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

/** The active connection sorts last by name: it comes first all the same. */
const NAMES: Record<string, string> = { c1: 'Zulu', c2: 'Bravo', c3: 'Charlie' }
const saved = (connection: string, name: string): Command => ({
  id: `library.open:${connection}:favourite:${name}`,
  title: `Open favourite: ${name}`,
  group: { id: `saved:${connection}`, label: () => `Saved in ${NAMES[connection]}` },
  run: () => {},
})
const headings = () =>
  [...document.querySelectorAll('[role="listbox"] [role="group"]')].map((g) => g.getAttribute('aria-label'))
const itemsOf = (label: string) =>
  [
    ...([...document.querySelectorAll('[role="listbox"] [role="group"]')]
      .find((g) => g.getAttribute('aria-label') === label)
      ?.querySelectorAll('[role="option"]') ?? []),
  ].map((o) => o.textContent?.trim())

describe('saved items in the palette, per connection', () => {
  it('puts the active connection first, cuts each group alone, and keeps its order across refreshes', async () => {
    const commands = useCommandsStore()
    const tabs = useTabsStore()
    tabs.open({ kind: 'connection', title: 'C2', params: { connectionId: 'c2' } })
    tabs.open({ kind: 'connection', title: 'C1', params: { connectionId: 'c1' } })
    // c2's long list comes first, the active c1's two last.
    const offC2 = commands.registerMany(Array.from({ length: 80 }, (_, i) => saved('c2', `two ${i}`)))
    commands.registerMany([saved('c3', 'three')])
    commands.registerMany([saved('c1', 'one a'), saved('c1', 'one b')])
    mountApp(CommandPalette, { props: { open: true } })
    await nextTick()
    expect(headings().filter((h) => h?.startsWith('Saved in'))).toEqual([
      'Saved in Zulu',
      'Saved in Bravo',
      'Saved in Charlie',
    ])
    expect(itemsOf('Saved in Zulu')).toEqual(['Open favourite: one a', 'Open favourite: one b'])
    expect(itemsOf('Saved in Charlie')).toEqual(['Open favourite: three'])
    const shown = itemsOf('Saved in Bravo')
    expect(shown).toHaveLength(20)
    // c2's list read again (the palette's 30-second refresh): the same items in the same order.
    offC2()
    commands.registerMany(Array.from({ length: 80 }, (_, i) => saved('c2', `two ${i}`)))
    await nextTick()
    expect(itemsOf('Saved in Bravo')).toEqual(shown)
    expect(headings().filter((h) => h?.startsWith('Saved in'))).toEqual([
      'Saved in Zulu',
      'Saved in Bravo',
      'Saved in Charlie',
    ])
  })

  it('registers a long list at once, and takes it away at once', () => {
    const commands = useCommandsStore()
    const off = commands.registerMany(Array.from({ length: 500 }, (_, i) => saved('c1', `n${i}`)))
    expect(commands.commands).toHaveLength(500)
    off()
    expect(commands.commands).toHaveLength(0)
  })
})
