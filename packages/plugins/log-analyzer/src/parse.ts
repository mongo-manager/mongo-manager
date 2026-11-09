// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Plugins wave 3 (spec §7; mtools' mloginfo --queries, NoSQLBooster's log parser, Atlas Query
 * Insights): one line of a mongod or mongos log — the structured JSON of 4.4 and later, and the
 * legacy text best-effort — read into what the analysis counts. A query's shape keeps its keys and
 * operators and replaces its values with "?": queries alike are grouped, and no value is shown.
 */
export type Line =
  | { kind: 'unreadable' }
  | {
      kind: 'slow'
      at: number | null
      severity: string
      component: string
      ns: string
      op: string
      shape: string
      ms: number
      plan?: string
      keysExamined?: number
      docsExamined?: number
      returned?: number
    }
  | {
      kind: 'connection'
      at: number | null
      severity: string
      component: string
      event: 'opened' | 'ended' | 'metadata'
      client: string
      app?: string
      count?: number
    }
  | {
      kind: 'message'
      at: number | null
      severity: string
      component: string
      id: number | null
      msg: string
    }
  | {
      kind: 'server'
      at: number | null
      severity: string
      component: string
      version?: string
      host?: string
    }
  | { kind: 'event'; at: number | null; severity: string; component: string }

const SHAPE_CHARS = 300
/**
 * The longest name of each kind a line is read with (wave 3 second review: a crafted log's long
 * names grew the analysis' keys without bound).
 */
const NAME = { severity: 2, component: 64, ns: 256, op: 64, client: 128, plan: 200, version: 64, host: 256 }
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)
const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
/** Extended JSON's wrappers ({$oid}, {$date}, …): each is one value. */
const WRAPPER =
  /^\$(oid|date|numberInt|numberLong|numberDouble|numberDecimal|binary|uuid|regularExpression|timestamp|minKey|maxKey|code|symbol|dbPointer)$/
