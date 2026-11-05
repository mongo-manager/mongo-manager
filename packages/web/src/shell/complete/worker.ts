// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { isIdentifier } from '@mongo-manager/shared/browser'
import type { Completion } from '@/ds/code/completion'
import type { CompletionResult } from './static'

/**
 * Phase 3a-2 spec §3.2 (A3): the worker answers whole completed lines (mongosh's completer). Only an
 * item that continues exactly what was typed with one identifier is kept — a method or member name.
 * Anything else (another receiver, quotes, brackets, spaces: text that could come from the database)
 * is dropped, so a worker completion can never insert code.
 */
export function workerItemsToResult(before: string, items: readonly string[]): CompletionResult | null {
  const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0] ?? ''
  const from = before.length - word.length
  const prefix = before.slice(0, from)
  const seen = new Set<string>()
  const out: Completion[] = []
  for (const item of items) {
    if (!item.startsWith(prefix)) continue
    const rest = item.slice(from).replace(/\($/, '')
    if (!isIdentifier(rest) || rest === word || seen.has(rest)) continue
    seen.add(rest)
    out.push({ label: rest, kind: 'method', insert: rest })
  }
  return out.length ? { from, items: out } : null
}
