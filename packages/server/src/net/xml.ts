// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 3d-3b spec §2.3: the XML that S3 and WebDAV answer, read by a parser that knows no DTD:
 * a DOCTYPE, an entity declaration or a processing instruction (other than the leading XML
 * declaration) is refused; only the five predefined entities and character references are decoded.
 * Attributes are read past and dropped. Depth and node count are bounded.
 */
export interface XmlNode {
  name: string
  local: string
  children: XmlNode[]
  text: string
}
export class XmlError extends Error {
  override name = 'XmlError'
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const NAME = /^[A-Za-z_][\w.:-]*/

function decode(raw: string): string {
  if (/&(?![^;\s&]{1,10};)/.test(raw)) throw new XmlError('A bare "&" is not allowed')
  return raw.replace(/&([^;\s&]{1,10});/g, (_m, ref: string) => {
    if (ref.startsWith('#')) {
      // Digits only: "&#65x;" or "&#+65;" are refused, never read as far as they go.
      const hex = /^#[xX]([0-9A-Fa-f]{1,6})$/.exec(ref)
      const dec = /^#(\d{1,7})$/.exec(ref)
      const n = hex ? parseInt(hex[1]!, 16) : dec ? parseInt(dec[1]!, 10) : NaN
      if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
        throw new XmlError('Invalid character reference')
      return String.fromCodePoint(n)
    }
    const v = NAMED[ref]
    if (v === undefined) throw new XmlError(`Unknown entity &${ref};`)
    return v
  })
}

export function parseXml(text: string, opts: { maxDepth?: number; maxNodes?: number } = {}): XmlNode {
  const maxDepth = opts.maxDepth ?? 32
  const maxNodes = opts.maxNodes ?? 200_000
  let i = 0
  let nodes = 0
  const stack: XmlNode[] = []
  let root: XmlNode | null = null
  const s = text.replace(/^\uFEFF/, '')
  // Only the declaration itself ("<?xml" then a space or "?>"): "<?xml-stylesheet ...?>" is another PI.
  if (/^<\?xml(?:\s|\?>)/.test(s)) {
    const end = s.indexOf('?>')
    if (end < 0) throw new XmlError('Unterminated XML declaration')
    i = end + 2
  }
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    const chunk = lt < 0 ? s.slice(i) : s.slice(i, lt)
    if (chunk) {
      if (stack.length) stack.at(-1)!.text += decode(chunk)
      else if (chunk.trim()) throw new XmlError('Text outside the root element')
    }
    if (lt < 0) break
    i = lt
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      if (end < 0) throw new XmlError('Unterminated comment')
      i = end + 3
    } else if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9)
      if (end < 0 || !stack.length) throw new XmlError('Misplaced CDATA')
      stack.at(-1)!.text += s.slice(i + 9, end)
      i = end + 3
    } else if (s.startsWith('<!', i)) {
      throw new XmlError('A DOCTYPE or declaration is not allowed')
    } else if (s.startsWith('<?', i)) {
      throw new XmlError('A processing instruction is not allowed')
    } else if (s.startsWith('</', i)) {
      const m = NAME.exec(s.slice(i + 2))
      const end = s.indexOf('>', i)
      const open = stack.pop()
      if (!m || end < 0 || !open || open.name !== m[0]) throw new XmlError('Mismatched closing tag')
      i = end + 1
    } else {
      const m = NAME.exec(s.slice(i + 1))
      if (!m) throw new XmlError('Malformed tag')
      // Past the attributes, honouring quotes (a '>' inside a value does not end the tag).
      let j = i + 1 + m[0].length
      let quote: string | null = null
      for (; j < s.length; j++) {
        const c = s[j]!
        if (quote) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
        else if (c === '<') throw new XmlError('Malformed tag')
      }
      if (j >= s.length) throw new XmlError('Unterminated tag')
      const selfClosing = s[j - 1] === '/'
      if (++nodes > maxNodes) throw new XmlError('Too many elements')
      const name = m[0]
      const node: XmlNode = { name, local: name.slice(name.indexOf(':') + 1), children: [], text: '' }
      if (stack.length) stack.at(-1)!.children.push(node)
      else if (root) throw new XmlError('More than one root element')
      else root = node
      if (!selfClosing) {
        stack.push(node)
        if (stack.length > maxDepth) throw new XmlError('The document is too deep')
      }
      i = j + 1
    }
  }
  if (!root || stack.length) throw new XmlError('Unterminated document')
  return root
}

export const child = (n: XmlNode, local: string) => n.children.find((c) => c.local === local)
export const childrenOf = (n: XmlNode, local: string) => n.children.filter((c) => c.local === local)
export const textOf = (n: XmlNode, local: string): string | null => child(n, local)?.text ?? null