const isWrapper = (v: unknown) => {
  if (!isPlain(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && WRAPPER.test(keys[0]!)
}

/** A query with its values replaced by "?" — keys and operators kept. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 20) return '?'
  if (Array.isArray(v)) {
    // A list of values ($in, $nin) is one "?" — Extended JSON's values too (wave 3 review: a list of
    // ObjectIds made a shape of each length); a list of documents (a pipeline, $or) keeps each.
    if (!v.some((x) => (isPlain(x) && !isWrapper(x)) || Array.isArray(x))) return '?'
    return v.map((x) => shapeOf(x, depth + 1))
  }
  if (isPlain(v)) {
    if (isWrapper(v)) return '?'
    return Object.fromEntries(Object.keys(v).map((k) => [k, shapeOf(v[k], depth + 1)]))
  }
  return '?'
}
const text = (v: unknown) => {
  const s = JSON.stringify(v)
  return s.length > SHAPE_CHARS ? `${s.slice(0, SHAPE_CHARS - 1)}…` : s
}

/** The operation and the shape of what it asked, from a structured log's command. */
function commandShape(attr: Record<string, unknown>): { op: string; shape: string } {
  const command = isPlain(attr.command) ? attr.command : {}
  const type = typeof attr.type === 'string' ? attr.type : 'command'
  // A write's slow line names its type and gives its statement as the command.
  if (type === 'update' || type === 'remove')
    return { op: type, shape: text({ filter: shapeOf(command.q ?? {}) }) }
  // (`update` and `remove` are short names already.)
  const op = cut(Object.keys(command).find((k) => !k.startsWith('$') && k !== 'lsid') ?? type, NAME.op)
  const origin = isPlain(command.originatingCommand)
    ? command.originatingCommand
    : isPlain(attr.originatingCommand)
      ? attr.originatingCommand
      : null
  const source = op === 'getMore' && origin ? origin : command
  const parts: Record<string, unknown> = {}
  if (source.filter !== undefined) parts.filter = shapeOf(source.filter)
  if (source.pipeline !== undefined) parts.pipeline = shapeOf(source.pipeline)
  if (source.query !== undefined) parts.query = shapeOf(source.query)
  if (Array.isArray(source.updates) && isPlain(source.updates[0]))
    parts.filter = shapeOf(source.updates[0].q ?? {})
  if (Array.isArray(source.deletes) && isPlain(source.deletes[0]))
    parts.filter = shapeOf(source.deletes[0].q ?? {})
  if (typeof source.key === 'string') parts.key = source.key
  // The order asked for is no value.
  if (isPlain(source.sort)) parts.sort = source.sort
  return { op, shape: text(parts) }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const dateOf = (t: unknown): number | null => {
  const raw = isPlain(t) ? t.$date : t
  const ms = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(ms) ? ms : null
}
const clientOf = (remote: unknown) =>
  typeof remote === 'string'
    ? cut(
        cut(remote, NAME.client + 16)
          .replace(/:\d+$/, '')
          .replace(/^\[|\]$/g, ''),
        NAME.client,
      )
    : '?'

function structured(o: Record<string, unknown>): Line {
  const at = dateOf(o.t)
  const severity = typeof o.s === 'string' ? cut(o.s, NAME.severity) : 'I'
  const component = typeof o.c === 'string' ? cut(o.c, NAME.component) : '-'
  const id = typeof o.id === 'number' ? o.id : null
  const msg = typeof o.msg === 'string' ? o.msg : ''
  const attr = isPlain(o.attr) ? o.attr : {}
  if ((msg === 'Slow query' || id === 51803) && typeof attr.ns === 'string') {
    const { op, shape } = commandShape(attr)
    return {
      kind: 'slow',
      at,
      severity,
      component,
      ns: cut(attr.ns, NAME.ns),
      op,
      shape,
      ms: num(attr.durationMillis) ?? 0,
      ...(typeof attr.planSummary === 'string' ? { plan: cut(attr.planSummary, NAME.plan) } : {}),
      ...(num(attr.keysExamined) !== undefined ? { keysExamined: num(attr.keysExamined)! } : {}),
      ...(num(attr.docsExamined) !== undefined ? { docsExamined: num(attr.docsExamined)! } : {}),
      ...(num(attr.nreturned) !== undefined ? { returned: num(attr.nreturned)! } : {}),
    }
  }
  if (id === 22943)
    return {
      kind: 'connection',
      at,
      severity,
      component,
      event: 'opened',
      client: clientOf(attr.remote),
      ...(num(attr.connectionCount) !== undefined ? { count: num(attr.connectionCount)! } : {}),
    }
  if (id === 22944)
    return { kind: 'connection', at, severity, component, event: 'ended', client: clientOf(attr.remote) }
  if (id === 51800) {
    const doc = isPlain(attr.doc) ? attr.doc : {}
    const application = isPlain(doc.application) ? doc.application : {}
    const driver = isPlain(doc.driver) ? doc.driver : {}
    const app =
      typeof application.name === 'string'
        ? application.name
        : typeof driver.name === 'string'
          ? driver.name
          : undefined
    return {
      kind: 'connection',
      at,
      severity,
      component,
      event: 'metadata',
      client: clientOf(attr.remote),
      ...(app ? { app: app.slice(0, 120) } : {}),
    }
  }
  if (id === 23403 && isPlain(attr.buildInfo) && typeof attr.buildInfo.version === 'string')
    return { kind: 'server', at, severity, component, version: cut(attr.buildInfo.version, NAME.version) }
  if (id === 4615611 && typeof attr.host === 'string')
    return { kind: 'server', at, severity, component, host: cut(attr.host, NAME.host) }
  if (severity === 'W' || severity === 'E' || severity === 'F')
    return { kind: 'message', at, severity, component, id, msg: msg.slice(0, 300) }
  return { kind: 'event', at, severity, component }
}

const LEGACY =
  /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s+([IWEFD]\d?)\s+(\S+)\s+\[([^\]]*)\]\s?(.*)$/
const stat = (rest: string, key: string) => {
  const m = new RegExp(`\\b${key}:(\\d+)`).exec(rest)
  return m ? Number(m[1]) : undefined
}
/** Quoted text, either quote. */
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
/** A number standing alone (not part of a name such as `a1`). */
const NUMBER = /(^|[^\w$.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g
/**
 * A legacy command's text with every value replaced (wave 3 review: numbers in lists and regular
 * expressions were kept): text, numbers, ObjectId(…) and the shell's other constructors, regular
 * expressions, true, false and null wherever they stand (a key is kept); a list of values is one
 * "?", lists inside lists too (wave 3 second review: `[ true, false ]` and nested lists kept theirs).
 */
// Wave 3 third review: written so that no run of spaces is tried two ways (`[` and endless spaces
// took seconds); linear in the text.
const LIST_OF_VALUES = /\[\s*(?:\?\s*(?:,\s*\?\s*)*)?\]/g
export const legacyShape = (s: string) => {
  const out = s
    .replace(QUOTED, '?')
    .replace(
      /\b(?:ObjectId|ISODate|new Date|Date|Timestamp|BinData|UUID|NumberLong|NumberInt|NumberDecimal|HexData)\([^)]*\)/g,
      '?',
    )
    .replace(/\/(?:[^/\\\s]|\\.)(?:[^/\\]|\\.)*\/[a-z]*/g, '?')
    .replace(NUMBER, '$1?')
    .replace(/(^|[^\w$.])(?:true|false|null|undefined|MinKey|MaxKey)\b(?!\s*:)/g, '$1?')
  // Only what the shape keeps is folded (wave 3 third review: a line of a megabyte was folded whole
  // a hundred times); its values are already gone, so a cut leaves none behind.
  return foldLists(out.slice(0, 4 * SHAPE_CHARS)).slice(0, SHAPE_CHARS)
}
/** Lists of values folded inside out, each pass the innermost: a list is at most so deep. */
export function foldLists(text: string): string {
  let out = text
  for (let pass = 0; pass < 100; pass++) {
    const next = out.replace(LIST_OF_VALUES, '?')
    if (next === out) break
    out = next
  }
  return out
}
/**
 * A legacy message's wording, its values left out (wave 3 review: messages differing only by a
 * number were each their own group): quoted text, addresses, hexadecimal and numbers.
 */
export const messageTemplate = (s: string) =>
  s
    .replace(QUOTED, '?')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '?')
    .replace(/\[[0-9a-fA-F:.]+\](?::\d+)?/g, '?')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '?')
    .replace(/\b[0-9a-fA-F]{8,}\b/g, '?')
    .replace(NUMBER, '$1?')
    .slice(0, 300)
/** What follows a document in a legacy line: the next `name: value`, or its end. */
const END = String.raw`(?= planSummary:| \w+: ?[\d{]|$)`
const COMMAND_BODY = new RegExp(String.raw`command: \w+ (\{.*?\})` + END)
const QUERY_BODY = new RegExp(String.raw`query: (\{.*?\})` + END)
const WRITE_BODY = new RegExp(String.raw`command: (\{.*?\})` + END)

function legacy(line: string): Line {
  const m = LEGACY.exec(line)
  if (!m) return { kind: 'unreadable' }
  const at = dateOf(m[1]!.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  const severity = m[2]!.charAt(0)
  const component = cut(m[3]!, NAME.component)
  const rest = m[5]!
  const ms = /(\d+)ms$/.exec(rest)
  const head = /^(command|query|update|remove|getmore|insert)\s+(\S+)/.exec(rest)
  if (ms && head) {
    const op = cut(/command: (\w+)/.exec(rest)?.[1] ?? head[1]!, NAME.op)
    // A command's document; a legacy query, update or remove's query (wave 3 review: their shape
    // was empty); a 3.6 write's statement.
    const body = (COMMAND_BODY.exec(rest) ?? QUERY_BODY.exec(rest) ?? WRITE_BODY.exec(rest))?.[1] ?? ''
    const found = /planSummary: (.+?)(?= \w+:\d| \w+:\{|$)/.exec(rest)?.[1]
    const plan = found === undefined ? undefined : cut(found, NAME.plan)
    return {
      kind: 'slow',
      at,
      severity,
      component,
      ns: cut(head[2]!, NAME.ns),
      op,
      shape: legacyShape(body),
      ms: Number(ms[1]),
      ...(plan ? { plan } : {}),
      ...(stat(rest, 'keysExamined') !== undefined ? { keysExamined: stat(rest, 'keysExamined')! } : {}),
      ...(stat(rest, 'docsExamined') !== undefined ? { docsExamined: stat(rest, 'docsExamined')! } : {}),
      ...(stat(rest, 'nreturned') !== undefined ? { returned: stat(rest, 'nreturned')! } : {}),
    }
  }
  if (severity === 'W' || severity === 'E' || severity === 'F')
    return { kind: 'message', at, severity, component, id: null, msg: messageTemplate(rest) }
  return { kind: 'event', at, severity, component }
}

/** One line read; what is neither form is unreadable. */
export function parseLine(line: string): Line {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'unreadable' }
  if (trimmed.startsWith('{')) {
    try {
      const o: unknown = JSON.parse(trimmed)
      return isPlain(o) && ('t' in o || 'msg' in o) ? structured(o) : { kind: 'unreadable' }
    } catch {
      return { kind: 'unreadable' }
    }
  }
  return legacy(trimmed)
}
