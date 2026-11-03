import { localTime } from './format'

/** The plugin's settings as the app gives them (none set: tooltip, the browser's zone, no "ago"). */
export interface LocalTimeSettings {
  beside?: string | boolean
  timeZone?: string | boolean
  relative?: string | boolean
}

/**
 * A cell's answer. Two renderers are declared — beside the value and in its tooltip — and the one
 * the settings choose answers; the other says nothing, so the date shows once.
 */
export function answerFor(
  renderer: string,
  value: unknown,
  locale: string,
  settings: LocalTimeSettings,
  now: number,
): { text: string; tone: 'neutral' } | null {
  const chosen = settings.beside === true ? 'beside' : 'tip'
  if (renderer !== chosen) return null
  const text = localTime(value, locale, {
    timeZone: typeof settings.timeZone === 'string' ? settings.timeZone : '',
    relative: settings.relative === true,
    now,
  })
  return text ? { text, tone: 'neutral' } : null
}
