import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/i18n'
import { usePreferencesStore } from '../src/stores/preferences'
import { useToastStore } from '../src/stores/toasts'
import en from '../src/i18n/locales/en.json'

/**
 * Review of the languages (I2): a language whose words cannot be loaded (a tab older than the
 * server's upgrade, its file gone) leaves the page as it is — the choice kept the one shown, so the
 * assistant answers in it too — and says so.
 */
vi.mock('../src/i18n/locales/ja.json', () => {
  throw new Error('the file is gone')
})

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})

describe('a language that cannot be loaded', () => {
  it('leaves the language shown, and the choice, as they were, and says so', async () => {
    const preferences = usePreferencesStore()
    expect(await preferences.setLocale('ja')).toBe(false)
    expect(i18n.global.locale.value).toBe('en')
    expect(preferences.locale).toBe('en')
    expect(JSON.parse(localStorage.getItem('mm:preferences') ?? '{}').locale ?? 'en').toBe('en')
    expect(useToastStore().toasts.map((t) => t.message)).toContain(en.account.preferences.languageFailed)
  })

  it('still switches to a language it has, at once', () => {
    const preferences = usePreferencesStore()
    void preferences.setLocale('tr')
    expect(preferences.locale).toBe('tr')
    expect(i18n.global.locale.value).toBe('tr')
  })
})
