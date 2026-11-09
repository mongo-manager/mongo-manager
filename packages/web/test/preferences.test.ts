// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { usePreferencesStore } from '../src/stores/preferences'
import PreferencesForm from '../src/account/PreferencesForm.vue'
import { mountApp } from './support/app'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  setActivePinia(createPinia())
})

describe('preferences (Review Focus 5)', () => {
  // User review 2026-10-30: the density choice ("comfortable"/"compact") meant little and is gone; an
  // old stored one is dropped at the next save, and the page never carries one.
  it('applies and persists theme and language, with no density any more', () => {
    localStorage.setItem('mm:preferences', '{"density":"compact"}')
    const prefs = usePreferencesStore()
    prefs.start()
    prefs.setTheme('dark')
    prefs.setLocale('tr')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.density).toBeUndefined()
    expect(document.documentElement.lang).toBe('tr')
    expect(i18n.global.locale.value).toBe('tr')
    expect(JSON.parse(localStorage.getItem('mm:preferences')!)).toEqual({
      accent: 'emerald',
      theme: 'dark',
      locale: 'tr',
      screenReader: true,
      terminalTheme: 'app',
      newestFirst: true,
    })
    expect('density' in prefs).toBe(false)

    setActivePinia(createPinia())
    const reloaded = usePreferencesStore()
    expect([reloaded.theme, reloaded.locale]).toEqual(['dark', 'tr'])
    prefs.stop()
  })

  it('has only a light and a dark theme, and toggles between them (checkpoint 1 feedback)', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const prefs = usePreferencesStore()
    prefs.start()
    expect(prefs.theme).toBe('light')
    prefs.toggleTheme()
    expect(prefs.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    prefs.toggleTheme()
    expect(prefs.theme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    prefs.stop()
    vi.unstubAllGlobals()
  })

  it('starts from the system’s choice once, and a stored "system" becomes that choice', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    localStorage.setItem('mm:preferences', '{"theme":"system"}')
    const prefs = usePreferencesStore()
    prefs.start()
    expect(prefs.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('applies, stores and restores the accent; Emerald by default; an unknown one falls back (spec rev. 2 §7)', () => {
    const prefs = usePreferencesStore()
    prefs.start()
    expect(prefs.accent).toBe('emerald')
    expect(document.documentElement.dataset.accent).toBe('emerald')
    prefs.setAccent('violet')
    expect(document.documentElement.dataset.accent).toBe('violet')
    expect(JSON.parse(localStorage.getItem('mm:preferences')!).accent).toBe('violet')
    setActivePinia(createPinia())
    expect(usePreferencesStore().accent).toBe('violet')
    localStorage.setItem('mm:preferences', '{"accent":"<script>"}')
    setActivePinia(createPinia())
    const again = usePreferencesStore()
    again.start()
    expect(again.accent).toBe('emerald')
    expect(document.documentElement.dataset.accent).toBe('emerald')
  })

  it('keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const prefs = usePreferencesStore()
    prefs.start()
    expect(() => prefs.setTheme('dark')).not.toThrow()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    vi.restoreAllMocks()
  })

  it('ignores corrupt stored values', () => {
    localStorage.setItem('mm:preferences', '{"theme":"purple","locale":"xx"}')
    const prefs = usePreferencesStore()
    expect(['light', 'dark']).toContain(prefs.theme)
    expect(['en', 'tr']).toContain(prefs.locale)
  })

  // User request 2026-10-12: the terminal's theme, chosen and kept.
  it('keeps the terminal’s theme, a stored one it does not know taken as the app’s', () => {
    const prefs = usePreferencesStore()
    expect(prefs.terminalTheme).toBe('app')
    prefs.setTerminalTheme('nord')
    expect(JSON.parse(localStorage.getItem('mm:preferences')!).terminalTheme).toBe('nord')
    setActivePinia(createPinia())
    expect(usePreferencesStore().terminalTheme).toBe('nord')
    localStorage.setItem('mm:preferences', JSON.stringify({ terminalTheme: '"><script>' }))
    setActivePinia(createPinia())
    expect(usePreferencesStore().terminalTheme).toBe('app')
  })

  // W5 (spec 3a-1 §10.6): the shell's screen-reader mode, on by default, switched in Preferences.
  it('switches the shell’s screen-reader mode in the preferences form', async () => {
    const { wrapper } = mountApp(PreferencesForm)
    const toggle = wrapper.find<HTMLInputElement>('[data-test="screen-reader"] input[role="switch"]')
    expect(toggle.element.checked).toBe(true)
    await toggle.setValue(false)
    expect(usePreferencesStore().screenReader).toBe(false)
    expect(JSON.parse(localStorage.getItem('mm:preferences')!).screenReader).toBe(false)
    expect(wrapper.text()).toContain('Screen reader mode in the shell')
  })

  // User request 2026-11-02: a collection opens newest first, on by default, switched in Preferences.
  it('switches newest first in the preferences form', async () => {
    const { wrapper } = mountApp(PreferencesForm)
    const toggle = wrapper.find<HTMLInputElement>('[data-test="newest-first"] input[role="switch"]')
    expect(toggle.element.checked).toBe(true)
    await toggle.setValue(false)
    expect(usePreferencesStore().newestFirst).toBe(false)
    expect(JSON.parse(localStorage.getItem('mm:preferences')!).newestFirst).toBe(false)
    expect(wrapper.text()).toContain('Open collections with the newest documents first')
  })
})
