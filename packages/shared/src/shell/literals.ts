import { EJSON } from 'bson'
import { HIDDEN, maskStrings } from './mask'

/**
 * Phase 3a-2 spec §3.2 (A3) and §3.5 (A8): text from the database (collection and field names) and
 * from a snippet's parameter form becomes code in the shell editor. It is inserted only through these
 * functions, which turn it into an inert literal: a name that is not an identifier is quoted, and a
 * parameter value is a typed literal that cannot close itself and run.
 */

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/
const MAX_PARAM_BYTES = 64 * 1024

export type ParamType = 'string' | 'number' | 'boolean' | 'ejson'

export interface SnippetParam {
  name: string
  type: ParamType
  default?: string
  required?: boolean
}

export type ParamError = 'number' | 'boolean' | 'ejson' | 'too_large'
export type FillError = ParamError | 'required' | 'undeclared' | 'context'

export const isIdentifier = (name: string): boolean => IDENTIFIER.test(name)

/** A JavaScript string literal with every quote, backslash and control character escaped. */
export const jsString = (value: string): string =>
  // U+2028/2029 are escaped too: inside a comment they would end it (final review I1).
  JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

/** `.name`, or `["…"]` when the name is not an identifier. */
export const memberAccess = (name: string): string =>
  isIdentifier(name) ? `.${name}` : `[${jsString(name)}]`

/** An object-literal key: the name itself, or a quoted string when it is not an identifier. */
export const objectKey = (name: string): string => (isIdentifier(name) ? name : jsString(name))

/**
 * The parameters used somewhere other than a value position — inside a string, a template, a regular
 * expression or a comment. There a typed literal would not be inert (a quote, `${`, a slash or a line
 * separator could end the context), so such a template is refused (final review I1).
 */
export function misplacedPlaceholders(code: string): string[] {
  // A placeholder stands for a value: seen as an identifier, a following `/` divides.
  const { text } = maskStrings(code.replace(PLACEHOLDER, (m) => '_'.repeat(m.length)))
  const names: string[] = []
  for (const match of code.matchAll(PLACEHOLDER)) {
    const name = match[1]!
    if (PARAM_NAME.test(name) && text[match.index] === HIDDEN && !names.includes(name)) names.push(name)
  }
  return names
}

/** The parameter names a snippet template uses, once each, in the order they first appear. */
export function placeholdersOf(code: string): string[] {
  const names: string[] = []
  for (const match of code.matchAll(PLACEHOLDER)) {
    const name = match[1]!
    if (PARAM_NAME.test(name) && !names.includes(name)) names.push(name)
  }
  return names
}

/** A parameter value as a literal of its type, or why it cannot be one. */
export function paramLiteral(
  type: ParamType,
  raw: string,
): { ok: true; literal: string } | { ok: false; error: ParamError } {
  if (new TextEncoder().encode(raw).length > MAX_PARAM_BYTES) return { ok: false, error: 'too_large' }
  switch (type) {
    case 'string':
      return { ok: true, literal: jsString(raw) }
    case 'number': {
      const text = raw.trim()
      if (!NUMBER.test(text) || !Number.isFinite(Number(text))) return { ok: false, error: 'number' }
      const n = Number(text)
      // An integer written out in digits must survive as itself: past 2^53 it would silently become a
      // neighbour (a 64-bit value belongs in an EJSON parameter as $numberLong) (final review M7).
      if (/^-?\d+$/.test(text) && !Number.isSafeInteger(n)) return { ok: false, error: 'number' }
      // Parenthesised when negative, so `a-{{n}}` cannot become `a--5` (final review I1).
      return { ok: true, literal: n < 0 || Object.is(n, -0) ? `(${n})` : String(n) }
    }
    case 'boolean':
      return raw === 'true' || raw === 'false' ? { ok: true, literal: raw } : { ok: false, error: 'boolean' }
    case 'ejson':
      try {
        const canonical = EJSON.stringify(EJSON.parse(raw, { relaxed: false }), { relaxed: false })
        // One call around one string literal: the value is data, whatever it contains.
        return { ok: true, literal: `EJSON.parse(${jsString(canonical)})` }
      } catch {
        return { ok: false, error: 'ejson' }
      }
  }
}

/**
 * Fill a snippet template. Every placeholder must be declared; a missing value falls back to the
 * default, else it is an error. All errors are reported at once. The template is scanned once, so a
 * value that itself looks like a placeholder is never substituted again.
 */
export function fillSnippet(
  code: string,
  params: readonly SnippetParam[],
  values: Record<string, string | undefined>,
): { ok: true; code: string } | { ok: false; errors: Record<string, FillError> } {
  const byName = new Map(params.map((p) => [p.name, p]))
  const literals = new Map<string, string>()
  const errors: Record<string, FillError> = {}
  const misplaced = new Set(misplacedPlaceholders(code))
  for (const name of placeholdersOf(code)) {
    if (misplaced.has(name)) {
      errors[name] = 'context'
      continue
    }
    const param = byName.get(name)
    if (!param) {
      errors[name] = 'undeclared'
      continue
    }
    const raw = values[name] ?? param.default
    // A required parameter needs a value: an emptied field does not fall back to the default
    // (final review M7).
    if (raw === undefined || (raw === '' && (param.type !== 'string' || param.required))) {
      errors[name] = 'required'
      continue
    }
    const r = paramLiteral(param.type, raw)
    if (r.ok) literals.set(name, r.literal)
    else errors[name] = r.error
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    // A name that is not a parameter name was never collected: it stays as written.
    code: code.replace(PLACEHOLDER, (match, name: string) => literals.get(name) ?? match),
  }
}
