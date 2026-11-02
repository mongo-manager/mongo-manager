import { FENCE } from '@mongo-manager/shared/browser'

/** Phase 4a-1 spec §1.4: the Markdown an answer may use, as data — never HTML. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
export type Block =
  | { kind: 'p'; children: Inline[] }
  | { kind: 'heading'; children: Inline[] }
  | { kind: 'codeBlock'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }

// Links and images are not recognised: they stay text, address included (S5).
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|_([^_\s](?:[^_]*[^_\s])?)_/g

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  const text = (t: string) => {
    if (!t) return
    const last = out.at(-1)
    if (last?.kind === 'text') last.text += t
    else out.push({ kind: 'text', text: t })
  }
  for (const m of src.matchAll(INLINE)) {
    text(src.slice(at, m.index))
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[2]!.trim() })
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push({ kind: 'strong', children: parseInline(m[3] ?? m[4]!) })
    else out.push({ kind: 'em', children: parseInline(m[5] ?? m[6]!) })
    at = m.index + m[0].length
  }
  text(src.slice(at))
  return out
}

const HEADING = /^#{1,6}\s+(.*)$/
const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let list: { ordered: boolean; items: Inline[][] } | null = null
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', children: parseInline(para.join(' ')) })
    para = []
    if (list) blocks.push({ kind: 'list', ...list })
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!)
      blocks.push({ kind: 'codeBlock', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', children: parseInline(heading[1]!) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const ordered = item[2] !== undefined
      if (para.length || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push(parseInline(item[3]!))
      continue
    }
    if (list) flush()
    para.push(line.trim())
  }
  flush()
  return blocks
}
