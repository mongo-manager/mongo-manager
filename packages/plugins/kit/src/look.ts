/**
 * Plugin tabs redesign: the app's accents (web/src/stores/preferences.ts), the only values a page
 * takes for its colours; anything else is the brand's Emerald.
 */
export const ACCENTS = ['emerald', 'indigo', 'violet', 'ocean', 'rose'] as const
export type Accent = (typeof ACCENTS)[number]

export const accentOf = (value: unknown): Accent =>
  (ACCENTS as readonly unknown[]).includes(value) ? (value as Accent) : 'emerald'
