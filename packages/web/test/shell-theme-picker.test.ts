import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import TerminalThemePicker from '../src/shell/TerminalThemePicker.vue'
import { usePreferencesStore } from '../src/stores/preferences'
import { mountApp } from './support/app'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
  i18n.global.locale.value = 'en'
})

// User request 2026-10-12: "Terminal ekranı için tema seçimi ekle".
describe('the terminal theme picker', () => {
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]

  it('lists every theme with its look, the chosen one checked, and chooses on a click', async () => {
    mountApp(TerminalThemePicker)
    expect(document.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Terminal theme')
    expect(radios().map((r) => r.textContent?.trim())).toEqual([
      'App (light or dark)',
      'GitHub Light',
      'GitHub Dark',
      'One Dark',
      'Dracula',
      'Monokai',
      'Nord',
      'Solarized Light',
      'Solarized Dark',
    ])
    expect(
      radios()
        .filter((r) => r.getAttribute('aria-checked') === 'true')
        .map((r) => r.dataset.terminalTheme),
    ).toEqual(['app'])
    // Its look: the theme's own background.
    expect(
      document.querySelector<HTMLElement>('[data-terminal-theme="dracula"] [data-theme-preview]')!.style
        .background,
    ).toBe('#282a36')
    radios()[4]!.click()
    await flushPromises()
    expect(usePreferencesStore().terminalTheme).toBe('dracula')
    expect(radios()[4]!.getAttribute('aria-checked')).toBe('true')
  })

  it('moves and chooses with the arrows, one stop in the tab order', async () => {
    mountApp(TerminalThemePicker)
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1])
    radios()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(usePreferencesStore().terminalTheme).toBe('github-light')
    expect(document.activeElement).toBe(radios()[1])
    radios()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    radios()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await flushPromises()
    expect(usePreferencesStore().terminalTheme).toBe('solarized-dark')
  })

  it('reads in Turkish', () => {
    i18n.global.locale.value = 'tr'
    mountApp(TerminalThemePicker)
    expect(document.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Terminal teması')
    expect(radios()[0]!.textContent?.trim()).toBe('Uygulama (açık ya da koyu)')
    // Product names, as published.
    expect(
      radios()
        .map((r) => r.textContent?.trim())
        .slice(1, 3),
    ).toEqual(['GitHub Light', 'GitHub Dark'])
  })

  // Review 2026-10-12 (I1, M10): the arrows step from the radio focused; Home and End.
  it('steps from the radio with the focus, and goes to the first or the last', async () => {
    usePreferencesStore().setTerminalTheme('dracula')
    mountApp(TerminalThemePicker)
    expect(
      radios()
        .map((r) => r.tabIndex)
        .filter((i) => i === 0),
    ).toHaveLength(1)
    radios()[0]!.focus()
    radios()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flushPromises()
    expect(usePreferencesStore().terminalTheme).toBe('github-light')
    radios()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    expect(usePreferencesStore().terminalTheme).toBe('solarized-dark')
    expect(document.activeElement).toBe(radios()[8])
    radios()[8]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flushPromises()
    expect(usePreferencesStore().terminalTheme).toBe('app')
  })
})
