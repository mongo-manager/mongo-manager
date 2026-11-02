import { pick, type Language } from '../../kit/src/ui'
import { readings, uuidBytes } from './uuid'

export const HEAD = {
  en: 'Legacy UUID',
  tr: 'Eski UUID',
  zh: '旧版 UUID',
  ja: '旧形式 UUID',
  es: 'UUID heredado',
  pt: 'UUID legado',
  ko: '레거시 UUID',
  de: 'Legacy-UUID',
  fr: 'UUID hérité',
  ru: 'Устаревший UUID',
} satisfies Record<Language, string>

/**
 * A legacy UUID's cell (binary subtype 3, 16 bytes): what it reads as in the Java, C# and Python
 * drivers' byte orders, shown when the cell is pointed at. Any other binary value: nothing to say.
 */
export function uuidAnswer(value: unknown, locale: string): { text: string; tone: 'info' } | null {
  const uuid = uuidBytes(value)
  if (!uuid?.legacy) return null
  const r = readings(uuid.bytes)
  const head = pick(HEAD, locale)
  return { text: `${head} · Java ${r.java} · C# ${r.csharp} · Python ${r.python}`, tone: 'info' }
}
