/** The character that replaces string, template, regex and comment contents in maskStrings. */
export const HIDDEN = '\u0001'

/** After one of these (or at the start), a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
])

/**
 * The same text with every string and template literal (quotes included), regular-expression literal
 * and comment replaced, character for character, by HIDDEN — so a scan for brackets, dots, words or
 * `{{placeholders}}` ignores what is inside them, while positions still match the source. `open` is
 * true when the text ends inside one of them. A template's `${…}` is masked with it (conservative).
 */
export function maskStrings(src: string): { text: string; open: boolean } {
  let out = ''
  let quote: string | null = null
  let regex = false
  let regexClass = false
  let line = false
  let block = false
  let last = '' // the last significant character outside masked parts
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      out += HIDDEN
      if (ch === '\\' && i + 1 < src.length) {
        out += HIDDEN
        i++
      } else if (ch === quote || (ch === '\n' && quote !== '`')) quote = null
      continue
    }
    if (regex) {
      out += ch === '\n' ? '\n' : HIDDEN
      if (ch === '\\' && i + 1 < src.length) {
        out += HIDDEN
        i++
      } else if (ch === '[') regexClass = true
      else if (ch === ']') regexClass = false
      else if ((ch === '/' && !regexClass) || ch === '\n') {
        regex = false
        last = 'x' // a regex is a value
      }
      continue
    }
    if (line) {
      out += ch === '\n' ? '\n' : HIDDEN
      if (ch === '\n') line = false
      continue
    }
    if (block) {
      out += HIDDEN
      if (ch === '*' && src[i + 1] === '/') {
        out += HIDDEN
        i++
        block = false
      }
      continue
    }
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      if (src[i + 1] === '/') line = true
      else block = true
      out += HIDDEN + HIDDEN
      i++
      continue
    }
    if (ch === '/' && REGEX_AFTER.has(last)) {
      regex = true
      regexClass = false
      out += HIDDEN
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += HIDDEN
      last = 'x'
      continue
    }
    out += ch
    if (!/\s/.test(ch)) last = /[\w$)\]]/.test(ch) ? 'x' : ch
  }
  return { text: out, open: quote !== null || regex || line || block }
}
