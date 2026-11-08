// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { EventEmitter } from 'node:events'

/**
 * Review of the SEA fix 2026-10-20 (minor 5): on Node 25+ the --allow-net the worker is started with
 * says it is experimental at every start, which the server logged as the worker's stderr. That one
 * is left out; Node's own printer writes every other one, as its flags say (fourth review, minor 1
 * and 2: one of our own dropped a warning's code and detail, and threw on an odd one). Only that
 * printer is wrapped, any other listener staying as it was added (fifth review, minor 1); without
 * it (--no-warnings) nothing is written and nothing changes.
 */
export function quietFlagWarnings(proc: EventEmitter = process): void {
  const node = proc.rawListeners('warning').find((l) => l.name === 'onWarning') as
    ((warning: unknown) => void) | undefined
  if (!node) return
  proc.removeListener('warning', node)
  // In its place, first, as Node added it.
  proc.prependListener('warning', (warning: unknown) => {
    const experimental = warning instanceof Error && warning.name === 'ExperimentalWarning'
    if (experimental && /--allow-net\b/.test(warning.message)) return
    node.call(proc, warning)
  })
}
