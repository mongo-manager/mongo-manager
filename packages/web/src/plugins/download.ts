import { isHiddenChar, isSpoofingChar } from '@mongo-manager/shared/browser'
import { BridgeError } from './bridge'

/**
 * Plugins wave 3 (spec §1.1): a file a plugin hands the app to save. The frame cannot download (its
 * sandbox has no `allow-downloads`), so the app saves it — under a name made safe, as a kind it
 * knows (the extension is the kind's, never the name's), an HTML page assembled by the app around
 * a sanitized body, a PNG only when it is one.
 */

export const DOWNLOAD_KINDS = {
  markdown: { ext: '.md', type: 'text/markdown;charset=utf-8' },
  mermaid: { ext: '.mmd', type: 'text/plain;charset=utf-8' },
  csv: { ext: '.csv', type: 'text/csv;charset=utf-8' },
  json: { ext: '.json', type: 'application/json;charset=utf-8' },
  // Plugins wave 4: documents, one per line (the anonymiser's copy).
  ndjson: { ext: '.ndjson', type: 'application/x-ndjson;charset=utf-8' },
  text: { ext: '.txt', type: 'text/plain;charset=utf-8' },
  png: { ext: '.png', type: 'image/png' },
  html: { ext: '.html', type: 'text/html;charset=utf-8' },
} as const
export type DownloadKind = keyof typeof DOWNLOAD_KINDS

/** The longest name kept (characters, before the extension), and the longest text taken. */
const NAME_CHARS = 100
const TEXT_CHARS = 1_000_000
/** Windows' device names, superscript digits and console names included (wave 3 review). */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

/** A file name safe on every system: no path, reserved device name, hidden or reversing character. */
export function fileName(raw: unknown, ext: string, fallback: string): string {
  let name = typeof raw === 'string' ? raw : ''
  name = [...name]
    .filter((c) => {
      const code = c.codePointAt(0)!
      return !isHiddenChar(code) && !isSpoofingChar(code)
    })
    .join('')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (name.toLowerCase().endsWith(ext)) name = name.slice(0, -ext.length).replace(/[.\s]+$/, '')
  // One extension only, the kind's: "invoice.pdf" saved as a page would show as invoice.pdf where
  // extensions are hidden (wave 3 review).
  name = [...name.replace(/\./g, '_')].slice(0, NAME_CHARS).join('').trim()
  if (!name) name = fallback
  if (RESERVED.test(name)) name = `_${name}`
  return `${name}${ext}`
}

/** Elements a page keeps: structure and text. */
const KEPT = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'span',
  'section',
  'header',
  'footer',
  'nav',
  'article',
  'main',
  'aside',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'code',
  'pre',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'sub',
  'sup',
  'br',
  'hr',
  'blockquote',
  'mark',
  'figure',
  'figcaption',
  'details',
  'summary',
  'kbd',
  'abbr',
  'a',
])
/** Elements dropped with all they hold (what runs, loads, submits or draws its own markup). */
const DROPPED = new Set([
  'script',
  'style',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'noscript',
  'meta',
  'link',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'img',
  'picture',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'portal',
  'title',
  'head',
])
/** Attributes kept; a link keeps only an address within the page. */
const ATTRS = new Set(['class', 'id', 'colspan', 'rowspan', 'scope', 'lang', 'title'])
const FRAGMENT = /^#[A-Za-z0-9_-]{1,100}$/

/** A body as the app keeps it: allowed elements and attributes only, all text kept as text. */
export function sanitizeHtml(body: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${body}`, 'text/html')
  const clean = (node: Element): void => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase()
      if (DROPPED.has(tag)) {
        child.remove()
        continue
      }
      clean(child)
      if (!KEPT.has(tag)) {
        child.replaceWith(...child.childNodes)
        continue
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase()
        const keep = ATTRS.has(name) || (tag === 'a' && name === 'href' && FRAGMENT.test(attr.value))
        if (!keep) child.removeAttribute(attr.name)
      }
    }
    // Comments say nothing a reader needs, and could close what a parser later opens.
    for (const child of [...node.childNodes]) if (child.nodeType === 8) child.remove()
  }
  clean(doc.body)
  return doc.body.innerHTML
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A style a page may carry: nothing that ends its element or fetches anything. Wave 3 review: a
 * reader without the page's policy (a mail preview, a word processor) would load what the policy
 * blocks, so no escape (which could spell any of these), image set, src(), font, expression or
 * behaviour either.
 */
function checkedCss(css: string): string {
  if (
    css.includes('<') ||
    css.includes('\\') ||
    /@import|@font-face|image-set|\bsrc\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i.test(css) ||
    /url\(\s*(?!['"]?data:)/i.test(css)
  )
    throw new BridgeError('bad_params', 'A style may not hold markup, an escape, @import or an address')
  return css
}

/** Review of the languages (minor 19): a plain language tag ("ja", "pt-BR"), else the one given. */
const langTagOf = (value: unknown, otherwise: string): string =>
  typeof value === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(value) ? value : otherwise

/**
 * An HTML page assembled by the app: its policy first (no script, no request; inline style and
 * data images only), the title as text, the plugin's style, then its sanitized body. Marked with its
 * language (a plain tag only), so its glyphs are the right ones.
 */
export function htmlPage(title: string, css: string, body: string, lang = 'en'): string {
  return [
    '<!doctype html>',
    `<html lang="${langTagOf(lang, 'en')}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(title)}</title>`,
    `<style>${checkedCss(css)}</style>`,
    `</head><body>${sanitizeHtml(body)}</body></html>`,
  ].join('')
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngBytes(base64: unknown): Uint8Array<ArrayBuffer> {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0)
    throw new BridgeError('bad_params', 'base64 is a PNG in base64')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new BridgeError('bad_params', 'Not a PNG image')
  return bytes
}

