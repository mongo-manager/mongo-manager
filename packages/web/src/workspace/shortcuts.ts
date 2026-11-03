/**
 * Every keyboard shortcut the app has lives in the shared package (the server checks a user's own
 * bindings against it, W5); here, how they are shown and matched in the browser.
 */
export { SHORTCUT_GROUPS, type Shortcut } from '@mongo-manager/shared/browser'

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** A key as shown to the user on this system. */
export const keyLabel = (key: string): string => (key === 'Mod' ? (isMac() ? '⌘' : 'Ctrl') : key)

/** How aria-keyshortcuts (and KeyboardEvent.key) name the keys the list writes as symbols. */
const KEY_NAMES: Record<string, string> = {
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  Ctrl: 'Control',
}

/** aria-keyshortcuts' own names: "+" separates its keys, so the + key is "Plus" (review, minor). */
const ARIA_NAMES: Record<string, string> = { '+': 'Plus', ' ': 'Space' }

/** Keys as aria-keyshortcuts names them on this system ("Control+." or "Meta+."). */
export const ariaKeys = (keys: readonly string[]): string =>
  keys
    .map((key) =>
      key === 'Mod' ? (isMac() ? 'Meta' : 'Control') : (ARIA_NAMES[key] ?? KEY_NAMES[key] ?? key),
    )
    .join('+')

/** The modifiers as this system names them, for advice in words (⌘ and ⌥ on a Mac). */
export const modifierNames = (): { mod: string; alt: string } =>
  isMac() ? { mod: '⌘', alt: '⌥' } : { mod: 'Ctrl', alt: 'Alt' }

/** Every combination of a shortcut, as aria-keyshortcuts lists alternatives (space-separated). */
export const ariaShortcut = (combos: readonly (readonly string[])[]): string => combos.map(ariaKeys).join(' ')

/** The key a combination ends in, as a keydown names it. */
const eventKeyOf = (key: string): string => KEY_NAMES[key] ?? key

/** AltGr typing a character: Windows reports it as Ctrl and Alt together, with AltGraph set. */
const isAltGr = (event: KeyboardEvent): boolean =>
  event.ctrlKey && event.altKey && !!event.getModifierState?.('AltGraph')

/**
 * W5: whether a keydown is this combination. Mod is Ctrl or ⌘; AltGr typing a character is not Alt.
 * A letter needs Shift exactly as written; a sign may need Shift to be typed at all (? on most
 * layouts, . on AZERTY), so Shift is only required where the combination names it.
 */
export function matchesCombo(event: KeyboardEvent, combo: readonly string[]): boolean {
  const key = combo.at(-1) ?? ''
  const mod = combo.includes('Mod') || combo.includes('Ctrl')
  const alt = combo.includes('Alt')
  const shift = combo.includes('Shift')
  const altGr = isAltGr(event)
  const altPressed = event.altKey && !altGr
  if ((event.ctrlKey || event.metaKey) && !altGr) {
    if (!mod) return false
  } else if (mod) return false
  if (altPressed !== alt) return false
  if (/^[A-Za-z]$/.test(key)) return event.key.toLowerCase() === key.toLowerCase() && event.shiftKey === shift
  if (/^[!-~]$/.test(key)) return event.key === key && (!shift || event.shiftKey)
  return event.key === eventKeyOf(key) && event.shiftKey === shift
}

/** The keydown is one of the combinations (alternatives, or a pair's two). */
export const matchesAny = (event: KeyboardEvent, combos: readonly (readonly string[])[]): boolean =>
  combos.some((c) => matchesCombo(event, c))

/**
 * Review I4: whether a keydown runs a shortcut of these keys — never while an input method composes,
 * and a combination without Mod or Alt never while the user types in a field.
 */
export function shortcutFires(event: KeyboardEvent, combos: readonly (readonly string[])[]): boolean {
  if (event.isComposing || !matchesAny(event, combos)) return false
  const plain = combos.some((c) => !c.includes('Mod') && !c.includes('Ctrl') && !c.includes('Alt'))
  return !(plain && isTyping(event.target))
}

/**
 * W5: a combination from a keydown, as the settings page records it — modifiers in order, a letter
 * upper-case, an arrow as its symbol; null while only modifiers are down.
 */
export function comboFromEvent(event: KeyboardEvent): string[] | null {
  // An input method's Process, a key the browser cannot name (review, minor): nothing to record yet.
  const waiting = [
    'Control',
    'Meta',
    'Alt',
    'Shift',
    'AltGraph',
    'CapsLock',
    'Dead',
    'Process',
    'Unidentified',
  ]
  if (waiting.includes(event.key)) return null
  const symbols = Object.entries(KEY_NAMES).find(([, name]) => name === event.key)?.[0]
  let key = symbols && symbols !== 'Ctrl' ? symbols : event.key
  if (/^[a-z]$/.test(key)) key = key.toUpperCase()
  const mods: string[] = []
  const altGr = isAltGr(event)
  if ((event.ctrlKey || event.metaKey) && !altGr) mods.push('Mod')
  if (event.altKey && !altGr) mods.push('Alt')
  // Shift typing a sign (?, :, …) is part of the sign, not a modifier of it.
  if (event.shiftKey && (/^[A-Z]$/.test(key) || !/^[!-~]$/.test(key))) mods.push('Shift')
  return [...mods, key]
}

/** True while the user types somewhere, where a printable key must never trigger a shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return (
    el.isContentEditable ||
    el.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ) !== null
  )
}
