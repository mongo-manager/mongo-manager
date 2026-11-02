import { maskStrings } from './mask'

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * Phase 3a-2 spec §2: the bracket next to the caret (the one before it first, then the one at it)
 * and its partner, for highlighting. Brackets inside strings and comments do not count. Null when
 * there is no bracket there or it has no partner.
 */
export function matchBracket(text: string, caret: number): [number, number] | null {
  const { text: masked } = maskStrings(text)
  for (const at of [caret - 1, caret]) {
    const ch = masked[at]
    if (ch === undefined) continue
    if (OPEN[ch]) {
      let depth = 0
      for (let k = at; k < masked.length; k++) {
        if (masked[k] === ch) depth++
        else if (masked[k] === OPEN[ch] && --depth === 0) return [at, k]
      }
      return null
    }
    if (CLOSE[ch]) {
      let depth = 0
      for (let k = at; k >= 0; k--) {
        if (masked[k] === ch) depth++
        else if (masked[k] === CLOSE[ch] && --depth === 0) return [k, at]
      }
      return null
    }
  }
  return null
}
