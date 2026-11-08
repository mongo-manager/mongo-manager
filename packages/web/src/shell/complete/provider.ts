// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { staticComplete, type CompletionContext, type CompletionResult } from './static'
import { workerItemsToResult } from './worker'

/**
 * Phase 3a-2 spec §3.1: the shell's completion — the static catalogue first; the sandboxed worker only
 * when the catalogue cannot tell (a variable chain) and no command is running.
 */
export function shellCompleter(deps: {
  context: () => CompletionContext
  worker: (code: string) => Promise<string[]>
  busy: () => boolean
}): (text: string, caret: number) => Promise<CompletionResult | null> {
  return async (text, caret) => {
    const known = staticComplete(text, caret, deps.context())
    if (known) return known
    if (deps.busy()) return null
    const before = text.slice(0, caret)
    return workerItemsToResult(before, await deps.worker(before))
  }
}
