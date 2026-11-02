import type { Completion } from './completion'

/**
 * UI redesign R1 review ("unknown identifier name"): where the caret is in a query, a document or a
 * pipeline, so a chosen suggestion is inserted the way it has to be written there.
 */
export interface CodeContext {
  /** How many braces and brackets are open. */
  depth: number
  /**
   * top: outside any document; key: where a field name goes; value: where a value goes; element: an
   * item of a list of documents ($or, a pipeline); other: anywhere else.
   */
  position: 'top' | 'key' | 'value' | 'element' | 'other'
  /** In a value position: the field it belongs to (operators such as $gt and $in pass it on). */
  key: string | null
}

interface Frame {
  kind: '{' | '['
  /** The last key written in this document. */
  key: string | null
  /** The field this document or list is the value of (inherited through operators). */
  field: string | null
  /** For a list: the key it is the value of ($or, $in…). */
  openedBy: string | null
}

const LISTS_OF_DOCUMENTS = new Set(['$or', '$and', '$nor'])
/** The field a document's last key names, by its whole path (reviewer B Minor 9: address.city). */
const fieldOf = (f: Frame): string | null =>
  f.key && !f.key.startsWith('$') ? (f.field ? `${f.field}.${f.key}` : f.key) : f.field

/** Reads the text before the caret: strings are skipped whole, so their braces and colons do not count. */
export function contextAt(text: string): CodeContext {
  const stack: Frame[] = []
  let last = ''
  let token: string | null = null
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'") {
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) j++
        value += text[j]
        j++
      }
      token = value
      last = 'token'
      i = j + 1
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '{' || c === '[') {
      const parent = stack.at(-1)
      const field = parent ? (parent.kind === '{' ? fieldOf(parent) : parent.field) : null
      stack.push({ kind: c, key: null, field, openedBy: parent?.kind === '{' ? parent.key : null })
      last = c
    } else if (c === '}' || c === ']') {
      stack.pop()
      last = c
    } else if (c === ':') {
      const top = stack.at(-1)
      if (top?.kind === '{') top.key = token
      last = c
    } else if (c === ',') {
      last = c
    } else if (/[$\w.]/.test(c)) {
      let j = i
      while (j < text.length && /[$\w.]/.test(text[j]!)) j++
      token = text.slice(i, j)
      last = 'token'
      i = j
      continue
    } else {
      last = c
    }
    i++
  }
  const top = stack.at(-1)
  if (!top) return { depth: 0, position: 'top', key: null }
  const depth = stack.length
  if (top.kind === '{') {
    if (last === '{' || last === ',') return { depth, position: 'key', key: null }
    if (last === ':') return { depth, position: 'value', key: fieldOf(top) }
    return { depth, position: 'other', key: null }
  }
  if (last === '[' || last === ',') {
    if (top.openedBy && LISTS_OF_DOCUMENTS.has(top.openedBy)) return { depth, position: 'element', key: null }
    if (top.field) return { depth, position: 'value', key: top.field }
    return { depth, position: 'element', key: null }
  }
  return { depth, position: 'other', key: null }
}

/** The inserted text and where the caret goes in it. */
export interface Shaped {
  text: string
  caret: number
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const STRING_ARGUMENT = new Set(['ObjectId', 'ISODate', 'NumberDecimal', 'UUID', 'RegExp'])
const NO_ARGUMENT = new Set(['MinKey', 'MaxKey'])

/**
 * Where the caret goes in a template. Reviewer B Minor 10: a character no field name can hold (BSON
 * names end at a zero byte), so a name with "|" in it is inserted whole.
 */
const CARET = '\u0000'
/** A text with the caret at its mark (at the end when it has none). */
function marked(text: string): Shaped {
  const at = text.indexOf(CARET)
  return at === -1
    ? { text, caret: text.length }
    : { text: text.slice(0, at) + text.slice(at + CARET.length), caret: at }
}
const wrap = (inner: Shaped): Shaped => ({ text: `{ ${inner.text} }`, caret: inner.caret + 2 })

function operatorBody(op: string): Shaped {
  if (LISTS_OF_DOCUMENTS.has(op)) return marked(`${op}: [{ ${CARET} }]`)
  if (op === '$in' || op === '$nin' || op === '$all') return marked(`${op}: [${CARET}]`)
  if (op === '$exists') return marked(`${op}: true${CARET}`)
  if (op === '$elemMatch' || op === '$not') return marked(`${op}: { ${CARET} }`)
  if (op === '$regex' || op === '$type' || op === '$options') return marked(`${op}: "${CARET}"`)
  return marked(`${op}: ${CARET}`)
}

/**
 * How a chosen field, operator or constructor is written where the caret is: a field outside any
 * document opens one ({ name: | }), a key gets its colon (and quotes when it is a dotted path), an
 * operator its usual value ($in: [|]), a constructor its parentheses. Other suggestions stay as they are.
 */
export function shapeCompletion(choice: Completion, ctx: CodeContext, after: string): Shaped {
  const label = choice.insert ?? choice.label
  const next = after.trimStart()[0]
  if (choice.kind === 'field') {
    const key = IDENTIFIER.test(label) ? label : JSON.stringify(label)
    if (ctx.position === 'top' || ctx.position === 'element') return wrap(marked(`${key}: ${CARET}`))
    if (ctx.position === 'key') return next === ':' ? marked(key) : marked(`${key}: ${CARET}`)
    return marked(label)
  }
  if (choice.kind === 'operator') {
    if (ctx.position === 'top' || ctx.position === 'element' || ctx.position === 'value')
      return wrap(operatorBody(label))
    if (ctx.position === 'key') return next === ':' ? marked(label) : operatorBody(label)
    return marked(label)
  }
  if (choice.kind === 'constructor') {
    if (next === '(') return marked(label)
    if (NO_ARGUMENT.has(label)) return marked(`${label}()${CARET}`)
    return marked(STRING_ARGUMENT.has(label) ? `${label}("${CARET}")` : `${label}(${CARET})`)
  }
  return marked(label)
}
