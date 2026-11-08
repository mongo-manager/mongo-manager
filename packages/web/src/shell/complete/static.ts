// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  OPERATORS,
  SHELL_COMMANDS,
  SHELL_TYPES,
  SHOW_TARGETS,
  jsString,
  memberAccess,
  objectKey,
} from '@mongo-manager/shared/browser'
import type { Completion, CompletionResult } from '@/ds/code/completion'
import { maskStrings } from '@/ds/code/mask'
/**
 * Phase 3a-2 spec §3.1: completion in the browser, without asking the worker. It reads the code up to
 * the caret, follows a `db…` chain through mongosh's signatures (generated catalogue), and offers
 * collections, methods, operators, sampled field names or shell commands. Any name that comes from
 * the database is inserted through memberAccess/objectKey, so it can never become code. When it
 * cannot tell (an unknown variable, `use`), it answers null and the caller may ask the worker.
 */

export interface CompletionContext {
  collections: readonly string[]
  fields: (coll: string) => readonly string[]
}

export type { CompletionResult }

const MAX_ITEMS = 100
const ROOTS: Record<string, string> = { db: 'Database', rs: 'ReplicaSet', sh: 'Shard' }
const STRING_LITERAL = /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')$/

/** The value of a JS string literal, or null when it is not a plain one. */
function literalValue(text: string): string | null {
  const m = STRING_LITERAL.exec(text.trim())
  if (!m) return null
  const lit = m[1]!
  try {
    if (lit.startsWith('"')) return JSON.parse(lit) as string
    // A single-quoted literal read escape by escape (CodeQL 2026-11-01): \' is a quote, a " of its
    // own is escaped for JSON, every other escape is JSON's own.
    const body = lit.slice(1, -1)
    let json = ''
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!
      if (c !== '\\') json += c === '"' ? '\\"' : c
      else {
        const next = body[++i]
        if (next === undefined) return null
        json += next === "'" ? "'" : next === '"' ? '\\"' : `\\${next}`
      }
    }
    return JSON.parse(`"${json}"`) as string
  } catch {
    return null
  }
}

/** Index of the bracket that opens the one closing at `close`, or -1. */
function openingOf(text: string, close: number, open: string, shut: string): number {
  let depth = 0
  for (let k = close; k >= 0; k--) {
    if (text[k] === shut) depth++
    else if (text[k] === open && --depth === 0) return k
  }
  return -1
}

/** Index of the innermost `(` still open before `end`, or -1. */
function enclosingCall(text: string, end: number): number {
  let depth = 0
  for (let k = end - 1; k >= 0; k--) {
    if (text[k] === ')') depth++
    else if (text[k] === '(') {
      if (depth === 0) return k
      depth--
    }
  }
  return -1
}

interface Segment {
  name: string
  call: boolean
  /** The call's single string argument (for getCollection). */
  arg?: string
}

/** The member chain ending just before `end` (e.g. db, orders, find()), or null. */
function chainBefore(masked: string, source: string, end: number): Segment[] | null {
  const segments: Segment[] = []
  let i = end - 1
  for (;;) {
    if (i < 0) return null
    let call = false
    let arg: string | undefined
    if (masked[i] === ']') {
      const open = openingOf(masked, i, '[', ']')
      const name = open < 0 ? null : literalValue(source.slice(open + 1, i))
      if (name === null) return null
      segments.push({ name, call: false })
      i = open - 1
      continue
    }
    if (masked[i] === ')') {
      const open = openingOf(masked, i, '(', ')')
      if (open < 0) return null
      arg = literalValue(source.slice(open + 1, i)) ?? undefined
      call = true
      i = open - 1
    }
    let k = i
    while (k >= 0 && /[\w$]/.test(masked[k]!)) k--
    const name = masked.slice(k + 1, i + 1)
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
    segments.push({ name, call, ...(arg !== undefined ? { arg } : {}) })
    i = k
    if (i >= 0 && masked[i] === '.') {
      i--
      continue
    }
    return segments.reverse()
  }
}

/** The shell type a chain evaluates to, and the collection it names, following signatures. */
function resolve(segments: Segment[]): { type: string; coll?: string } | null {
  const root = segments[0]
  if (!root || root.call || !ROOTS[root.name]) return null
  let type = ROOTS[root.name]!
  let coll: string | undefined
  for (const seg of segments.slice(1)) {
    const member = SHELL_TYPES[type]?.[seg.name]
    if (!member && !seg.call && (type === 'Database' || type === 'Collection')) {
      // db.orders, or a sub-collection db.orders.archive.
      coll = type === 'Database' ? seg.name : `${coll}.${seg.name}`
      type = 'Collection'
      continue
    }
    if (!member || !seg.call || !member.returnType || !SHELL_TYPES[member.returnType]) return null
    if (type === 'Database' && seg.name === 'getCollection') coll = seg.arg
    type = member.returnType
  }
  return { type, ...(coll !== undefined ? { coll } : {}) }
}

