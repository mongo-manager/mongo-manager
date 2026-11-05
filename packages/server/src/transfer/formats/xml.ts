// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Errors } from '../../errors'
import { MAX_RECORD_CHARS } from '../limits'

export type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string>; empty: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string }

const bad = (what: string, reason = 'xml') =>
  Errors.badFile(`The workbook's XML is not valid: ${what}`, { reason })

export const localName = (qname: string): string => qname.slice(qname.indexOf(':') + 1)

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const allowedChar = (cp: number) =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff)

/** Spec §7 T7: only the five predefined entities and valid character references. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw
  let out = ''
  let from = 0
  for (let i = raw.indexOf('&'); i >= 0; i = raw.indexOf('&', from)) {
    out += raw.slice(from, i)
    const end = raw.indexOf(';', i)
    if (end < 0 || end - i > 10) throw bad('an unterminated reference')
    const ref = raw.slice(i + 1, end)
    if (Object.hasOwn(NAMED, ref)) out += NAMED[ref]
    else {
      const m = /^#(x[0-9a-fA-F]{1,6}|[0-9]{1,7})$/.exec(ref)
      if (!m) throw bad(`the entity &${ref.slice(0, 20)};`)
      const cp = m[1]!.startsWith('x') ? parseInt(m[1]!.slice(1), 16) : parseInt(m[1]!, 10)
      if (!allowedChar(cp)) throw bad('a character reference to a forbidden character')
      out += String.fromCodePoint(cp)
    }
    from = end + 1
  }
  return out + raw.slice(from)
}

const NAME = /^[A-Za-z_][\w.:-]*/
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y

function parseTag(body: string): { name: string; attrs: Record<string, string>; empty: boolean } {
  const empty = body.endsWith('/')
  const inner = empty ? body.slice(0, -1) : body
  const m = NAME.exec(inner)
  if (!m) throw bad('a tag without a name')
  const attrs: Record<string, string> = Object.create(null)
  let at = m[0].length
  for (;;) {
    ATTR.lastIndex = at
    const a = ATTR.exec(inner)
    if (!a) break
    attrs[a[1]!] = decodeXmlText(a[2] ?? a[3] ?? '')
    at = ATTR.lastIndex
  }
  if (inner.slice(at).trim() !== '') throw bad('a malformed attribute')
  return { name: m[0], attrs, empty }
}

/** Where a tag ends ('>' outside attribute quotes) in `s` from `from`, or -1; the quote state carries over. */
function tagEnd(s: string, from: number, state: { quote: string }): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i]!
    if (state.quote) {
      if (c === state.quote) state.quote = ''
    } else if (c === '"' || c === "'") state.quote = c
    else if (c === '>') return i
  }
  return -1
}

/**
 * A minimal pull reader for the SpreadsheetML subset (spec §7 T7): elements, attributes, text,
 * CDATA. Any <!DOCTYPE or other declaration is refused; processing instructions and comments are
 * skipped. A token longer than `maxToken` characters is refused.
 *
 * A token that spans chunks is searched chunk by chunk and joined once it is complete: searching the
 * whole buffer again after every chunk was quadratic in the token's length (final review M1).
 */