/** A number as a spreadsheet reads one: never guarded. */
const NUMBER = /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/
/** What a spreadsheet would run as a formula (the app's own CSV export guards the same). */
const FORMULA = /^[=+\-@\t\r]/

/**
 * Wave 3 review: a CSV a plugin made, its cells that start like a formula written as text (a
 * leading '), quoted as RFC 4180 says; its line ends kept.
 */
export function guardedCsv(input: string): string {
  // Wave 3 second review: a byte-order mark stays first (a spreadsheet drops it, then reads the cell
  // after it); a "sep=" first line names the separator a spreadsheet will split on.
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : ''
  let text = bom ? input.slice(1) : input
  let head = ''
  const sepLine = /^sep=(.)(\r\n|\n|\r|$)/i.exec(text)
  if (sepLine) {
    head = sepLine[0]
    text = text.slice(head.length)
  }
  const sep = sepLine?.[1] ?? ','
  // Third review: a first line that only looks like a directive ("sep=| ") might be read as one by a
  // lenient spreadsheet — every cell is quoted then, that line included, so it is read as none.
  const lookalike = !sepLine && /^\s*sep\s*=/i.test(text)
  type Cell = { value: string; quoted: boolean }
  const rows: Array<{ cells: Cell[]; end: string }> = [{ cells: [], end: '' }]
  let cell: Cell = { value: '', quoted: false }
  let inQuotes = false
  const endCell = () => {
    rows.at(-1)!.cells.push(cell)
    cell = { value: '', quoted: false }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell.value += '"'
        i++
      } else if (c === '"') inQuotes = false
      else cell.value += c
    } else if (c === '"' && cell.value === '' && !cell.quoted) {
      inQuotes = true
      cell.quoted = true
    } else if (c === sep) endCell()
    else if (c === '\n' || c === '\r') {
      // CRLF, LF, and an old Mac's bare CR all end a line.
      const end = c === '\r' && text[i + 1] === '\n' ? '\r\n' : c
      if (end === '\r\n') i++
      rows.at(-1)!.end = end
      endCell()
      rows.push({ cells: [], end: '' })
    } else cell.value += c
  }
  endCell()
  const write = ({ value, quoted }: Cell) => {
    const safe = FORMULA.test(value) && !NUMBER.test(value) ? `'${value}` : value
    // Quoted when it holds any separator a spreadsheet may split on (, ; or a tab), a quote or a
    // line end: one cell stays one cell whatever the reader's separator.
    return quoted || lookalike || /[",;\t\r\n]/.test(safe) || safe.includes(sep)
      ? `"${safe.replace(/"/g, '""')}"`
      : safe
  }
  return bom + head + rows.map((row) => row.cells.map(write).join(sep) + row.end).join('')
}

const textOf = (text: unknown): string => {
  if (typeof text !== 'string' || text.length > TEXT_CHARS)
    throw new BridgeError('bad_params', `text is at most ${TEXT_CHARS.toLocaleString('en')} characters`)
  return text
}

/** The file a plugin asks to save, or a refusal in the bridge's words. */
export function buildDownload(
  params: unknown,
  fallbackName: string,
  lang = 'en',
): { name: string; blob: Blob } {
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new BridgeError('bad_params', 'A download is an object')
  const p = params as Record<string, unknown>
  const kind =
    typeof p.type === 'string' && Object.hasOwn(DOWNLOAD_KINDS, p.type) ? (p.type as DownloadKind) : null
  if (!kind) throw new BridgeError('bad_params', `type is one of ${Object.keys(DOWNLOAD_KINDS).join(', ')}`)
  const { ext, type } = DOWNLOAD_KINDS[kind]
  const name = fileName(p.name, ext, fallbackName)
  if (kind === 'png') return { name, blob: new Blob([pngBytes(p.base64)], { type }) }
  if (kind === 'html') {
    const html = p.html as { title?: unknown; css?: unknown; body?: unknown; lang?: unknown } | undefined
    if (!html || typeof html !== 'object' || typeof html.body !== 'string')
      throw new BridgeError('bad_params', 'html is { title, css, body }')
    const page = htmlPage(
      typeof html.title === 'string' ? html.title.slice(0, 200) : '',
      typeof html.css === 'string' ? textOf(html.css) : '',
      textOf(html.body),
      langTagOf(html.lang, langTagOf(lang, 'en')),
    )
    return { name, blob: new Blob([page], { type }) }
  }
  const text = textOf(p.text)
  return { name, blob: new Blob([kind === 'csv' ? guardedCsv(text) : text], { type }) }
}

/** Saves a file through a link the app clicks (the address is freed once the browser took it). */
export function saveBlob(name: string, blob: Blob, doc: Document = document): void {
  const url = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  doc.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