/**
 * `db.<name>`, or `db.getCollection("…")` when the name is a Database member, an object built-in or
 * internal (`_…`): there `db.<name>` is not the collection (final review M6).
 */
function collectionAccess(name: string): string {
  const shadowed = name in (SHELL_TYPES.Database ?? {}) || name in Object.prototype || name.startsWith('_')
  return shadowed ? `.getCollection(${jsString(name)})` : memberAccess(name)
}

const startsWith = (label: string, prefix: string) => label.toLowerCase().startsWith(prefix.toLowerCase())

function memberItems(type: string, partial: string, ctx: CompletionContext): Completion[] {
  const items: Completion[] = []
  if (type === 'Database') {
    const collections = [...ctx.collections].sort((a, b) => a.localeCompare(b))
    for (const c of collections)
      if (startsWith(c, partial)) items.push({ label: c, kind: 'collection', insert: collectionAccess(c) })
  }
  const members = Object.entries(SHELL_TYPES[type] ?? {})
    .filter(([name]) => startsWith(name, partial))
    .sort(([a, ma], [b, mb]) => Number(!!ma.deprecated) - Number(!!mb.deprecated) || a.localeCompare(b))
  for (const [name] of members) items.push({ label: name, kind: 'method', insert: `.${name}` })
  return items.slice(0, MAX_ITEMS)
}

function operatorItems(word: string, inPipeline: boolean): Completion[] {
  const order = inPipeline
    ? [OPERATORS.stage, OPERATORS.expression, OPERATORS.query, OPERATORS.conversion]
    : [OPERATORS.query, OPERATORS.expression, OPERATORS.stage, OPERATORS.conversion]
  const seen = new Set<string>()
  const items: Completion[] = []
  for (const list of order)
    for (const op of list)
      if (!seen.has(op) && startsWith(op, word)) {
        seen.add(op)
        items.push({ label: op, kind: 'operator', insert: op })
      }
  return items.slice(0, MAX_ITEMS)
}

/** The method name of the call around `end`, and the collection its receiver names. */
function callAround(masked: string, source: string, end: number): { method: string; coll?: string } | null {
  const open = enclosingCall(masked, end)
  if (open < 0) return null
  const chain = chainBefore(masked, source, open)
  if (!chain || chain.length < 2) return null
  const method = chain.at(-1)!.name
  const receiver = resolve(chain.slice(0, -1))
  return { method, ...(receiver?.type === 'Collection' && receiver.coll ? { coll: receiver.coll } : {}) }
}

function previousNonSpace(text: string, from: number): string | undefined {
  let k = from - 1
  while (k >= 0 && /\s/.test(text[k]!)) k--
  return text[k]
}

export function staticComplete(text: string, caret: number, ctx: CompletionContext): CompletionResult | null {
  const source = text.slice(0, caret)
  const { text: masked, open } = maskStrings(source)
  if (open) return null // inside a string or a comment

  // Shell commands at the start of a line.
  const line = masked.slice(masked.lastIndexOf('\n') + 1)
  if (/^\s*use\s/.test(line)) return null
  const show = /^\s*show\s+([A-Za-z]*)$/.exec(line)
  if (show) {
    const word = show[1]!
    const items = SHOW_TARGETS.filter((t) => startsWith(t, word)).map((t): Completion => ({
      label: t,
      kind: 'command',
      insert: t,
    }))
    return { from: caret - word.length, items }
  }
  const bare = /^\s*([A-Za-z]+)$/.exec(line)
  if (bare) {
    const word = bare[1]!
    const items = SHELL_COMMANDS.filter((c) => startsWith(c, word) && c !== word).map((c): Completion => ({
      label: c,
      kind: 'command',
      insert: c,
    }))
    if (items.length) return { from: caret - word.length, items }
  }

  // Operators: $… in an object or a pipeline.
  const op = /\$[\w$]*$/.exec(masked)
  if (op && masked[op.index - 1] !== '.') {
    const call = callAround(masked, source, op.index)
    return { from: op.index, items: operatorItems(op[0], call?.method === 'aggregate') }
  }

  // Members: <chain>.<partial>
  const member = /\.([A-Za-z_$][\w$]*)?$/.exec(masked)
  if (member) {
    const dot = member.index
    const chain = chainBefore(masked, source, dot)
    const resolved = chain && resolve(chain)
    if (!resolved) return null
    return { from: dot, items: memberItems(resolved.type, member[1] ?? '', ctx) }
  }

  // Field names in a key position inside a call on a collection.
  const word = /[A-Za-z_$][\w$.]*$/.exec(masked)
  if (word && /[{,]/.test(previousNonSpace(masked, word.index) ?? '')) {
    const call = callAround(masked, source, word.index)
    if (!call?.coll) return null
    const items = ctx
      .fields(call.coll)
      .filter((f) => startsWith(f, word[0]))
      .slice(0, MAX_ITEMS)
      .map((f): Completion => ({ label: f, kind: 'field', insert: objectKey(f) }))
    return { from: word.index, items }
  }
  return null
}
