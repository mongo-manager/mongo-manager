// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { parse, type Options } from 'acorn'
import { CodeScanner, shellCommand } from '@mongo-manager/shared'

/**
 * What a script is run as, piece by piece, the way mongosh runs what is typed (user report
 * 2026-10-12: an aggregation pasted after `use shop` never ran). mongosh reads the first word of
 * what it is given as a shell command and takes the rest as its words, so each shell command (`use`,
 * `show`, `it`…) runs on its own; the JavaScript between them is cut by its parser into statements,
 * those sharing a line kept together (a line is one input to mongosh), a comment ending a line kept
 * with its statement. Review 2026-10-12 (I1): a cut by how lines start broke valid code; the parser
 * keeps together what the language keeps together.
 *
 * A command counts only where the code before it is complete (never inside a string, a template, a
 * comment or an unfinished statement). JavaScript that does not parse is one piece: mongosh then says
 * what is wrong. One pass over the lines, one parse per stretch of JavaScript (review 2026-10-12, I3).
 */
const OPTIONS: Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
}

/** The rest of a line after a statement when it holds nothing but a comment (or nothing). */
const LINE_REST = /^[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*)?(?=\n|$)/

/**
 * The statements of a stretch of JavaScript, those on one line together, each with its comments.
 * Functions it declares run first, as a script hoists them (second review 2026-10-12, minor 10: a
 * helper declared at the end was not known above it).
 */
function statements(text: string): string[] {
  if (!text.trim()) return []
  let body: Array<{ start: number; end: number; type: string }>
  try {
    body = parse(text, OPTIONS).body
  } catch {
    return [text.trim()]
  }
  const pieces: Array<{ from: number; to: number; functions: boolean }> = []
  for (const statement of body) {
    const last = pieces.at(-1)
    const declares = statement.type === 'FunctionDeclaration'
    // On the line the one before ended on: the same input.
    if (last && !text.slice(last.to, statement.start).includes('\n')) {
      last.to = statement.end
      last.functions &&= declares
    } else pieces.push({ from: last?.to ?? 0, to: statement.end, functions: declares })
    // A comment ending the line goes with its statement (second review 2026-10-12, minor 9).
    const piece = pieces.at(-1)!
    piece.to += LINE_REST.exec(text.slice(piece.to))?.[0].length ?? 0
  }
  const ordered = [...pieces.filter((p) => p.functions), ...pieces.filter((p) => !p.functions)]
  return ordered.map(({ from, to }) => text.slice(from, to).trim()).filter(Boolean)
}

/** A piece's name: its code, the comments before it left out (only comments: as it is). */
export function labelOf(piece: string): string {
  let rest = piece
  for (;;) {
    const lead = /^\s*(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest)
    if (!lead || !rest.slice(lead[0].length).trim()) break
    rest = rest.slice(lead[0].length)
  }
  return rest.trim()
}

export function splitScript(code: string): string[] {
  const out: string[] = []
  const scanner = new CodeScanner()
  let chunk: string[] = []
  const lines = code.split('\n')
  const take = (line: string, last: boolean) => {
    chunk.push(line)
    scanner.feed(last ? line : `${line}\n`)
  }
  lines.forEach((line, i) => {
    const last = i === lines.length - 1
    if (scanner.incomplete || !scanner.topLevel || !shellCommand(line)) return take(line, last)
    out.push(...statements(chunk.join('\n')))
    chunk = []
    // What follows a `;` on the command's line is no word of it (second review 2026-10-12, minor
    // 11: `use x; db.y.find()` switched to a database named "x;" and dropped the query): code of its
    // own, or a comment left out.
    const semi = line.indexOf(';')
    const after = semi === -1 ? '' : line.slice(semi + 1).trim()
    if (!after) return void out.push(line.trim())
    out.push(line.slice(0, semi).trim())
    if (!after.startsWith('//')) take(after, last)
  })
  out.push(...statements(chunk.join('\n')))
  return out
}