export async function* xmlEvents(
  text: AsyncIterable<string>,
  maxToken = MAX_RECORD_CHARS,
): AsyncGenerator<XmlEvent> {
  let buf = ''
  let done = false
  const it = text[Symbol.asyncIterator]()
  const chunk = async (): Promise<string | null> => {
    if (done) return null
    const next = await it.next()
    if (next.done) {
      done = true
      return null
    }
    return next.value
  }
  /**
   * Reads chunks until `found` (given each new chunk and the length before it) answers an index,
   * then joins them into `buf`; null when the text ends first.
   */
  const extend = async (
    found: (piece: string, before: number) => number,
    tooLong: string,
  ): Promise<number | null> => {
    const parts = [buf]
    let total = buf.length
    for (;;) {
      if (total > maxToken) throw bad(tooLong)
      const piece = await chunk()
      if (piece === null) {
        buf = parts.join('')
        return null
      }
      const at = found(piece, total)
      parts.push(piece)
      total += piece.length
      if (at >= 0) {
        buf = parts.join('')
        return at
      }
    }
  }
  /** Index of `marker` at or after `from`, reading more as needed. */
  const need = async (marker: string, from: number): Promise<number> => {
    const at = buf.indexOf(marker, from)
    if (at >= 0) return at
    // The end of what was searched, so a marker split across chunks is still found.
    let carry = buf.slice(Math.max(from, buf.length - marker.length + 1))
    const end = await extend((piece, before) => {
      const probe = carry + piece
      const i = probe.indexOf(marker)
      if (i >= 0) return before - carry.length + i
      carry = probe.slice(Math.max(0, probe.length - marker.length + 1))
      return -1
    }, 'a token too long')
    if (end === null) throw bad('the document ends inside a token')
    return end
  }
  for (;;) {
    let lt = buf.indexOf('<')
    if (lt < 0) {
      const at = await extend((piece, before) => {
        const i = piece.indexOf('<')
        return i < 0 ? -1 : before + i
      }, 'text too long')
      if (at === null) {
        if (buf.trim() !== '') yield { type: 'text', text: decodeXmlText(buf) }
        return
      }
      lt = at
    }
    if (lt > 0) {
      yield { type: 'text', text: decodeXmlText(buf.slice(0, lt)) }
      buf = buf.slice(lt)
    }
    while (buf.length < 9) {
      const piece = await chunk()
      if (piece === null) break
      buf += piece
    }
    // Each index is taken before slicing: `buf.slice(await …)` would slice the string as it was
    // before `need` read more.
    if (buf.startsWith('<!--')) {
      const end = await need('-->', 4)
      buf = buf.slice(end + 3)
    } else if (buf.startsWith('<![CDATA[')) {
      const end = await need(']]>', 9)
      yield { type: 'text', text: buf.slice(9, end) }
      buf = buf.slice(end + 3)
    } else if (buf.startsWith('<!')) {
      throw bad('a DTD or declaration', 'xml_dtd')
    } else if (buf.startsWith('<?')) {
      const end = await need('?>', 2)
      buf = buf.slice(end + 2)
    } else if (buf.startsWith('</')) {
      const end = await need('>', 2)
      const name = buf.slice(2, end).trim()
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw bad('a malformed closing tag')
      yield { type: 'close', name }
      buf = buf.slice(end + 1)
    } else {
      const state = { quote: '' }
      let end = tagEnd(buf, 1, state)
      if (end < 0) {
        const at = await extend((piece, before) => {
          const i = tagEnd(piece, 0, state)
          return i < 0 ? -1 : before + i
        }, 'a tag too long')
        if (at === null) throw bad('the document ends inside a tag')
        end = at
      }
      const tag = parseTag(buf.slice(1, end).trim())
      buf = buf.slice(end + 1)
      yield { type: 'open', ...tag }
      if (tag.empty) yield { type: 'close', name: tag.name }
    }
  }
}

/** Characters XML 1.0 cannot hold: C0 controls other than tab, LF and CR, and U+FFFE/U+FFFF. */
const unholdable = (code: number) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff

const ESCAPED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/** Text for OOXML: XML escapes, and characters XML 1.0 cannot hold as _xHHHH_ (ST_Xstring). */
export function xmlEscape(text: string): string {
  const marked = text.replace(/_x[0-9A-Fa-f]{4}_/g, (m) => `_x005F_${m.slice(1)}`)
  let out = ''
  for (let i = 0; i < marked.length; i++) {
    const c = marked[i]!
    const code = marked.charCodeAt(i)
    if (unholdable(code)) out += `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`
    else out += ESCAPED[c] ?? c
  }
  return out
}

/** Reads back _xHHHH_ escapes of OOXML text. */
export const unescapeOoxml = (text: string): string =>
  text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
