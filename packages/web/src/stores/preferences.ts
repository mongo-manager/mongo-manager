import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { browserLocale, i18n, isLoaded, isLocale, setLocale as applyLocale, type Locale } from '@/i18n'
import { useToastStore } from '@/stores/toasts'
import { TERMINAL_THEMES, type TerminalThemeName } from '@/shell/terminalTheme'

/** UI redesign R1 checkpoint 1: a light and a dark theme, nothing else. */
export type Theme = 'light' | 'dark'
/** UI redesign R1 revision 2 §1.2: the accents; Emerald (#047A4D) is the brand's. */
export const ACCENTS = ['emerald', 'indigo', 'violet', 'ocean', 'rose'] as const
export type Accent = (typeof ACCENTS)[number]

const KEY = 'mm:preferences'

function load(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** No theme chosen yet (or the old "system" choice): start from the system's, once. */
const systemTheme = (): Theme =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'

export const usePreferencesStore = defineStore('preferences', () => {
  const stored = load()
  const theme = ref<Theme>(stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : systemTheme())
  const locale = ref<Locale>(
    isLocale(stored.locale)
      ? stored.locale
      : browserLocale(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']),
  )
  const accent = ref<Accent>(
    ACCENTS.includes(stored.accent as Accent) ? (stored.accent as Accent) : 'emerald',
  )
  // Phase 3a-1: the shell terminal's screen-reader mode, on by default.
  const screenReader = ref<boolean>(stored.screenReader !== false)
  // User request 2026-10-12: the shell terminal's theme; one it does not know is the app's.
  const terminalTheme = ref<TerminalThemeName>(
    TERMINAL_THEMES.includes(stored.terminalTheme as TerminalThemeName)
      ? (stored.terminalTheme as TerminalThemeName)
      : 'app',
  )
  // User request 2026-11-02: a collection opens with its newest documents first (on by default).
  const newestFirst = ref<boolean>(stored.newestFirst !== false)
  const dark = computed(() => theme.value === 'dark')

  function persist(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          accent: accent.value,
          theme: theme.value,
          locale: locale.value,
          screenReader: screenReader.value,
          terminalTheme: terminalTheme.value,
          newestFirst: newestFirst.value,
        }),
      )
    } catch {
      // storage blocked (private mode, policy): preferences simply do not persist
    }
  }

  function apply(): void {
    const root = document.documentElement
    root.classList.toggle('dark', dark.value)
    root.dataset.accent = accent.value
    // Review I2: a language whose words could not be loaded is not the one chosen: the page's is.
    void applyLocale(locale.value).then((outcome) => {
      if (outcome === 'failed') locale.value = i18n.global.locale.value as Locale
    })
  }

  function start(): void {
    apply()
  }

  /** Kept for the app's lifecycle; nothing is listened to any more. */
  function stop(): void {}

  function setTheme(next: Theme): void {
    theme.value = next
    persist()
    apply()
  }

  function setAccent(next: Accent): void {
    if (!ACCENTS.includes(next)) return
    accent.value = next
    persist()
    apply()
  }

  function toggleTheme(): void {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  /**
   * Review of the languages (I2): the choice is the language shown — one whose words could not be
   * loaded leaves both as they were, and says so (the page is older than the server's files).
   */
  function setLocale(next: Locale): Promise<boolean> {
    const choose = () => {
      locale.value = next
      persist()
      apply()
      return true
    }
    if (isLoaded(next)) return Promise.resolve(choose())
    return applyLocale(next).then((outcome) => {
      if (outcome === 'shown') return choose()
      if (outcome === 'failed')
        useToastStore().push({ kind: 'error', message: i18n.global.t('account.preferences.languageFailed') })
      return false
    })
  }

  function setScreenReader(on: boolean): void {
    screenReader.value = on
    persist()
  }

  function setNewestFirst(on: boolean): void {
    newestFirst.value = on
    persist()
  }
  function setTerminalTheme(next: TerminalThemeName): void {
    terminalTheme.value = TERMINAL_THEMES.includes(next) ? next : 'app'
    persist()
  }

  return {
    theme,
    accent,
    locale,
    screenReader,
    terminalTheme,
    setTerminalTheme,
    newestFirst,
    setNewestFirst,
    dark,
    start,
    stop,
    setTheme,
    toggleTheme,
    setAccent,
    setLocale,
    setScreenReader,
  }
})
