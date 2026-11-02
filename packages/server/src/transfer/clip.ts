import { serializeValue } from '@mongo-manager/shared'

/** A property defined, not assigned: a "__proto__" key stays data. */
export const define = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })

/** 3d-1 final review C3: what a preview (or a compare sample) keeps is bounded, whatever the data holds. */
export const PREVIEW_TEXT = 200
export const PREVIEW_KEY = 1024
export const PREVIEW_ITEMS = 20
export const PREVIEW_RECORD_CHARS = 20_000

export const clipText = (text: string) =>
  text.length > PREVIEW_TEXT ? `${text.slice(0, PREVIEW_TEXT)}…` : text

/**
 * A record (canonical EJSON) for the preview table: text cut, long arrays shortened, very long
 * field names left out, and at most `budget.left` characters in all.
 */
export function clip(value: unknown, budget: { left: number }): unknown {
  if (typeof value === 'string') {
    const text = clipText(value)
    budget.left -= text.length
    return text
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      if (i >= PREVIEW_ITEMS || budget.left <= 0) {
        out.push('…')
        break
      }
      out.push(clip(value[i], budget))
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    // Phase 3d-2 final review I4: a canonical EJSON wrapper ({"$binary": …}, {"$date": …}) cut in
    // the middle no longer decodes; it is kept whole when short, or shown as a placeholder.
    const first = Object.keys(value)[0]
    if (first?.startsWith('$')) {
      const size = JSON.stringify(value).length
      if (size <= PREVIEW_TEXT && size <= budget.left) {
        budget.left -= size
        return value
      }
      const text = `[${first.slice(1)}, ${size} characters, not shown]`
      budget.left -= text.length
      return text
    }
    const out = Object.create(null) as Record<string, unknown>
    for (const [k, v] of Object.entries(value)) {
      if (budget.left <= 0) break
      if (k.length > PREVIEW_KEY) continue
      budget.left -= k.length + 1
      define(out, k, clip(v, budget))
    }
    return out
  }
  budget.left -= 8
  return value
}

export const clipRecord = (doc: unknown) =>
  clip(serializeValue(doc), { left: PREVIEW_RECORD_CHARS }) as Record<string, unknown>
